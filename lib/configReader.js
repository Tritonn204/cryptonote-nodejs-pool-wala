/**
 * KAS Node.JS Pool
 * https://github.com/Tritonn204/kas-nodejs-pool
 *
 * Configuration Reader
 **/

// Load required modules
let fs = require('fs');

// Set pool software version
global.version = "v2.0.0";

/**
 * Load pool configuration
 **/

// Get configuration file path
let configFile = (function () {
	for (let i = 0; i < process.argv.length; i++) {
		if (process.argv[i].indexOf('-config=') === 0)
			return process.argv[i].split('=')[1];
	}
	return 'config.json';
})();

// Read configuration file data
try {
	global.config = JSON.parse(fs.readFileSync(configFile));
} catch (e) {
	console.error('Failed to read config file ' + configFile + '\n\n' + e);
	return;
}

const { getChainPrimitives, getAmountToSompi } = require('./apiInterfaces');

coinSDK = getChainPrimitives(global.config);

coinSDK.initConsolePanicHook();

global.coinSDK = coinSDK;

const wsUrl = `ws://${config.daemon.host}:${config.daemon.port}`;

global.rpcClient = new coinSDK.RpcClient({
  url: wsUrl,
  encoding: coinSDK.Encoding.Borsh,
  network: 'mainnet'
});

/**
 * Developer donation addresses -- thanks for supporting my works!
 **/

let donationAddresses = {
	KAS: "",
  WALA: "waglayla:qr6h2tqwx8ad57nkte9kvcd9cqyjfgk30gznnza9jte7qzfa6gu0xy5n3evj5"
};

global.donations = {};

global.devFee = config.blockUnlocker.devDonation || 0.0;
if (config.blockUnlocker.devDonation === 0){
	global.devFee = 0.0;
}

let wallet = donationAddresses[config.symbol.toUpperCase()];
if (devFee && wallet){
	global.donations[wallet] = devFee;
}
