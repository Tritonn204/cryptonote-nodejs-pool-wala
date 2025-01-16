/**
 * KAS Node.JS Pool
 * https://github.com/Tritonn204/kas-nodejs-pool
 *
 * Configuration Reader
 **/

// Load required modules
let fs = require('fs');

// Set pool software version
global.version = "v1.0.0";

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

let {
  RpcClient,
  Encoding,
  State,
  Wallet,
  Generator,
  PrivateKey,
  initConsolePanicHook,
} = getChainPrimitives(global.config);

initConsolePanicHook();

global.State = State;
global.Wallet = Wallet;
global.PrivateKey = PrivateKey;
global.Generator = Generator;

global.amountToSompi = getAmountToSompi();

const wsUrl = `ws://${config.daemon.host}:${config.daemon.port}`;

global.rpcClient = new RpcClient({
  url: wsUrl,
  encoding: Encoding.Borsh,
  network: 'mainnet'
});

/**
 * Developer donation addresses -- thanks for supporting my works!
 **/

let donationAddresses = {
  WALA: "waglayla:qqcnx8af93hn5pl840lcw86q0re003qxskndj7cpq8e83c6ydlyg5rmynpp4u"
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
