// Dynamically require the appropriate chain logic based on configuration

require('dotenv').config();

var http = require('http');
var https = require('https');

function jsonHttpRequest (host, port, data, callback, path) {
	path = path || '/json_rpc';
	callback = callback || function () {};
	var options = {
		hostname: host,
		port: port,
		path: path,
		method: data ? 'POST' : 'GET',
		headers: {
			'Content-Length': data.length,
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		}
	};
	var req = (port === 443 ? https : http)
		.request(options, function (res) {
			var replyData = '';
			res.setEncoding('utf8');
			res.on('data', function (chunk) {
				replyData += chunk;
			});
			res.on('end', function () {
				var replyJson;
				try {
					replyJson = replyData ? JSON.parse(replyData) : {};
				} catch (e) {
					callback(e, {});
					return;
				}
				callback(null, replyJson);
			});
		});

	req.on('error', function (e) {
		callback(e, {});
	});
	req.end(data);
}

function getChainPrimitives(config) {
  const coin = global.config.symbol; // Get the blockchain specified in config (e.g., 'kaspa', 'waglayla')

  if (coin === 'KAS') {
    global.seedPhrase = process.env.KAS_SEED;
    return require('../util/kaspa');  // Kaspa-specific RPC client
  } else if (coin === 'WALA') {
    global.seedPhrase = process.env.WALA_SEED;
    return require('../util/waglayla');  // Waglayla-specific RPC client
  } else {
    throw new Error(`Unsupported coin: ${coin}`);
  }
}

function getAmountToSompi(config) {
  const coin = global.config.symbol; // Get the blockchain specified in config (e.g., 'kaspa', 'waglayla')

  if (coin === 'KAS') {
    let { kaspaToSompi } = require('../util/kaspa');  // Kaspa-specific RPC client
    return kaspaToSompi;
  } else if (coin === 'WALA') {
    let { waglaylaToSompi } =  require('../util/waglayla');  // Waglayla-specific RPC client
    return waglaylaToSompi;
  } else {
    throw new Error(`Unsupported coin: ${coin}`);
  }
}

/**
 * Send RPC request to pool API
 **/
function poolRpc (host, port, path, callback) {
	jsonHttpRequest(host, port, '', callback, path);
}

function pool(path, callback) {
  var bindIp = config.api.bindIp ? config.api.bindIp : "0.0.0.0";
  var poolApi = (bindIp !== "0.0.0.0" ? poolApiConfig.bindIp : "127.0.0.1");
  poolRpc(poolApi, config.api.port, path, callback);
};

module.exports = { getChainPrimitives, getAmountToSompi, pool, jsonHttpRequest };