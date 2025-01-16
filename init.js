/**
 * Cryptonite Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Pool initialization script
 **/

// Load needed modules
var fs = require('fs');
var cluster = require('cluster');
var os = require('os');
require('dotenv').config();

globalThis.WebSocket = require("websocket").w3cwebsocket;

// Load configuration
require('./lib/configReader.js');

const privateKeyHex = process.env.PRIVATE_KEY;

if (!privateKeyHex) {
    console.error("Private key is missing. Please set the PRIVATE_KEY environment variable.");
    process.exit(1);
}

global.privateKey = new PrivateKey(privateKeyHex);

// Load log system
require('./lib/logger.js');

// Initialize log system
var logSystem = 'master';
require('./lib/exceptionWriter.js')(logSystem);

// Pool informations
log('info', logSystem, 'Starting KAS Node.JS pool version %s', [version]);

// Check configuration data
var poolAddress = config.poolServer.poolAddress || null;
if (!poolAddress || poolAddress.match(/(\s+|\*)/)) {
  log('error', logSystem, 'Invalid pool wallet address in configuration file (poolServer.poolAddress)');
  process.exit();
}

// Initialize redis database client
var redis = require('redis');

var redisDB = (config.redis.db && config.redis.db > 0) ? config.redis.db : 0;
global.redisClient = redis.createClient(config.redis.port, config.redis.host, {
  db: redisDB,
  // auth_pass: config.redis.auth
});

global.redisClient.on('connect', () => {
  log('info', logSystem, 'Redis client connected successfully');
});

global.redisClient.on('error', (err) => {
  log('error', logSystem, 'Redis connection error:', err);
});

global.redisClient.on('end', () => {
  log('info', logSystem, 'Redis client disconnected');
});

if ((typeof config.poolServer.mergedMining !== 'undefined' && config.poolServer.mergedMining) && typeof config.childPools !== 'undefined')
  config.childPools = config.childPools.filter(pool => pool.enabled);
else
  config.childPools = [];

// Load pool modules
if (cluster.isWorker) {
  switch (process.env.workerType) {
    case 'pool':
      require('./lib/pool.js');
      break;
    case 'daemon':
      require('./lib/daemon.js')
      break
    case 'childDaemon':
      require('./lib/childDaemon.js')
      break
    case 'blockUnlocker':
      require('./lib/blockUnlocker.js');
      break;
    case 'paymentProcessor':
      require('./lib/paymentProcessor.js');
      break;
    case 'api':
      require('./lib/api.js');
      break;
    case 'chartsDataCollector':
      require('./lib/chartsDataCollector.js');
      break;
    case 'telegramBot':
      require('./lib/telegramBot.js');
      break;
  }
  return;
}

// Developer donations
if (devFee < 0.2)
  log('info', logSystem, 'Developer donation \(devDonation\) is set to %d\%, Please consider raising it to 0.2\% or higher !!!', [devFee]);

// Run a single module ?
var singleModule = (function () {
  var validModules = ['pool', 'api', 'unlocker', 'payments', 'chartsDataCollector', 'telegramBot'];

  for (var i = 0; i < process.argv.length; i++) {
    if (process.argv[i].indexOf('-module=') === 0) {
      var moduleName = process.argv[i].split('=')[1];
      if (validModules.indexOf(moduleName) > -1)
        return moduleName;

      log('error', logSystem, 'Invalid module "%s", valid modules: %s', [moduleName, validModules.join(', ')]);
      process.exit();
    }
  }
})();

/**
 * Start modules
 **/
(async function init() {
  await global.redisClient.connect();
  await checkRedisVersion();

  if (singleModule) {
    log('info', logSystem, 'Running in single module mode: %s', [singleModule]);

    switch (singleModule) {
      case 'daemon':
        spawnDaemon()
        break
      case 'pool':
        spawnPoolWorkers();
        break;
      case 'unlocker':
        spawnBlockUnlocker();
        break;
      case 'payments':
        spawnPaymentProcessor();
        break;
      case 'api':
        spawnApi();
        break;
      case 'chartsDataCollector':
        spawnChartsDataCollector();
        break;
      case 'telegramBot':
        spawnTelegramBot();
        break;
    }
  } else {
    log('info', logSystem, 'Running all modules');
    spawnPoolWorkers();
    spawnDaemon();
    if (config.poolServer.mergedMining)
      spawnChildDaemons();
    spawnBlockUnlocker();
    spawnPaymentProcessor();
    spawnApi();
    spawnChartsDataCollector();
    spawnTelegramBot();
  }
})();

