// Dynamically require the appropriate chain logic based on configuration
function getChainPrimitives(config) {
  const coin = config.symbol; // Get the blockchain specified in config (e.g., 'kaspa', 'waglayla')

  if (coin === 'KAS') {
    return require('../util/kaspa');  // Kaspa-specific RPC client
  } else if (chain === 'WALA') {
    return require('../util/waglayla');  // Waglayla-specific RPC client
  } else {
    throw new Error(`Unsupported coin: ${coin}`);
  }
}

function getAmountToSompi(config) {
  const coin = config.symbol; // Get the blockchain specified in config (e.g., 'kaspa', 'waglayla')

  if (coin === 'KAS') {
    let { kaspaToSompi } = require('../util/kaspa');  // Kaspa-specific RPC client
    return kaspaToSompi;
  } else if (chain === 'WALA') {
    let { waglaylaToSompi } =  require('../util/waglayla');  // Waglayla-specific RPC client
    return waglaylaToSompi;
  } else {
    throw new Error(`Unsupported coin: ${coin}`);
  }
}

module.exports = { getChainPrimitives, getAmountToSompi };