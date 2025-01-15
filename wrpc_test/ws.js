globalThis.WebSocket = require('websocket').w3cwebsocket;

// WagLayla Node.js session test
let {
  pow,
  RpcClient,
  Encoding,
  initConsolePanicHook
} = require('../util/waglayla');

const rpc = new RpcClient({
  url: 'ws://127.0.0.1:13110',
  encoding: Encoding.Borsh,
  network: 'mainnet'
});

(async () => {
  try {
    rpc.addEventListener("block-added", (event) => {
      console.log("Received new block added:", event.data);
    });

    rpc.addEventListener("connect", async (event) => {
      console.log("Connected to", rpc.url);
      console.log(event);
      console.log("Subscribing to DAA score...");
      rpc.subscribeVirtualDaaScoreChanged();
      rpc.subscribeBlockAdded();
    });

    rpc.addEventListener("disconnect", (event) => {
      console.log("Disconnected from the Kaspa node:", event);
    });

    // Connect to the Kaspa node
    await rpc.connect();

    const info = await rpc.getInfo();
    console.log('Server info:', info);
    
    console.log('Listening for events...');

  } catch (error) {
    console.error('Error:', error);
  }
})();
