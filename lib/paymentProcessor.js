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
          const minLevel = config.payments.minPayment;
          const maxLevel = config.payments.maxPayment;
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
      let payments = {};

      for (let worker in balances) {
        let balance = balances[worker];
        if (balance >= minPayoutLevel[worker]) {
          let remainder = balance % config.payments.denomination;
          let payout = balance - remainder;

          if (config.payments.dynamicTransferFee && config.payments.minerPayFee) {
            payout -= config.payments.transferFee;
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

      let transferCommands = [];
      let addresses = 0;
      let commandAmount = 0;
      let commandIndex = 0;
      let ringSize = config.payments.ringSize ? config.payments.ringSize : config.payments.mixin;

      for (let worker in payments) {
        let amount = parseInt(payments[worker]);
        if (config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
          amount = config.payments.maxTransactionAmount - commandAmount;
        }

        let address = worker;
        let payment_id = null;

        let with_payment_id = false;

        let addr = address.split(config.poolServer.paymentId.addressSeparator);
        if ((addr.length === 1 && utils.isIntegratedAddress(address)) || addr.length >= 2) {
          with_payment_id = true;
          if (addr.length >= 2) {
            address = addr[0];
            payment_id = addr[1];
            payment_id = payment_id.replace(/[^A-Za-z0-9]/g, '');
            if (payment_id.length !== 16 && payment_id.length !== 64) {
              with_payment_id = false;
              payment_id = null;
            }
          }
          if (addresses > 0) {
            commandIndex++;
            addresses = 0;
            commandAmount = 0;
          }
        }

        if (config.poolServer.fixedDiff && config.poolServer.fixedDiff.enabled) {
          addr = address.split(config.poolServer.fixedDiff.addressSeparator);
          if (addr.length >= 2) address = addr[0];
        }

        if (!transferCommands[commandIndex]) {
          transferCommands[commandIndex] = {
            redis: [],
            amount: 0,
            rpc: {
              destinations: [],
              fee: config.payments.transferFee,
              priority: config.payments.priority,
              unlock_time: 0
            }
          };
          if (config.payments.ringSize)
            transferCommands[commandIndex].rpc.ring_size = ringSize;
          else
            transferCommands[commandIndex].rpc.mixin = ringSize;
        }

        transferCommands[commandIndex].rpc.destinations.push({
          amount: amount,
          address: address
        });
        if (payment_id) transferCommands[commandIndex].rpc.payment_id = payment_id;

        transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
        if (config.payments.dynamicTransferFee && config.payments.minerPayFee) {
          transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -config.payments.transferFee]);
        }
        transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
        transferCommands[commandIndex].amount += amount;

        addresses++;
        commandAmount += amount;

        if (config.payments.dynamicTransferFee) {
          transferCommands[commandIndex].rpc.fee = config.payments.transferFee * addresses;
        }

        if (addresses >= config.payments.maxAddresses || (config.payments.maxTransactionAmount && commandAmount >= config.payments.maxTransactionAmount) || with_payment_id) {
          commandIndex++;
          addresses = 0;
          commandAmount = 0;
        }
      }

      async.filter(transferCommands, function (transferCmd, cback) {
        const multi = redisClient.multi();

        transferCmd.redis.forEach((cmd) => {
          multi.addCommand(cmd);
        });

        multi.exec(function (error, replies) {
          if (error) {
            log('error', logSystem, 'Error executing Redis commands for transfer: %j', [error]);
            cback(false);
            return;
          }

          log('info', logSystem, 'Transfer commands executed successfully');
          cback(true);
        });
      }, function (succeeded) {
        if (!succeeded) {
          log('error', logSystem, 'Some transfers failed to process');
        }

        callback(null);
      });
    }

  ], function (error, result) {
    setTimeout(runInterval, config.payments.interval * 1000);
  });
}

runInterval();
