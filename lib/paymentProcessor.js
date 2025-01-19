/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Payments processor
 **/

// Load required modules
let fs = require('fs');
let async = require('async');

let notifications = require('./notifications.js');
let utils = require('./utils.js');

// Initialize log system
let logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);

(async () => {
  await redisClient.connect();
})();

(async () => {
  try {
    await rpcClient.connect();
    log('info', logSystem, `Listening for events...`);
  } catch (error) {
    console.error("Error connecting to the node:", error);
  }
})();

/**
 * Run payments processor
 **/

log('info', logSystem, 'Started');

if (!config.poolServer.paymentId) config.poolServer.paymentId = {};
if (!config.poolServer.paymentId.addressSeparator) config.poolServer.paymentId.addressSeparator = "+";
if (!config.payments.priority) config.payments.priority = 0;

function runInterval() {
  async.waterfall([
    // Get worker keys
    function (callback) {
      redisClient.keys(config.coin + ':workers:*')
      .then((result) => {
        callback(null, result);
      })
      .catch((error) => {
        log('error', logSystem, 'Error trying to get worker balances from redis %j', [error.message || error]);
        callback(true);
        return;
      });
    },

    // Get worker balances
    function (keys, callback) {
      const multi = redisClient.multi();

      keys.forEach((key) => {
        multi.hGet(key, 'balance');
      });

      multi.exec()
        .then((replies) => {
          const balances = {};
          keys.forEach((key, index) => {
            const workerId = key.split('workers:').pop();
            balances[workerId] = parseInt(replies[index], 10) || 0;
          });

          callback(null, keys, balances);
        })
        .catch((error) => {
          log('error', logSystem, 'Error with getting balances from redis %j', [error.message || error]);
          callback(true);
        });

    },


    // Get worker minimum payout
    function (keys, balances, callback) {
      const multi = redisClient.multi();

      keys.forEach((key) => {
        multi.hGet(key, 'minPayoutLevel');
      });

      multi.exec()
        .then((replies) => {
          const minPayoutLevel = {};
          keys.forEach((key, index) => {
            let workerId = key.split('workers:').pop();

            const minLevel = amountToSompi(config.payments.minPayment.toString());
            const maxLevel = amountToSompi(config.payments.maxPayment.toString());
            const defaultLevel = minLevel;

            let payoutLevel = BigInt(replies[index] || minLevel);
            if (payoutLevel < minLevel) payoutLevel = minLevel;
            if (maxLevel && payoutLevel > maxLevel) payoutLevel = maxLevel;
            minPayoutLevel[workerId] = payoutLevel;

            if (payoutLevel !== defaultLevel) {
              log(
                'info',
                logSystem,
                'Using payout level of %s for %s (default: %s)',
                [
                  utils.getReadableCoins(minPayoutLevel[workerId]),
                  workerId,
                  utils.getReadableCoins(defaultLevel),
                ]
              );
            }
          });

          callback(null, balances, minPayoutLevel);
        })
        .catch((error) => {
          log('error', logSystem, 'Error with getting minimum payout from redis %j', [error.message || error]);
          callback(true);
        });

    },

    // Filter workers under balance threshold for payment
    function (balances, minPayoutLevel, callback) {
      const payments = {};

      for (const worker in balances) {
        const balance = BigInt(balances[worker]);
        if (balance >= minPayoutLevel[worker]) {
          const remainder = balance % BigInt(amountToSompi(config.payments.denomination.toString()));
          let payout = balance - remainder;
    
          if (config.payments.dynamicTransferFee && config.payments.minerPayFee) {
            payout -= amountToSompi(config.payments.transferFee.toString());
          }
          if (payout < 0) continue;
    
          payments[worker] = payout;
        }
      }
    
      if (Object.keys(payments).length === 0) {
        log('info', logSystem, 'No workers\' balances reached the minimum payment threshold');
        callback(true);
        return;
      }

      const notify_miners = [];
    
      const processPayments = async () => {
        let generator;
        const sourceAddress = privateKey.toKeypair().toAddress(config.networkId);
    
        try {
          const entries = await rpcClient.getUtxosByAddresses([sourceAddress]);
          if (!entries || !entries.entries || !entries.entries.length) {
            log('error', logSystem, 'No UTXOs found for source address');
            callback(true);
            return;
          }
    
          const utxos = entries.entries.sort((a, b) => {
            a.amount > b.amount ? 1 : -1
          });
    
          await Object.keys(payments).map((async (worker) => {
            let address = worker;
            let amount = payments[worker];

            generator = new coinSDK.Generator({
              entries: utxos,
              outputs: [{address, amount}],
              priorityFee: 0,
              changeAddress: sourceAddress,
              networkId: config.networkId
            });
      
            let pending;
            while ((pending = await generator.next())) {
              await pending.sign([privateKey]);

              try {
                const txid = await pending.submit(rpcClient);  
                redisClient.hSet(`${config.coin}:workers:${address}`, 'balance', (BigInt(balances[worker]) - amount).toString(10))
                  .then(() => {
                    log('info', logSystem, `Decremented balance by ${amount} for worker ${address}`);
                  })
                  .catch((error) => {
                    log('error', logSystem, `Failed to decrement balance for worker ${address}: %j`, [error]);
                  });
  
                log('info', logSystem, 'Payment of %s to %s', [utils.getReadableCoins(amount), address]);
  
                notifications.sendToMiner(address, 'payment', {
                  'ADDRESS': address.substring(0, 7) + '...' + address.substring(address.length - 7),
                  'AMOUNT': utils.getReadableCoins(amount),
                  'TXID': txid
                });
              } catch(e) {
                log('error', logSystem, "Error submitting transaction: %s", [e.message || e]);
              }
            }
          }));
    
          log('info', logSystem, 'Payment distribution completed');
          callback(null);
        } catch (error) {
          log('error', logSystem, `Error processing payments: ${error.message || error}`);
          callback(true);
        } finally {
          if (generator) {
            log('info', logSystem, `Summary: ${JSONbig.stringify(generator.summary())}`);
          }
          callback(null);
        }
      };
    
      processPayments();
    }, 
  ], function (error, result) {
    setTimeout(runInterval, config.payments.interval * 1000);
  });
}

runInterval();
