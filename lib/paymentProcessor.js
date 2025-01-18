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
      redisClient.keys(config.coin + ':workers:*', function (error, result) {
        if (error) {
          log('error', logSystem, 'Error trying to get worker balances from redis %j', [error]);
          callback(true);
          return;
        }
        callback(null, result);
      });
    },

    // Get worker balances
    function (keys, callback) {
      const multi = redisClient.multi();

      keys.forEach((key) => {
        multi.hGet(key, 'balance');
      });

      multi.exec(function (error, replies) {
        if (error) {
          log('error', logSystem, 'Error with getting balances from redis %j', [error]);
          callback(true);
          return;
        }

        const balances = {};
        keys.forEach((key, index) => {
          const workerId = key.split(':').pop();
          balances[workerId] = parseInt(replies[index], 10) || 0;
        });

        callback(null, keys, balances);
      });
    },


    // Get worker minimum payout
    function (keys, balances, callback) {
      const multi = redisClient.multi();

      keys.forEach((key) => {
        multi.hGet(key, 'minPayoutLevel');
      });

      multi.exec(function (error, replies) {
        if (error) {
          log('error', logSystem, 'Error with getting minimum payout from redis %j', [error]);
          callback(true);
          return;
        }

        const minPayoutLevel = {};
        keys.forEach((key, index) => {
          const workerId = key.split(':').pop();
          const minLevel = amountToSompi(config.payments.minPayment);
          const maxLevel = amountToSompi(config.payments.maxPayment);
          const defaultLevel = minLevel;

          let payoutLevel = parseInt(replies[index], 10) || minLevel;
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
      });
    },

    // Filter workers under balance threshold for payment
    function (balances, minPayoutLevel, callback) {
      const payments = {};

      for (const worker in balances) {
        const balance = balances[worker];
        if (balance >= minPayoutLevel[worker]) {
          const remainder = balance % config.payments.denomination;
          let payout = balance - remainder;
    
          if (config.payments.dynamicTransferFee && config.payments.minerPayFee) {
            payout -= amountToSompi(config.payments.transferFee);
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
    
      const processPayments = async () => {
        let generator;
        const privateKey = new PrivateKey(process.env.PRIVATE_KEY);
        const sourceAddress = privateKey.toKeypair().toAddress(config.networkId);
    
        try {
          const entries = await rpcClient.getUtxosByAddresses([sourceAddress]);
          if (!entries || !entries.entries.length) {
            log('error', logSystem, 'No UTXOs found for source address');
            callback(true);
            return;
          }
    
          const utxos = entries.entries.sort((a, b) => a.amount - b.amount);
    
          const outputs = Object.keys(payments).map(worker => ({
            address: worker,
            amount: payments[worker]
          }));
    
          generator = new Generator({
            entries: utxos,
            outputs,
            priorityFee: amountToSompi(config.payments.priorityFee),
            changeAddress: sourceAddress
          });
    
          let pending;
          while ((pending = await generator.next())) {
            await pending.sign([privateKey]);
            const txid = await pending.submit(rpcClient);
            log('info', logSystem, `Transaction submitted successfully: ${txid}`);
          }
    
          log('info', logSystem, 'Payment distribution completed');
          callback(null);
        } catch (error) {
          log('error', logSystem, `Error processing payments: ${error.message}`);
          callback(true);
        } finally {
          if (generator) {
            log('info', logSystem, `Summary: ${JSON.stringify(generator.summary())}`);
          }
        }
      };
    
      processPayments();
    }

  ], function (error, result) {
    setTimeout(runInterval, config.payments.interval * 1000);
  });
}

runInterval();
