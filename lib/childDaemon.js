// Load log system
require('./logger.js');

// Initialize log system
var logSystem = 'childDaemon';
require('./exceptionWriter.js')(logSystem);

const getBlockTemplate = async () => {
  try {
    // Fetch the block template when a new block is added
    const blockTemplate = await rpcClient.getBlockTemplate({
      paymentAddress: config.poolAddress
    });
    console.log("Block template received:", blockTemplate);

    // Send the block template to the worker process
    process.send({
      type: 'ChildBlockTemplate',
      block: blockTemplate,
      poolIndex: process.env.poolId
    });

  } catch (error) {
    console.error("Error fetching block template:", error);
  }
}

rpcClient.addEventListener("block-added", async (event) => {
  log('info', logSystem, `New block added`);

  await getTemplate();
});

rpcClient.addEventListener("virtual-daa-score-changed", async (event) => {
  // console.log("DAA score changed:", event.data);

  await getTemplate();
});

rpcClient.addEventListener("connect", async (event) => {
  log('info', logSystem, `Connected to the ${config.symbol} node`);

  // Subscribe to block-added events
  log('info', logSystem, `Subscribing to block-added...`);
  await rpcClient.subscribeBlockAdded();
  log('info', logSystem, `Subscribed to block-added events.`);

  // Subscribe to DAA score events
  log('info', logSystem, `Subscribing to DAA score...`);
  await rpcClient.subscribeVirtualDaaScoreChanged();
  log('info', logSystem, `Subscribed to DAA score changes.`);
});

rpcClient.addEventListener("disconnect", (event) => {
  console.log("Disconnected from the node:", event);
});

// Connect to the node and start listening for events
(async () => {
  try {
    await rpcClient.connect();
    log('info', logSystem, `Listening for events...`);
  } catch (error) {
    console.error("Error connecting to the node:", error);
  }
})();