// Load log system
require('./logger.js');
const utils = require('./utils.js');

// Initialize log system
var logSystem = 'daemon';
require('./exceptionWriter.js')(logSystem);

(async () => {
  await redisClient.connect();
})();

const getTemplate = async () => {
  try {
    const blockTemplate = await rpcClient.getBlockTemplate({
      payAddress: config.poolServer.poolAddress
    });

    const serializedBlockTemplate = JSONbig.stringify(blockTemplate);
    const id = utils.generateJobID();

    log('info', logSystem, `Block template received | DAA: ${blockTemplate.block.header.daaScore} | JobID: ${id}`);
    process.send({
      type: 'BlockTemplate',
      block: serializedBlockTemplate,
      jobId: id,
    });

    await redisClient.set(`${config.coin}:daaScore`, blockTemplate.block.header.daaScore.toString(10));
  } catch (error) {
    log('error', logSystem, `Error fetching block template: ${error}`);
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
