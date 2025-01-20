/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Block unlocker
 **/

// Load required modules
let async = require('async');

let notifications = require('./notifications.js');
let utils = require('./utils.js');

let slushMiningEnabled = config.poolServer.slushMining && config.poolServer.slushMining.enabled;

// Initialize log system
let logSystem = 'unlocker';
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
 * Run block unlocker
 **/

log('info', logSystem, 'Started');

function runInterval () {
	async.waterfall([
		// Get all block candidates in redis
		function (callback) {
      redisClient
        .zRangeWithScores(config.coin + ':blocks:candidates', 0, -1)
        .then((results) => {
          if (results.length === 0) {
            log('info', logSystem, 'No block candidates in redis');
            callback(null, []);
            return;
          }
    
          const blocks = [];
          for (let i = 0; i < results.length; i ++) {
            const parts = results[i].value.split('||');
            const score = BigInt(results[i].score);
            
            blocks.push({
              serialized: results[i],
              height: score,
              rewardType: parts[0],
              login: parts[1],
              hash: parts[2],
              time: parts[3],
              difficulty: parts[4],
              shares: parts[5],
              score: (parts.length >= 7 ? parts[6] : parts[5]).toString()
            });
          }
          callback(null, blocks);
        })
        .catch((error) => {
          log('error', logSystem, 'Error retrieving block candidates: %j', [error.message || error]);
          callback(null, []);
        });
		},

		// Check if blocks are orphaned
    function (blocks, callback) {
      async.filter(blocks, function (block, mapCback) {    
        // Call rpcClient.getBlock() using the block hash
        rpcClient.getBlock({ hash: block.hash, includeTransactions: true })
          .then((result) => {
            if (!result || !result.block.header) {
              log('warn', logSystem, `Invalid or missing block data for hash: ${block.hash}`);
              block.orphaned = true;
              block.unlocked = false;
              mapCback();
              return;
            }
    
            redisClient
              .get(`${config.coin}:daaScore`)
              .then((daaScore) => {
                let blockHeader = result.block.header;

                const depth = BigInt(daaScore) - blockHeader.daaScore;
                block.unlocked = depth >= BigInt(config.blockUnlocker.depth);

                for (const tx_base of result.block.transactions) {
                  const tx = new coinSDK.Transaction(tx_base);

                  if (!tx.is_coinbase()) continue;
                  block.reward = tx_base.outputs[0].value;

                  break;
                }
        
                // Network fee handling if applicable
                if (config.blockUnlocker.networkFee) {
                  const networkFeePercent = config.blockUnlocker.networkFee / 100.0;
                  const scale = 1_000_000_000;
                  const scaledFeePercent = Math.round(networkFeePercent * scale);
                  
                  block.reward = block.reward - (block.reward * BigInt(scaledFeePercent) / BigInt(scale));
                }
        
                mapCback(block.unlocked);
              }).catch((error) => {
                log('error', logSystem, 'Error calculating reward for block %s - %j', [block.hash, error.message || error]);
                mapCback();
              });
          })
          .catch((error) => {
            log('error', logSystem, 'Error fetching block %s - %j', [block.hash, error.message || error]);
            block.unlocked = false;
            mapCback();
          });
      }, function (unlockedBlocks) {
        if (unlockedBlocks.length === 0) {
          log('info', logSystem, 'No pending blocks are unlocked yet (%d pending)', [blocks.length]);
          callback(true);
        }
        callback(null, unlockedBlocks);
      });
    },

		// Get worker shares for each unlocked block
		function (blocks, callback) {
      const multi = redisClient.multi();

      for (const block of blocks) {
        if (block.rewardType === 'prop') {
          multi.hGetAll(`${config.coin}:scores:prop:round${block.height.toString(10)}`);
        } else {
          multi.hGetAll(`${config.coin}:scores:solo:round${block.height.toString(10)}`);
        }
      }
    
      multi.exec()
        .then((replies) => {
          replies.forEach((workerScores, i) => {
            blocks[i].workerScores = {...workerScores};
          });
          callback(null, blocks);
        })
        .catch((error) => {
          log('error', logSystem, 'Error with getting round shares from redis %j', [error.message || error]);
          callback(true);
          return;
        });
		},

		// Handle orphaned blocks
		function (blocks, callback) {
      const multi = redisClient.multi();

      for (const block of blocks) {
        if (!block.orphaned) {
          continue;
        }
    
        multi.del(`${config.coin}:scores:solo:round${block.height.toString(10)}`);
        multi.del(`${config.coin}:scores:prop:round${block.height.toString(10)}`);
        multi.del(`${config.coin}:shares_actual:solo:round${block.height.toString(10)}`);
        multi.del(`${config.coin}:shares_actual:prop:round${block.height.toString(10)}`);
        multi.zRem(`${config.coin}:blocks:candidates`, block.serialized.value);
        multi.zAdd(`${config.coin}:blocks:matured`, {
          score: block.height,
          value: [
            block.rewardType,
            block.login,
            block.hash,
            block.time,
            block.difficulty,
            block.shares,
            block.orphaned
          ].join('||')
        });
    
        if (block.workerScores && !slushMiningEnabled) {
          Object.keys(block.workerScores).forEach((worker) => {
            multi.hIncrBy(
              `${config.coin}:scores:roundCurrent`,
              worker,
              block.workerScores[worker]
            );
          });
        }
    
        notifications.sendToAll('blockOrphaned', {
          HEIGHT: block.height,
          BLOCKTIME: utils.dateFormat(new Date(parseInt(block.time) * 1000), 'yyyy-mm-dd HH:MM:ss Z'),
          HASH: block.hash,
          DIFFICULTY: block.difficulty,
          SHARES: block.shares,
          EFFORT: Math.round((block.shares / block.difficulty) * 100) + '%'
        });
      }
    
      multi.exec()
        .then((replies) => {
          if (replies.length === 0) {
            callback(null, blocks);
            return;
          }
          log('info', logSystem, 'Orphaned block data cleaned up successfully');
        })
        .catch((error) => {
          log('error', logSystem, 'Error cleaning up orphaned block data in Redis: %j', [error.message || error]);
          callback(true);
        });

      callback(null, blocks);
    },

		// Handle unlocked blocks
		function (blocks, callback) {
      const multi = redisClient.multi();
      const payments = {};
      let totalBlocksUnlocked = 0;
    
      for (const block of blocks) {
        if (block.orphaned) {
          return;
        }
        totalBlocksUnlocked++;
    
        multi.del(`${config.coin}:scores:solo:round${block.height.toString(10)}`);
        multi.del(`${config.coin}:scores:prop:round${block.height.toString(10)}`);
        multi.del(`${config.coin}:shares_actual:solo:round${block.height.toString(10)}`);
        multi.del(`${config.coin}:shares_actual:prop:round${block.height.toString(10)}`);
        multi.zRem(`${config.coin}:blocks:candidates`, block.serialized.value);
        multi.zAdd(`${config.coin}:blocks:matured`, {
          score: block.height,
          value: [
            block.rewardType,
            block.login,
            block.hash,
            block.time,
            block.difficulty,
            block.shares,
            block.score,
            block.orphaned ? 'orphaned' : 'accepted',
            block.reward.toString(10)
          ].join('||')
        });

        const SCALE = 1_000_000;
        const bigScale = BigInt(SCALE);
    
        let feePercent = (config.blockUnlocker.poolFee > 0 ? config.blockUnlocker.poolFee : 0) / 100;
        if (block.rewardType === 'solo') {
          feePercent = (config.blockUnlocker.soloFee >= 0 ? config.blockUnlocker.soloFee : (config.blockUnlocker.poolFee > 0 ? config.blockUnlocker.poolFee : 0)) / 100;
        }
        if (Object.keys(donations).length) {
          const scaledReward = block.reward * BigInt(SCALE);
          for (const wallet in donations) {
            const scaledDonationPercent = BigInt(Math.round(donations[wallet] * SCALE));
            const donation = ((scaledReward * scaledDonationPercent) / (bigScale * bigScale)) / 100n;
            payments[wallet] = (payments[wallet] || 0n) + donation;
            const donationPercentDecimal = Number(scaledDonationPercent) / Number(SCALE);
            log('info', logSystem, 'Block %s donation to %s as %s%% of reward: %s', [
              block.height.toString(10),
              wallet,
              donationPercentDecimal,
              utils.getReadableCoins(donation)
            ]);
          }
        }
    
        let reward = 0;
        let finderReward = 0;
        let poolReward = 0;
        if (block.rewardType === 'solo') {
          reward = Math.round(block.reward - (block.reward * feePercent));
          log('info', logSystem, 'Unlocked SOLO block %d with reward %d and donation fee %d. Miners reward: %d', [
            block.height.toString(10), 
            utils.getReadableCoins(block.reward), 
            feePercent * 100, 
            utils.getReadableCoins(reward)
          ]);
        } else {
          const scaledReward = block.reward * bigScale;
          const finderScaledPercent = BigInt(Math.round(config.blockUnlocker.finderReward * SCALE));
          const feeScaledPercent = BigInt(Math.round(feePercent * SCALE) * 100);

          finderReward = ((scaledReward * finderScaledPercent) / (bigScale * bigScale)) / 100n;
          poolReward = ((scaledReward * feeScaledPercent) / (bigScale * bigScale)) / 100n;
          reward = block.reward - finderReward - poolReward;

          log('info', logSystem, 'Unlocked PROP block %s with reward %s, finders fee %d%, and donation fee %s%. Shared reward: %s. Finders Reward: %s. Pool fee: %s', [
            block.height.toString(10), 
            utils.getReadableCoins(block.reward), 
            config.blockUnlocker.finderReward, 
            feePercent * 100, 
            utils.getReadableCoins(reward), 
            utils.getReadableCoins(finderReward),
            utils.getReadableCoins(poolReward)
          ]);
        }
    
        if (block.workerScores) {
          const totalScore = parseFloat(block.score);
    
          if (block.rewardType === 'solo') {
            const worker = block.login;
            payments[worker] = (payments[worker] || 0) + reward;
            log('info', logSystem, 'SOLO Block %d payment to %s for %d%% of total block score: %d', [block.height, worker, 100, payments[worker]]);
          } else {
            Object.keys(block.workerScores).forEach((worker) => {
              const scaledWorkerPercent = BigInt(Math.round((parseFloat(block.workerScores[worker])/totalScore)*SCALE));
              const workerReward = ((reward) * scaledWorkerPercent) / bigScale;
              payments[worker] = block.login === worker 
                ? (payments[worker] || 0n) + (workerReward + finderReward) 
                : (payments[worker] || 0n) + workerReward;
              log('info', logSystem, 'PROP Block %s payment to %s for %s% of total block score: %s', [
                block.height.toString(10),
                worker,
                (parseFloat(block.workerScores[worker])/totalScore)*100.0,
                utils.getReadableCoins(payments[worker])
              ]);
            });
          }
        }
    
        notifications.sendToAll('blockUnlocked', {
          HEIGHT: block.height,
          BLOCKTIME: utils.dateFormat(new Date(parseInt(block.time) * 1000), 'yyyy-mm-dd HH:MM:ss Z'),
          HASH: block.hash,
          REWARD: utils.getReadableCoins(block.reward),
          DIFFICULTY: block.difficulty,
          SHARES: block.shares,
          EFFORT: Math.round((block.shares / block.difficulty) * 100) + '%'
        });
      }
    
      for (const worker in payments) {
        const amount = BigInt(payments[worker] || 0n);
        if (amount <= 0n) {
          delete payments[worker];
          continue;
        }
      
        redisClient.hGet(`${config.coin}:workers:${worker}`, 'balance')
          .then((currentBalance) => {
            const currentBalanceBigInt = BigInt(currentBalance || 0n);
            const newBalance = currentBalanceBigInt + amount;
      
            return redisClient.hSet(`${config.coin}:workers:${worker}`, 'balance', newBalance.toString(10));
          })
          .catch((error) => {
            log('error', logSystem, `Error updating balance for worker ${worker}: ${error.message || error}`);
          });
      }
    
      multi.exec()
        .then((replies) => {
          if (!replies || replies.length === 0) {
            callback(true);
            return;
          }

          log('info', logSystem, 'Unlocked %d blocks and updated Redis successfully', [totalBlocksUnlocked]);
          callback(null);
        })
        .catch((error) => {
          log('error', logSystem, 'Error unlocking blocks in Redis: %j', [error.message || error]);

          // Detailed error logging
          if (error.replies && error.errorIndexes) {
            log('error', logSystem, `Pipeline replies: ${JSON.stringify(error.replies, null, 2)}`);
            log('error', logSystem, `Failed command indices: ${JSON.stringify(error.errorIndexes, null, 2)}`);
          }
          callback(true);
        });
		}
	], 
  function (error, result) {
		setTimeout(runInterval, config.blockUnlocker.interval * 1000);
	})
}

runInterval();
