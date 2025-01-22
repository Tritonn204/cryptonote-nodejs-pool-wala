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

async function estimateWithRetry(generator, maxRetries = 5, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const estimation = await generator.estimate();
      log('info', logSystem, `Transaction estimation successful on attempt ${attempt}`);
      return estimation;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
      log('warn', logSystem, `Attempt ${attempt} failed. Error: ${error.message || error}. Retrying in ${delayMs/1000} seconds...`);
      
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

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

            const minLevel = amountToSompi(config.payments.minPayment.toString(10));
            const maxLevel = amountToSompi(config.payments.maxPayment.toString(10));
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
          let entries = await rpcClient.getUtxosByAddresses([sourceAddress]);
          if (!entries || !entries.entries || !entries.entries.length) {
            log('error', logSystem, 'No UTXOs found for source address');
            callback(true);
            return;
          }

          let txArray = [];
          let totalAmount = 0n;

          let dests = [];
    
          await Object.keys(payments).map((async (worker) => {
            dests.push({
              address: worker,
              amount: payments[worker],
            });
          }));

          entries = await rpcClient.getUtxosByAddresses([sourceAddress]);

          let utxos = entries.entries.sort((a, b) => {
            a.amount > b.amount ? 1 : -1
          });

          generator = new coinSDK.Generator({
            entries: utxos,
            outputs: dests,
            changeAddress: sourceAddress,
            networkId: config.networkId,
            priorityFee: 0n
          });

          await estimateWithRetry(generator);

          while ((pending = await generator.next())) {
            await pending.sign([privateKey]);
            await pending.submit(rpcClient)
              .then((txid) => {
                txArray.push(txid);
              })
              .catch ((error) => {
                log('error', logSystem, `Error submitting tx: ${JSONbig.stringify(pending)} : ${error.message || error}`);
              });
          }

          log('info', logSystem, `Generator Summary: ${JSONbig.stringify(generator.summary())}`);

          let multi = redisClient.multi();
          for (output of dests) {
            let now = Date.now() / 1000 | 0;
            totalAmount += output.amount;
            let prefixSize = output.address.indexOf(':');

            multi.hSet(`${config.coin}:workers:${output.address}`, 'balance', (BigInt(balances[output.address]) - output.amount).toString(10))
            multi.zAdd(`${config.coin}:payments:${output.address}`, {
              score: now, 
              value: [
                "N/A",
                output.amount.toString(10),
                0,
              ].join('||')
            });

            notifications.sendToMiner(output.address, 'payment', {
              'ADDRESS': output.address.substring(0, 7 + prefixSize) + '...' + output.address.substring(output.address.length - 7),
              'AMOUNT': utils.getReadableCoins(output.amount),
            });
          }

          await multi.exec();

          let now = Date.now() / 1000 | 0;
          redisClient.zAdd(`${config.coin}:payments:all`, {
            score: now, 
            value: [
              txArray.join('|'),
              totalAmount.toString(10),
              0,
              dests.length
            ].join('||')
          });
    
          log('info', logSystem, 'Payment distribution completed');
          callback(null);

        } catch (error) {
          log('error', logSystem, `Error processing payments: ${error.message || error}`);
          callback(true);
        }
      };    
      processPayments();
    }, 
  ], function (error, result) {
    setTimeout(runInterval, config.payments.interval * 1000);
  });
}

runInterval();
