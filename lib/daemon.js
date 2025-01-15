const getTemplate = async () => {
  try {
    const blockTemplate = await rpcClient.getBlockTemplate({
      paymentAddress: config.poolAddress
    });
    console.log("Block template received:", blockTemplate);

    process.send({
      type: 'BlockTemplate',
      block: blockTemplate
    });
    
  } catch (error) {
    console.error("Error fetching block template:", error);
  }
}

rpcClient.addEventListener("block-added", async (event) => {
  console.log("New block added:", event.data);
  
  await getTemplate();
});

rpcClient.addEventListener("VirtualDaaScoreChanged", async (event) => {
  console.log("DAA score changed:", event.data);
  
  await getTemplate();
});

rpcClient.addEventListener("connect", async (event) => {
  console.log("Connected to the node:", event);
  
  // Subscribe to block-added events
  console.log("Subscribing to block-added...");
  await rpcClient.subscribeBlockAdded();
  console.log("Subscribed to block-added events.");
  
  // Subscribe to DAA score events
  console.log("Subscribing to DAA score...");
  await rpcClient.subscribeVirtualDaaScoreChanged();
  console.log("Subscribed to DAA score changes.");
});

rpcClient.addEventListener("disconnect", (event) => {
  console.log("Disconnected from the node:", event);
});

// Connect to the node and start listening for events
(async () => {
  try {
    await rpcClient.connect();
    console.log("Listening for events...");
  } catch (error) {
    console.error("Error connecting to the node:", error);
  }
})();
