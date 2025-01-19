// Dynamically require the appropriate chain logic based on configuration

require('dotenv').config();

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

module.exports = { getChainPrimitives, getAmountToSompi };