/**
 * Check redis database version
 **/
async function checkRedisVersion() {
  try {
    // Fetch full INFO
    const response = await redisClient.info();
    
    // Parse the response to find `redis_version`
    const parts = response.split('\r\n');
    let version;
    let versionString;

    for (const line of parts) {
      if (line.includes(':')) {
        const [key, value] = line.split(':');
        if (key === 'redis_version') {
          versionString = value;
          version = parseFloat(versionString);
          break;
        }
      }
    }

    if (!version) {
      log('error', logSystem, 'Could not detect Redis version - must be super old or broken.');
    } else if (version < 2.6) {
      log('error', logSystem,
        `You're using Redis version ${versionString}. The minimum required version is 2.6.`
      );
    } else {
      log('info', logSystem, `Redis version ${versionString} detected and valid.`);
    }
  } catch (error) {
    log('error', logSystem, 'Redis version check failed:', error.message);
  }
}

// Initialize the wallet and start it if necessary
async function startWallet() {
  try {
    if (!global.Wallet.isOpen) {
      await global.Wallet.start();  // Use the start() method if the wallet isn't open
      log('info', logSystem, 'Wallet started successfully.');
    }

    // Ensure the wallet is synced
    if (!global.Wallet.isSynced) {
      log('info', logSystem, 'Waiting for wallet to sync...');
      await waitForSync(); // Function to wait until wallet is synced
      log('info', logSystem, 'Wallet is synced.');
    }

  } catch (error) {
    log('error', logSystem, 'Failed to start wallet: %j', [error]);
    process.exit(1);
  }
}

// A simple function to wait for syncing to complete
async function waitForSync() {
  while (!global.Wallet.isSynced) {
    log('info', logSystem, 'Waiting for sync...');
    await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5 seconds
  }
}

/**
 * Spawn pool workers module
 **/
function spawnPoolWorkers() {
  if (!config.poolServer || !config.poolServer.enabled || !config.poolServer.ports || config.poolServer.ports.length === 0) return;

  if (config.poolServer.ports.length === 0) {
    log('error', logSystem, 'Pool server enabled but no ports specified');
    return;
  }
  var numForks = (function () {
    if (!config.poolServer.clusterForks)
      return 1;
    if (config.poolServer.clusterForks === 'auto')
      return os.cpus()
        .length;
    if (isNaN(config.poolServer.clusterForks))
      return 1;
    return config.poolServer.clusterForks;
  })();

  var poolWorkers = {};

  var createPoolWorker = function (forkId) {
    var worker = cluster.fork({
      workerType: 'pool',
      forkId: forkId
    });
    worker.forkId = forkId;
    worker.type = 'pool';
    poolWorkers[forkId] = worker;
    worker.on('exit', function (code, signal) {
      log('error', logSystem, 'Pool fork %s died, spawning replacement worker...', [forkId]);
      setTimeout(function () {
        createPoolWorker(forkId);
      }, 2000);
    })
      .on('message', function (msg) {
        switch (msg.type) {
          case 'banIP':
            Object.keys(cluster.workers)
              .forEach(function (id) {
                if (cluster.workers[id].type === 'pool') {
                  cluster.workers[id].send({
                    type: 'banIP',
                    ip: msg.ip
                  });
                }
              });
            break;
        }
      });
  };

  var i = 1;
  var spawnInterval = setInterval(function () {
    createPoolWorker(i.toString());
    i++;
    if (i - 1 === numForks) {
      clearInterval(spawnInterval);
      log('info', logSystem, 'Pool spawned on %d thread(s)', [numForks]);
    }
  }, 10);
}

/**
 * Spawn pool workers module
 **/
