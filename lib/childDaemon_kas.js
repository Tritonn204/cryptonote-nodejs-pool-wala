let async = require('async');
let apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
let lastHash;
let POOL_NONCE_SIZE = 16 + 1; // +1 for old XMR/new TRTL bugs

let logSystem = 'childDaemon'
require('./exceptionWriter.js')(logSystem);


let pool = config.childPools[process.env.poolId];

// TODO: try getting away with using naked JSON (not much luck in my experience with KAS coins).
// If that fails, will need to adopt the js core lib for waglayla to start.

// The calls on the raw RPC JSON are not the same AFAIK

let blockData = JSON.stringify({
	id: "0",
	jsonrpc: "2.0",
	method: 'getlastblockheader',
	params: {}
})

let templateData = JSON.stringify({
	id: "0",
	jsonrpc: "2.0",
	method: 'getblocktemplate',
	params: {
		reserve_size: POOL_NONCE_SIZE,
		wallet_address: pool.poolAddress
	}
})


function runInterval () {
	async.waterfall([
    function (callback) {
      apiInterfaces.jsonHttpRequest(pool.childDaemon.host, pool.childDaemon.port, blockData, function (err, res) {
        if (err) {
          log('error', logSystem, '%s error from daemon', [pool.coin]);
          setTimeout(runInterval, 250);
          return;
        }
        if (res && res.result && res.result.status === "OK" && res.result.hasOwnProperty('block_header')) {
          let hash = res.result.block_header.hash.toString('hex');
          if (!lastHash || lastHash !== hash) {
            lastHash = hash
            log('info', logSystem, '%s found new hash %s', [pool.coin, hash]);
            callback(null, true);
            return;
          } else if (config.daemon.alwaysPoll || false) {
            callback(null, true);
            return;
          } else {
            callback(true);
            return;
          }
        } else {
          log('error', logSystem, '%s bad reponse from daemon', [pool.coin]);
          setTimeout(runInterval, 250);
          return;
        }
      });
    },
    function (getbc, callback) {
      apiInterfaces.jsonHttpRequest(pool.childDaemon.host, pool.childDaemon.port, templateData, function (err, res) {
        if (err) {
          log('error', logSystem, '%s Error polling getblocktemplate %j', [pool.coin, err])
          callback(null)
          return
        }
        process.send({
          type: 'ChildBlockTemplate',
          block: res.result,
          poolIndex: process.env.poolId
        })
        callback(null)
      })
    }
  ],
  function (error) {
    if (error) {}
    setTimeout(function () {
      runInterval()
    }, config.poolServer.blockRefreshInterval)
  })
}

runInterval()
