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

/**
 * Run block unlocker
 **/

log('info', logSystem, 'Started');

function runInterval () {
	async.waterfall([
		// Get all block candidates in redis
		function (callback) {
      redisClient
      .zRange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES')
      .then((results) => {
        if (results.length === 0) {
          log('info', logSystem, 'No block candidates in redis');
          callback(null, []);
          return;
        }
  
        const blocks = [];
        for (let i = 0; i < results.length; i += 2) {
          const parts = results[i].split(':');
          blocks.push({
            serialized: results[i],
            height: parseInt(results[i + 1]),
            rewardType: parts[0],
            login: parts[1],
            hash: parts[2],
            time: parts[3],
            difficulty: parts[4],
            shares: parts[5],
            score: parts.length >= 7 ? parts[6] : parts[5]
          });
        }
        callback(null, blocks);
      })
      .catch((error) => {
        log('error', logSystem, 'Error retrieving block candidates: %j', [error]);
        callback(null, []);
      });
		},

		// Check if blocks are orphaned
    function (blocks, callback) {
      async.filter(blocks, function (block, mapCback) {    
        // Call rpcClient.getBlock() using the block hash
        rpcClient.getBlock({ hash: block.hash })
          .then(result => {
            if (!result || !result.header) {
              log('error', logSystem, 'Error with getBlock RPC request for block %s - %j', [block.hash, result]);
              block.orphaned = true;
              block.unlocked = false;
              mapCback();

              return;
            }
    
            redisClient
              .get(`${config.coin}:daaScore`)
              .then((daaScore) => {
                let blockHeader = result.blockHeader;

                const depth = BigInt(daaScore) - blockHeader.daaScore;
                block.unlocked = depth >= config.blockUnlocker.depth;

                for (const tx_base in result.transactions) {
                  const tx = new coinSDK.Transaction(tx_base);

                  if (!tx.is_coinbase()) continue;
                  block.reward = tx.outputs[0].value;
                  break;
                }
        
                // Network fee handling if applicable
                if (config.blockUnlocker.networkFee) {
                  let networkFeePercent = config.blockUnlocker.networkFee / 100;
                  block.reward = block.reward - (block.reward * networkFeePercent);
                }
        
                mapCback(block.unlocked);
              });
          })
          .catch(error => {
            log('error', logSystem, 'Error fetching block %s - %j', [block.hash, error]);
            block.unlocked = false;
            mapCback();
          });
      }, function (unlockedBlocks) {
        if (unlockedBlocks.length === 0) {
          log('info', logSystem, 'No pending blocks are unlocked yet (%d pending)', [blocks.length]);
          callback(true);
          return;
        }
        callback(null, unlockedBlocks);
      });
    },

		// Get worker shares for each unlocked block
		function (blocks, callback) {
      const multi = redisClient.multi();

      blocks.forEach((block) => {
        if (block.rewardType === 'prop') {
          multi.hGetAll(`${config.coin}:scores:prop:round${block.height}`);
        } else {
          multi.hGetAll(`${config.coin}:scores:solo:round${block.height}`);
        }
      });
    
      multi.exec((error, replies) => {
        if (error) {
          log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
          callback(true);
          return;
        }
    
        replies.forEach((workerScores, i) => {
          blocks[i].workerScores = workerScores;
        });
    
        callback(null, blocks);
      });
		},

		// Handle orphaned blocks
		function (blocks, callback) {
      const multi = redisClient.multi();

      blocks.forEach((block) => {
        if (!block.orphaned) {
          return;
        }
    
        multi.del(`${config.coin}:scores:solo:round${block.height}`);
        multi.del(`${config.coin}:scores:prop:round${block.height}`);
        multi.del(`${config.coin}:shares_actual:solo:round${block.height}`);
        multi.del(`${config.coin}:shares_actual:prop:round${block.height}`);
        multi.zRem(`${config.coin}:blocks:candidates`, block.serialized);
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
          ].join(':')
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
      });
    
      if (multi.queue.length > 0) {
        multi.exec((error, replies) => {
          if (error) {
            log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
            callback(true);
            return;
          }
          callback(null, blocks);
        });
      } else {
        callback(null, blocks);
      }
		},

		// Handle unlocked blocks
		function (blocks, callback) {
      const multi = redisClient.multi();
      const payments = {};
      let totalBlocksUnlocked = 0;
    
      blocks.forEach((block) => {
        if (block.orphaned) {
          return;
        }
        totalBlocksUnlocked++;
    
        multi.del(`${config.coin}:scores:solo:round${block.height}`);
        multi.del(`${config.coin}:scores:prop:round${block.height}`);
        multi.del(`${config.coin}:shares_actual:solo:round${block.height}`);
        multi.del(`${config.coin}:shares_actual:prop:round${block.height}`);
        multi.zRem(`${config.coin}:blocks:candidates`, block.serialized);
        multi.zAdd(`${config.coin}:blocks:matured`, {
          score: block.height,
          value: [
            block.rewardType,
            block.login,
            block.hash,
            block.time,
            block.difficulty,
            block.shares,
            block.orphaned,
            block.reward
          ].join(':')
        });
    
        let feePercent = (config.blockUnlocker.poolFee > 0 ? config.blockUnlocker.poolFee : 0) / 100;
        if (block.rewardType === 'solo') {
          feePercent = (config.blockUnlocker.soloFee >= 0 ? config.blockUnlocker.soloFee : (config.blockUnlocker.poolFee > 0 ? config.blockUnlocker.poolFee : 0)) / 100;
        }
        if (Object.keys(donations).length) {
          for (const wallet in donations) {
            const percent = donations[wallet] / 100;
            feePercent += percent;
            payments[wallet] = (payments[wallet] || 0) + Math.round(block.reward * percent);
            log('info', logSystem, 'Block %d donation to %s as %d percent of reward: %d', [block.height, wallet, percent, payments[wallet]]);
          }
        }
    
        let reward = 0;
        let finderReward = 0;
        if (block.rewardType === 'solo') {
          reward = Math.round(block.reward - (block.reward * feePercent));
          log('info', logSystem, 'Unlocked SOLO block %d with reward %d and donation fee %d. Miners reward: %d', [block.height, block.reward, feePercent, reward]);
        } else {
          const finderPercent = (config.blockUnlocker.finderReward > 0 ? config.blockUnlocker.finderReward : 0) / 100;
          finderReward = Math.round(block.reward * finderPercent);
          reward = Math.round(block.reward - (block.reward * (feePercent + finderPercent)));
          log('info', logSystem, 'Unlocked PROP block %d with reward %d, finders fee %d, and donation fee %d. Miners reward: %d Finders Reward: %d', [block.height, block.reward, finderPercent, feePercent, reward, finderReward]);
        }
    
        if (block.workerScores) {
          const totalScore = parseFloat(block.score);
    
          if (block.rewardType === 'solo') {
            const worker = block.login;
            payments[worker] = (payments[worker] || 0) + reward;
            log('info', logSystem, 'SOLO Block %d payment to %s for %d%% of total block score: %d', [block.height, worker, 100, payments[worker]]);
          } else {
            Object.keys(block.workerScores).forEach((worker) => {
              const percent = block.workerScores[worker] / totalScore;
              const workerReward = Math.round(reward * percent);
              payments[worker] = block.login === worker ? (payments[worker] || 0) + (workerReward + finderReward) : (payments[worker] || 0) + workerReward;
              log('info', logSystem, 'PROP Block %d payment to %s for %d%% of total block score: %d', [block.height, worker, percent * 100, payments[worker]]);
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
      });
    
      for (const worker in payments) {
        const amount = parseInt(payments[worker], 10);
        if (amount <= 0) {
          delete payments[worker];
          continue;
        }
        multi.hIncrBy(`${config.coin}:workers:${worker}`, 'balance', amount);
      }
    
      if (multi.queue.length === 0) {
        log('info', logSystem, 'No unlocked blocks yet (%d pending)', [blocks.length]);
        callback(true);
        return;
      }
    
      multi.exec((error, replies) => {
        if (error) {
          log('error', logSystem, 'Error with unlocking blocks %j', [error]);
          callback(true);
          return;
        }
        log('info', logSystem, 'Unlocked %d blocks and updated balances for %d workers', [totalBlocksUnlocked, Object.keys(payments).length]);
        callback(null);
      });
		}
	], 
  function (error, result) {
		setTimeout(runInterval, config.blockUnlocker.interval * 1000);
	})
}

runInterval();