function spawnChildDaemons() {
  if (!config.poolServer || !config.poolServer.enabled || !config.poolServer.ports || config.poolServer.ports.length === 0) return;

  if (config.poolServer.ports.length === 0) {
    log('error', logSystem, 'Pool server enabled but no ports specified');
    return;
  }

  let numForks = config.childPools.length;
  if (numForks === 0) return;
  var daemonWorkers = {};

  var createDaemonWorker = function (poolId) {
    var worker = cluster.fork({
      workerType: 'childDaemon',
      poolId: poolId
    });
    worker.poolId = poolId;
    worker.type = 'childDaemon';
    daemonWorkers[poolId] = worker;
    worker.on('exit', function (code, signal) {
      log('error', logSystem, 'Child Daemon fork %s died, spawning replacement worker...', [poolId]);
      setTimeout(function () {
        createDaemonWorker(poolId);
      }, 2000);
    })
      .on('message', function (msg) {
        switch (msg.type) {
          case 'ChildBlockTemplate':
            Object.keys(cluster.workers)
              .forEach(function (id) {
                if (cluster.workers[id].type === 'pool') {
                  cluster.workers[id].send({
                    type: 'ChildBlockTemplate',
                    block: msg.block,
                    poolIndex: msg.poolIndex
                  });
                }
              });
            break;
        }
      });
  };

  var i = 0;
  var spawnInterval = setInterval(function () {
    createDaemonWorker(i.toString())
    i++
    if (i === numForks) {
      clearInterval(spawnInterval);
      log('info', logSystem, 'Child Daemon spawned on %d thread(s)', [numForks]);
    }
  }, 10);
}

/**
 * Spawn daemon module
 **/
function spawnDaemon() {
  if (!config.poolServer || !config.poolServer.enabled || !config.poolServer.ports || config.poolServer.ports.length === 0) return;

  var worker = cluster.fork({
    workerType: 'daemon'
  });
  worker.on('exit', function (code, signal) {
    log('error', logSystem, 'Daemon died, spawning replacement...');
    setTimeout(function () {
      spawnDaemon();
    }, 10);
  })
    .on('message', function (msg) {
      switch (msg.type) {
        case 'BlockTemplate':
          Object.keys(cluster.workers)
            .forEach(function (id) {
              if (cluster.workers[id].type === 'pool') {
                cluster.workers[id].send({
                  type: 'BlockTemplate',
                  block: msg.block
                });
              }
            });
          break;
      }
    });
}

/**
 * Spawn block unlocker module
 **/
function spawnBlockUnlocker() {
  if (!config.blockUnlocker || !config.blockUnlocker.enabled) return;

  var worker = cluster.fork({
    workerType: 'blockUnlocker'
  });
  worker.on('exit', function (code, signal) {
    log('error', logSystem, 'Block unlocker died, spawning replacement...');
    setTimeout(function () {
      spawnBlockUnlocker();
    }, 2000);
  });
}

/**
 * Spawn payment processor module
 **/
function spawnPaymentProcessor() {
  if (!config.payments || !config.payments.enabled) return;

  var worker = cluster.fork({
    workerType: 'paymentProcessor'
  });
  worker.on('exit', function (code, signal) {
    log('error', logSystem, 'Payment processor died, spawning replacement...');
    setTimeout(function () {
      spawnPaymentProcessor();
    }, 2000);
  });
}

/**
 * Spawn API module
 **/
function spawnApi() {
  if (!config.api || !config.api.enabled) return;

  var worker = cluster.fork({
    workerType: 'api'
  });
  worker.on('exit', function (code, signal) {
    log('error', logSystem, 'API died, spawning replacement...');
    setTimeout(function () {
      spawnApi();
    }, 2000);
  });
}

/**
 * Spawn charts data collector module
 **/
function spawnChartsDataCollector() {
  if (!config.charts) return;

  var worker = cluster.fork({
    workerType: 'chartsDataCollector'
  });
  worker.on('exit', function (code, signal) {
    log('error', logSystem, 'chartsDataCollector died, spawning replacement...');
    setTimeout(function () {
      spawnChartsDataCollector();
    }, 2000);
  });
}

/**
 * Spawn telegram bot module
 **/
function spawnTelegramBot() {
  if (!config.telegram || !config.telegram.enabled || !config.telegram.token) return;

  var worker = cluster.fork({
    workerType: 'telegramBot'
  });
  worker.on('exit', function (code, signal) {
    log('error', logSystem, 'telegramBot died, spawning replacement...');
    setTimeout(function () {
      spawnTelegramBot();
    }, 2000);
  });
}
