/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Pool TCP daemon
 **/

// Load required modules
let fs = require('fs');
let net = require('net');
let tls = require('tls');
let async = require('async');

(async () => {
  await redisClient.connect();
})();

(async () => {
  try {
    await rpcClient.connect();
    log('info', logSystem, `Listening for events...`);
  } catch (error) {
    console.error("Error connecting to the node:", error);
  }
})();

/**
 * Block template
 **/
class BlockTemplate {
  constructor(blockData, buffer) {
    this.block = blockData; // The block object, including header and transactions
    this.buffer = buffer; // Buffer generated in the process() method
    this.header = blockData.header; // Shortcut to the block header for convenience
  }

  // Helper methods for common accessors
  get hash() {
    return this.header.hash;
  }

  get timestamp() {
    return this.header.timestamp;
  }

  get difficulty() {
    return this.header.bits;
  }

  get blueScore() {
    return this.header.blueScore;
  }

  getBuffer() {
    return this.buffer;
  }

  // Additional logic related to the template
  toVerboseString() {
    return `Block Template: Hash=${this.getHash()}, Difficulty=${this.getDifficulty()}, BlueScore=${this.getBlueScore()}`;
  }
}

class BlockTemplateProcessor {
  getJobForTesting(template, id) {
    const buffer = template.buffer;
    const timestamp = Number(template.header.timestamp); // Convert BigInt timestamp to number
  
    // Extract 8-byte chunks from the first 32 bytes of the buffer
    const chunks = [];
    for (let i = 0; i < 32; i += 8) {
      const chunk = buffer.readBigUInt64BE(i); // Read as a big-endian 8-byte unsigned integer
      chunks.push(chunk.toString(10)); // Convert BigInt to string in decimal
    }
  
    // Construct the job object
    return {
      id: id, // Example job ID
      jsonrpc: "2.0",
      method: "mining.notify",
      params: [
        chunks.map(Number), // Convert decimal strings to numbers
        timestamp, // Timestamp as a decimal number
      ],
    };
  }

  process(template, indexOfChildPool) {
    // Parse the block template
    const header = new coinSDK.Header(template.block.header);
    const powState = new coinSDK.State(header);

    // Pre-compute the PoW hash
    const prePowHash = powState.prePowHash;

    // Compute timestampHex with padding
    let timestampHex = header.timestamp.toString(16);
    while (timestampHex.length < 16) {
      timestampHex = "0" + timestampHex; // Pad with leading zeroes
    }

    let reversedTimestampHex = timestampHex.match(/.{2}/g).reverse().join("");

    // Prepare the blob with padding and nonce space
    const padding64 = "0".repeat(64); // 64 zeroes
    const nonceSpace16 = "0".repeat(16); // 16 zeroes
    const templateBlob = prePowHash + reversedTimestampHex + padding64 + nonceSpace16;

    // log('info', logSystem, `"Block template blob:", ${templateBlob}`);

    // Convert blob to a buffer
    const byteArray = new Uint8Array(templateBlob.length / 2);
    for (let i = 0; i < templateBlob.length; i += 2) {
      byteArray[i / 2] = parseInt(templateBlob.slice(i, i + 2), 16);
    }
    const buffer = Buffer.from(byteArray);

    // Set up extra nonce
    const reserveOffset = buffer.length - 8; // Final 8 bytes
    this.setExtraNonce(buffer, reserveOffset);

    // Update the block templates
    this.updateTemplates(indexOfChildPool, template.block, buffer);
  }

  setExtraNonce(buffer, reserveOffset) {
    // Set extra nonce in the first 3 bytes of the final 8
    buffer.writeUInt8(0, reserveOffset);     // Extra nonce byte 1
    buffer.writeUInt8(0, reserveOffset + 1); // Extra nonce byte 2
    buffer.writeUInt8(0, reserveOffset + 2); // Extra nonce byte 3
  }

  updateTemplates(indexOfChildPool, blockData, buffer) {
    // Create a new Template instance
    const template = new BlockTemplate(blockData, buffer);
  
    // Initialize the validBlockTemplates array if it doesn't exist
    if (!validBlockTemplates[indexOfChildPool]) {
      validBlockTemplates[indexOfChildPool] = [];
    }

    // Add the current template to the list of valid templates if one exists
    if (currentBlockTemplate[indexOfChildPool]) {
      validBlockTemplates[indexOfChildPool].push(currentBlockTemplate[indexOfChildPool]);
    }
  
    // Maintain a maximum of 3 valid block templates
    while (validBlockTemplates[indexOfChildPool].length > 3) {
      validBlockTemplates[indexOfChildPool].shift();
    }
  
    let newJobID = currentJobID;

    // Update the current block template for the pool
    currentBlockTemplate[indexOfChildPool] = template;
    
    // Notify connected miners about the new block template
    notifyConnectedMiners(indexOfChildPool, newJobID);
  }
}

const blockTemplateProcessor = new BlockTemplateProcessor();

let notifications = require('./notifications.js');
let utils = require('./utils.js');

config.hashingUtil = config.hashingUtil || false;
// if (config.hashingUtil) {
// 	cnHashing = require('turtlecoin-crypto');
// }
// Set nonce pattern - must exactly be 8 hex chars
// let noncePattern = new RegExp("^[0-9A-Fa-f]{8}$");

// Set redis database cleanup interval
let cleanupInterval = config.redis.cleanupInterval && config.redis.cleanupInterval > 0 ? config.redis.cleanupInterval : 15;
let fallBackCoin = typeof config.poolServer.fallBackCoin !== 'undefined' && config.poolServer.fallBackCoin ? config.poolServer.fallBackCoin : 0

// Initialize log system
let logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

let threadId = '(Thread ' + process.env.forkId + ') ';
let log = function (severity, system, text, data) {
	global.log(severity, system, threadId + text, data);
};

// Set cryptonight algorithm
let Algorithm = config.algorithm || "walahash";

// Set instance id
let instanceId = utils.instanceId();

// Pool variables
let poolStarted = false;
let connectedMiners = {};
// Get merged mining tag reseved space size
let POOL_NONCE_SIZE = 16; // +1 for old XMR/new TRTL bugs
let EXTRA_NONCE_TEMPLATE = "02" + POOL_NONCE_SIZE.toString(16) + "00".repeat(POOL_NONCE_SIZE);

function randomIntFromInterval (min, max) {
	return Math.floor(Math.random() * (max - min + 1) + min);
}

// Pool settings
let shareTrustEnabled = config.poolServer.shareTrust && config.poolServer.shareTrust.enabled;
let shareTrustStepFloat = shareTrustEnabled ? config.poolServer.shareTrust.stepDown / 100 : 0;
let shareTrustMinFloat = shareTrustEnabled ? config.poolServer.shareTrust.min / 100 : 0;

let banningEnabled = config.poolServer.banning && config.poolServer.banning.enabled;
let bannedIPs = {};
let perIPStats = {};

let slushMiningEnabled = config.poolServer.slushMining && config.poolServer.slushMining.enabled;

if (!config.poolServer.paymentId) {
	config.poolServer.paymentId = {};
}
if (!config.poolServer.paymentId.addressSeparator) {
	config.poolServer.paymentId.addressSeparator = "+";
}

if (config.poolServer.paymentId.validation == null) {
	config.poolServer.paymentId.validation = true;
}
if (config.poolServer.paymentId.ban == null) {
	config.poolServer.paymentId.ban = false;
}
if (config.poolServer.paymentId.validations == null) {
	config.poolServer.paymentId.validations = [];
	config.poolServer.paymentId.validation = false;
}

config.isRandomX = config.isRandomX || false;

let previousOffset = config.previousOffset || 7;
let offset = config.offset || 2;
config.daemonType = config.daemonType || 'default';
if (config.daemonType === 'bytecoin') {
	previousOffset = config.previousOffset || 3;
	offset = config.offset || 3;
}

function Create2DArray (rows) {
	let arr = [];
	for (let i = 0; i < rows; i++) {
		arr[i] = [];
	}
	return arr;
}

// Block templates
let validBlockTemplates = Create2DArray(1);
let currentBlockTemplate = [];
let currentJobID = "";


// Child Block templates
let currentChildBlockTemplate = new Array(1);


// Difficulty buffer
let diff1 = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');

/**
 * Convert buffer to byte array
 **/
Buffer.prototype.toByteArray = function () {
	return Array.prototype.slice.call(this, 0);
};

/**
 * Periodical updaters
 **/

// Variable difficulty retarget
setInterval(function () {
	let now = Date.now() / 1000 | 0;
	for (let subId in connectedMiners) {
		let sub = connectedMiners[subId];
    for (let minerId in sub.workers) {
      let miner = sub.workers[minerId];
      if (!miner.noRetarget) {
        miner.retarget(now);
      }
    }
	}
}, config.poolServer.varDiff.retargetTime * 1000);

// Every 30 seconds clear out timed-out miners and old bans
setInterval(function () {
	let now = Date.now();
	let timeout = config.poolServer.minerTimeout * 1000;
	for (let minerId in connectedMiners) {
		let miner = connectedMiners[minerId];
		if (now - miner.lastBeat > timeout) {
			log('warn', logSystem, 'Miner timed out and disconnected %s@%s', [miner.login, miner.ip]);
			delete connectedMiners[minerId];
			removeConnectedWorker(miner, 'timeout');
		}
	}

	if (banningEnabled) {
		for (ip in bannedIPs) {
			let banTime = bannedIPs[ip];
			if (now - banTime > config.poolServer.banning.time * 1000) {
				delete bannedIPs[ip];
				delete perIPStats[ip];
				log('info', logSystem, 'Ban dropped for %s', [ip]);
			}
		}
	}

}, 30000);

/**
 * Determine whether a child block template should be replaced.
 * @param {number} poolIndex - The index of the child pool.
 * @param {Object} block - The new child block template.
 * @returns {boolean} - Whether the new block template should replace the current one.
 */
function shouldReplaceChildBlockTemplate(poolIndex, block) {
  const currentTemplate = currentChildBlockTemplate[poolIndex];

  // Replace if there is no current template, or if the new block is higher or has more transactions
  return (
    !currentTemplate ||
    block.height > currentTemplate.height ||
    (currentTemplate.num_transactions === 0 && block.num_transactions > 0)
  );
}

/**
 * Handle multi-thread messages
 **/
process.on('message', function (message) {
	switch (message.type) {
		case 'banIP':
			bannedIPs[message.ip] = Date.now();
			break;
		case 'BlockTemplate':
    {      
      const template = JSONbig.parse(message.block);
      currentJobID = message.jobId;
      blockTemplateProcessor.process(template, 0);
      break;
    }
		case 'ChildBlockTemplate':
    {      
      const template = JSONbig.parse(message.block);
			let poolIndex = parseInt(message.poolIndex);
      try {
        if (shouldReplaceChildBlockTemplate(poolIndex, block)) {
          log('info', logSystem, 'New %s child block to mine at height %d w/ difficulty of %d (%d transactions)', [
            config.childPools[poolIndex].coin,
            block.height,
            block.difficulty,
            block.num_transactions || 0,
          ]);
    
          processChildBlockTemplate(poolIndex, block);
        }
      } catch (error) {
        log('error', logSystem, `Error handling child block template message for pool index ${poolIndex}: ${error.message}`);
      }
      break;
    }
	}
});


/**
 * Process and update the child block template for a specific pool.
 * @param {number} poolIndex - The index of the child pool.
 * @param {Object} template - The child block template to process.
 */
function processChildBlockTemplate(poolIndex, template) {
  try {
    // Create a new child block template
    const childBlockTemplate = new BlockTemplate(template, false);

    // Update the current child block template
    currentChildBlockTemplate[poolIndex] = childBlockTemplate;

    // Update the parent block template to include the new child block
    if (currentBlockTemplate[poolIndex]) {
      processBlockTemplate(currentBlockTemplate[poolIndex], poolIndex);
    }

    log('info', logSystem, `Processed child block template for pool index ${poolIndex} at height ${template.height}`);
  } catch (error) {
    log('error', logSystem, `Error processing child block template for pool index ${poolIndex}: ${error.message}`);
  }
}

function notifyConnectedMiners (indexOfChildPool, id) {
	for (let subId in connectedMiners) {
		let sub = connectedMiners[subId];

    for (let minerId in sub.workers) {
      if (indexOfChildPool === sub.workers[minerId].activeChildPool) {
        connectedMiners[subId].workers[minerId].addJob(id);
        let blockTemplate = currentBlockTemplate[indexOfChildPool];

        const buffer = blockTemplate.buffer;
      
        // Extract 8-byte chunks from the first 32 bytes of the buffer
        const chunks = [];
        for (let i = 0; i < 32; i += 8) {
          // Extract 8 bytes as a slice
          const chunk = buffer.readBigUInt64LE(i);
          // Add the BigInt as a decimal string
          chunks.push(chunk.toString(10)); // Convert to decimal string for precision
        }

        sub.workers[minerId].pushMessage(
          'mining.notify', 
          null, 
          [
            id,
            chunks.map(BigInt),
            blockTemplate.timestamp,
          ],
        );
      }
    }
	}
}

/**
 * Variable difficulty
 **/
let VarDiff = (function () {
	let variance = config.poolServer.varDiff.variancePercent / 100 * config.poolServer.varDiff.targetTime;
	return {
		variance: variance,
		bufferSize: config.poolServer.varDiff.retargetTime / config.poolServer.varDiff.targetTime * 4,
		tMin: config.poolServer.varDiff.targetTime - variance,
		tMax: config.poolServer.varDiff.targetTime + variance,
		maxJump: config.poolServer.varDiff.maxJump
	};
})();

function GetRewardTypeAsKey (rewardType) {
	switch (rewardType) {
		case 'solo':
			return ':solo'
		case 'prop':
			return ''
		default:
			return ''
	}
}

/**
 * Miner
 **/
function Miner (subKey, rewardType, childRewardType, id, childPoolIndex, login, pass, childLogin, startingDiff, noRetarget, pushMessage) {
  this.subKey = subKey,
  this.rewardType = rewardType;
	this.childRewardType = childRewardType;
	this.rewardTypeAsKey = GetRewardTypeAsKey(rewardType);
	this.childRewardTypeAsKey = GetRewardTypeAsKey(childRewardType);

	this.lastChildBlockDaa = 0;
	this.id = id;
	this.activeChildPool = childPoolIndex || 0;
	this.login = login;
	this.pass = pass;

	this.workerName = 'undefined';
	this.childLogin = childLogin;

	this.pushMessage = pushMessage;
	this.heartbeat();
	this.noRetarget = noRetarget;
	this.difficulty = startingDiff;
	this.validJobs = [];
	this.workerName = pass;

	// Vardiff related variables
	this.shareTimeRing = utils.ringBuffer(16);
	this.lastShareTime = Date.now() / 1000 | 0;

	if (shareTrustEnabled) {
		this.trust = {
			threshold: config.poolServer.shareTrust.threshold,
			probability: 1,
			penalty: 0
		};
	}
}
Miner.prototype = {
	retarget: function (now) {

		let options = config.poolServer.varDiff;
		let sinceLast = now - this.lastShareTime;
		let decreaser = sinceLast > VarDiff.tMax;
		let avg = this.shareTimeRing.avg(decreaser ? sinceLast : null);
		let newDiff;
		let direction;

		if (avg > VarDiff.tMax && this.difficulty > options.minDiff) {
			newDiff = options.targetTime / avg * this.difficulty;
			newDiff = newDiff > options.minDiff ? newDiff : options.minDiff;
			direction = -1;
		} else if (avg < VarDiff.tMin && this.difficulty < options.maxDiff) {
			newDiff = options.targetTime / avg * this.difficulty;
			newDiff = newDiff < options.maxDiff ? newDiff : options.maxDiff;
			direction = 1;
		} else {
			return;
		}
		if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > options.maxJump) {
			let change = options.maxJump / 100 * this.difficulty * direction;
			newDiff = this.difficulty + change;
		}
		this.setNewDiff(newDiff);
		this.shareTimeRing.clear();
		if (decreaser) this.lastShareTime = now;
	},
	setNewDiff: function (newDiff) {
		if (this.difficulty === newDiff) { 
			return; 
		}
		log('info', logSystem, 'Retargeting difficulty %d to %d for %s.%s', [this.difficulty, newDiff, this.login, this.workerName]);
		this.difficulty = newDiff;
    this.pushMessage('mining.set_difficulty', null, [newDiff]);
	},
	heartbeat: function () {
		this.lastBeat = Date.now();
	},
  addJob: function (id) {
    const blockTemplate = currentBlockTemplate[this.activeChildPool];

    if (!blockTemplate) {
      throw new Error("No block template available for the current child pool.");
    }

    let newJob = {
			id: id,
			height: blockTemplate.header.daaScore,
			submissions: []
		};

    newJob.difficulty = this.difficulty;
		newJob.diffHex = this.diffHex;
		newJob.extraNonce = blockTemplate.extraNonce;

		while (this.validJobs.length > 20)
			this.validJobs.shift();

    this.validJobs.push(newJob);

    this.cachedJob = {
			jobId: id,
			id: this.id
		};

    this.cachedJob.blob = blockTemplate.blob;

    if (typeof config.includeAlgo !== "undefined" && config.includeAlgo) {
			this.cachedJob.algo = config.includeAlgo
		}
		if (typeof config.includeDaa !== "undefined" && config.includeDaa) {
			this.cachedJob.daa = blockTemplate.daa
		}

		if (newJob.seed_hash) {
			this.cachedJob.seed_hash = newJob.seed_hash;
			this.cachedJob.next_seed_hash = newJob.next_seed_hash;
		}

    // Extract buffer and timestamp from the block template
    const buffer = blockTemplate.buffer;
    const timestamp = Number(blockTemplate.header.timestamp); // Convert BigInt timestamp to number
  
    // Extract 8-byte chunks from the first 32 bytes of the buffer
    const chunks = [];
    for (let i = 0; i < 32; i += 8) {
      const chunk = buffer.readBigUInt64BE(i); // Read as a big-endian 8-byte unsigned integer
      chunks.push(chunk.toString(10)); // Convert BigInt to string in decimal
    }
  
    // Construct the job object
    const notify =
      [
        String(this.id), // Job ID as a string
        chunks.map(Number), // Convert decimal strings to numbers
        timestamp, // Timestamp as a decimal number
      ];
  
		return notify;
  },

	checkBan: function (validShare) {
		if (!banningEnabled) return;
		// Init global per-ip shares stats
		if (!perIPStats[this.ip]) {
			perIPStats[this.ip] = {
				validShares: 0,
				invalidShares: 0
			};
		}

		let stats = perIPStats[this.ip];
		validShare ? stats.validShares++ : stats.invalidShares++;

		if (stats.validShares + stats.invalidShares >= config.poolServer.banning.checkThreshold) {
			if (stats.invalidShares / stats.validShares >= config.poolServer.banning.invalidPercent / 100) {
				validShare ? this.validShares++ : this.invalidShares++;
				log('warn', logSystem, 'Banned %s@%s', [this.login, this.ip]);
				bannedIPs[this.ip] = Date.now();
				delete connectedMiners[this.id];
				process.send({
					type: 'banIP',
					ip: this.ip
				});
				removeConnectedWorker(this, 'banned');
			} else {
				stats.invalidShares = 0;
				stats.validShares = 0;
			}
		}
	}
};

validateMinerPaymentId_difficulty = (address, ip, poolServerConfig, coin, sendReply) => {
	if (utils.characterCount(address, '\\+') > 1) {
		let message = `Invalid paymentId specified for ${coin}login, ${ip}`;
		if (poolServerConfig.paymentId.validation) {
			process.send({
				type: 'banIP',
				ip: ip
			});
			message += ` banned for ${poolServerConfig.banning.time / 60} minutes`
		}
		sendReply(message);
		log('warn', logSystem, message);
		return false;
	}

	if (utils.characterCount(address, '\\.') > 1) {
		log('warn', logSystem, `Invalid difficulty specified for ${coin}login`);
		sendReply(`Invalid difficulty specified for ${coin}login, ${ip}`);
		return false;
	}
	return true;
}

/**
 * Handle miner method
 **/
function handleMinerMethod (method, params, socket, portData, sendReply, pushMessage) {
  const ip = socket.remoteAddress.replace(/^::ffff:/, '');;
  const remotePort = socket.remotePort;
	let miner = connectedMiners[params.id];

	// Check for ban here, so preconnected attackers can't continue to screw you
	if (IsBannedIp(ip)) {
		sendReply('Your IP is banned');
		return;
	}

	switch (method) {
    case 'mining.subscribe': {
      let agent = params[0];
      let subscriptionKey = `${ip}:${portData.port}:${remotePort}`; // Use double-pipe delimiter for the key
    
      if (!agent) {
        sendReply("Invalid subscription request: Missing miner agent.");
        return;
      }

    
      // Check if a subscription already exists for this IP + agent combination
      if (!connectedMiners[subscriptionKey]) {
        let subscriptionId = utils.uid(); // Unique ID for the subscription
    
        // Create a new subscription for this IP + agent
        connectedMiners[subscriptionKey] = {
          id: subscriptionId,
          ip,
          port: remotePort, 
          socket,
          agent,
          blockTemplate: null,
          workers: {}, // Initialize empty workers object
        };
      }
    
      // Respond with subscription details
      // Stratum protocol hardcoded for now
      sendReply(null, ["KaspaStratum/1.0.0"]);
      break;
    }

    case 'mining.authorize': {
      let fullParam = params[0];

      // Split `params[0]` into `login` and `pass` using the first occurrence of `..`
      let splitIndex = fullParam.indexOf(".");
      let login, workerName;
      
      if (splitIndex !== -1) {
        login = fullParam.slice(0, splitIndex); // Everything before the first `..`
        workerName = fullParam.slice(splitIndex + 1); // Everything after the first `..`
      } else {
        login = fullParam;
        workerName = "default";
      }

      // Generate a unique subscription key
      let subscriptionKey = `${ip}:${portData.port}:${remotePort}`;
    
      // Ensure the subscription exists
      if (!connectedMiners[subscriptionKey]) {
        sendReply("Subscription not found for IP and agent combination.");
        return;
      }
    
      // Create a new miner instance
      let minerId = utils.uid();
      let difficulty = portData.difficulty;
    
      const miner = new Miner(
        subscriptionKey,
        "prop", // rewardType
        "prop", // childRewardType
        minerId,
        0, // childPoolIndex
        login,
        params[3] || "",
        login, // childLogin
        difficulty,
        false, // noRetarget
        pushMessage
      );
    
      // Add the miner to the subscription's workers
      let eN = utils.generateExtraNonce(); // Generate an extra nonce
      let eNHex = eN.toString(16).padStart(6, "0").toLowerCase(); // 3-byte padded hex
      
      miner.ip = ip;
      miner.extraNonce = eNHex;
      miner.workerName = workerName;
      connectedMiners[subscriptionKey].workers[eNHex] = miner;

      newConnectedWorker(subscriptionKey, miner);

      // Respond with extranonce and difficulty
      sendReply(null, [true] );
      pushMessage('set_extranonce', null, [eNHex, 5]);
      pushMessage('mining.set_difficulty', null, [difficulty]);
    
      // Optional: Log new miner connection
      log('info', logSystem, `New miner authorized: ${login} from IP ${ip} with difficulty ${difficulty}`);
      break;
    }

		case 'mining.submit':
      let subscriptionKey = `${ip}:${portData.port}:${remotePort}`;
      let sub = connectedMiners[subscriptionKey];
    
      // Ensure the subscription exists
      if (!sub) {
        sendReply("Subscription not found for IP and agent combination.");
        return;
      }

      // Force lowercase for further comparison
			params[2] = params[2].toLowerCase();

      // Remove "0x" prefix if it exists
      let nonce = params[2].startsWith("0x") ? params[2].slice(2) : params[2];

      // Pad the nonce to ensure it is 8 bytes (16 hex characters)
      nonce = nonce.padStart(16, "0");

      // Slice the first 6 characters (3 bytes) to extract the extra nonce
      const nonceExtra = nonce.slice(0, 6);
      let miner = sub.workers[nonceExtra];

			if (!miner) {
        let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
        log('warn', logSystem, 'Invalid Extra Nonce: ' + JSON.stringify(params) + ' from ' + minerText);
				sendReply('Invalid Extra Nonce');
				return;
			}
			miner.heartbeat();
      
			let job = miner.validJobs.filter(function (job) {
				return job.id === params[1].toLowerCase();
			})[0];

			if (!job) {
        let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
        log('warn', logSystem, 'Invalid JobID: ' + JSON.stringify(params) + ' from ' + minerText);
				sendReply('Invalid JobId');
				return;
			}

			if (!params[2]) {
				sendReply('Attack detected');
				let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
				log('warn', logSystem, 'Malformed miner share: ' + JSON.stringify(params) + ' from ' + minerText);
				return;
			}

      if (job.submissions.indexOf(params[2]) !== -1) {
        let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
        log('warn', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
        perIPStats[miner.ip] = {
          validShares: 0,
          invalidShares: 999999
        };
        miner.checkBan(false);
        sendReply('Duplicate share');
        return;
      }

      job.submissions.push(params[2]);
      
    
			let isJobBlock = function (b) {
				return b.height === job.height && job.childHeight === (
					b.childBlockTemplate ? b.childBlockTemplate.height : undefined);
			};

			let blockTemplate = currentBlockTemplate[miner.activeChildPool];
			if (job.childHeight) {
				blockTemplate = isJobBlock(currentBlockTemplate[miner.activeChildPool]) ? currentBlockTemplate[miner.activeChildPool] : validBlockTemplates[miner.activeChildPool].filter(isJobBlock)[0];
			}
			if (!blockTemplate) {
				sendReply('Block expired');
				return;
			}

			let shareAccepted = processShare(miner, job, blockTemplate, params);
			miner.checkBan(shareAccepted);

			if (shareTrustEnabled) {
				if (shareAccepted) {
					miner.trust.probability -= shareTrustStepFloat;
					if (miner.trust.probability < shareTrustMinFloat)
						miner.trust.probability = shareTrustMinFloat;
					miner.trust.penalty--;
					miner.trust.threshold--;
				} else {
					log('warn', logSystem, 'Share trust broken by %s@%s', [miner.login, miner.ip]);
					miner.trust.probability = 1;
					miner.trust.penalty = config.poolServer.shareTrust.penalty;
				}
			}

			if (!shareAccepted) {
				sendReply('Low Difficulty');
				return;
			}

			let now = Date.now() / 1000 | 0;
			miner.shareTimeRing.append(now - miner.lastShareTime);
			miner.lastShareTime = now;

			sendReply(null, null, true);

			break;
		case 'keepalived':
			if (!miner) {
				sendReply('Unauthenticated');
				return;
			}
			miner.heartbeat();
			sendReply(null, {
				status: 'KEEPALIVED'
			});
			break;
		default:
			sendReply('Invalid method');
			let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
			log('warn', logSystem, 'Invalid method: %s (%j) from %s', [method, params, minerText]);
			break;
	}
}

/**
 * Handle a new connected worker.
 * @param {string} subscriptionKey - The subscription key (IP + agent).
 * @param {Miner} miner - The miner instance.
 */
function newConnectedWorker(subscriptionKey, miner) {
  const subscription = connectedMiners[subscriptionKey];
  if (!subscription) {
    console.error(`Subscription not found for key: ${subscriptionKey}`);
    return;
  }

  const { ip, port, agent } = subscription;
  const { login, workerName, difficulty } = miner;

  log('info', logSystem, `Miner connected ${login}@${ip}:${port} (${agent})`);
  if (workerName !== 'undefined') {
    log('info', logSystem, `Worker Name: ${workerName}`);
  }
  if (difficulty) {
    log('info', logSystem, `Miner difficulty fixed to ${difficulty}`);
  }

  // Add miner to workers
  subscription.workers[miner.extraNonce] = miner;

  // Redis updates for session-level tracking
  redisClient.sAdd(`${config.coin}:workers_ip:${login}`, `${ip}:${port}`); // Track IPs for login

  redisClient.hIncrBy(`${config.coin}:ports:${subscription.id}`, 'users', 1); // Increment port users
  redisClient.hIncrBy(
    `${config.coin}:active_sessions`,
    `${ip}:${port}||${agent}`,
    1,
    function (error, sessionCount) {
      if (sessionCount === 1) {
        log('info', logSystem, `New session started for ${ip}:${port} (${agent}).`);
      }
    }
  );
}

/**
 * Handle removing a connected worker.
 * @param {string} subscriptionKey - The subscription key (IP + agent).
 * @param {Miner} miner - The miner instance.
 * @param {string} reason - The reason for removal (e.g., 'banned', 'timeout').
 */
function removeConnectedWorker(miner, reason) {
  let subscriptionKey = miner.subKey;
  const subscription = connectedMiners[subscriptionKey];
  if (!subscription) {
    console.error(`Subscription not found for key: ${subscriptionKey}`);
    return;
  }

  const { ip, port, agent } = subscription;
  const { login, workerName } = miner;

  // Remove the worker from the subscription
  if (subscription.workers[miner.extraNonce]) {
    delete subscription.workers[miner.extraNonce];
  } else {
    log('warn', logSystem, `Attempted to remove non-existent worker with extraNonce ${miner.extraNonce} from subscription ${subscriptionKey}.`);
    return;
  }

  // Redis updates
  redisClient.hIncrBy(`${config.coin}:ports:${subscription.id}`, 'users', -1); // Decrement port users
  redisClient.hIncrBy(
    `${config.coin}:active_sessions`,
    `${ip}:${port}||${agent}`,
    -1,
    function (error, sessionCount) {
      if (error) {
        log('error', logSystem, `Redis error while decrementing active sessions: ${error}`);
      } else if (sessionCount === 0) {
        log('info', logSystem, `Session ended for ${ip}:${port} (${agent}).`);
      }
    }
  );

  if (reason === 'banned') {
    notifications.sendToMiner(login, 'workerBanned', {
      LOGIN: login,
      MINER: `${login.substring(0, 7)}...${login.substring(login.length - 7)}`,
      IP: ip.replace('::ffff:', ''),
      PORT: port,
      WORKER_NAME: workerName !== 'undefined' ? workerName : '',
    });
    log('warn', logSystem, `Miner ${login}@${ip}:${port} was banned.`);
  } else if (reason === 'timeout') {
    notifications.sendToMiner(login, 'workerTimeout', {
      LOGIN: login,
      MINER: `${login.substring(0, 7)}...${login.substring(login.length - 7)}`,
      IP: ip.replace('::ffff:', ''),
      PORT: port,
      WORKER_NAME: workerName !== 'undefined' ? workerName : '',
      LAST_SHARE: utils.dateFormat(new Date(miner.lastShareTime), 'yyyy-mm-dd HH:MM:ss Z'),
    });
    log('info', logSystem, `Miner ${login}@${ip}:${port} timed out.`);
  }
}

/**
 * Return if IP has been banned
 **/
function IsBannedIp (ip) {
	if (!banningEnabled || !bannedIPs[ip]) return false;

	let bannedTime = bannedIPs[ip];
	let bannedTimeAgo = Date.now() - bannedTime;
	let timeLeft = config.poolServer.banning.time * 1000 - bannedTimeAgo;
	if (timeLeft > 0) {
		return true;
	} else {
		delete bannedIPs[ip];
		log('info', logSystem, 'Ban dropped for %s', [ip]);
		return false;
	}
}

// const debugBlockJSON = {
//   login: 'waglayla:qr6h2tqwx8ad57nkte9kvcd9cqyjfgk30gznnza9jte7qzfa6gu0xy5n3evj5',
//   hash: '953d22e088219691277871bdec6a4e86045042c34e3e82d72133b987c23f6327',
//   height: 8318357n,
//   shareDiff: 43629183168468n,
// };

// async function debugBlock() {
//   const dateNow = Date.now();
//   const multi = redisClient.multi();

//   const coin = config.coin;

//   multi.hSet(`${coin}:stats`, `lastBlockFoundprop`, dateNow);
//   multi.rename(`${coin}:scores:prop:roundCurrent`, `${coin}:scores:prop:round${debugBlockJSON.height.toString(10)}`);
//   multi.rename(`${coin}:shares_actual:prop:roundCurrent`, `${coin}:shares_actual:prop:round${debugBlockJSON.height.toString(10)}`);
//   // if (rewardType === 'prop') {
//     multi.hGetAll(`${coin}:scores:prop:round${debugBlockJSON.height.toString(10)}`);
//     multi.hGetAll(`${coin}:shares_actual:prop:round${debugBlockJSON.height.toString(10)}`);
//   // }

//   const replies = await multi.exec();

//   const workerScores = replies[replies.length - 2];
//   const workerShares = replies[replies.length - 1];
//   let totalScore = 0;
//   let totalShares = 0;

//   // if (rewardType === 'prop') {
//     totalScore = Object.values(workerScores).reduce((p, c) => p + parseFloat(c), 0);
//     totalShares = Object.values(workerShares).reduce((p, c) => p + parseInt(c, 10), 0);
//   // }

//   await redisClient.zAdd(`${coin}:blocks:candidates`, {
//     score: debugBlockJSON.height.toString(10),
//     value: [
//       'prop',
//       debugBlockJSON.login,
//       debugBlockJSON.hash,
//       Math.floor(dateNow / 1000),
//       debugBlockJSON.shareDiff,
//       totalShares,
//       totalScore,
//     ].join('||'),
//   });

//   log('info', logSystem, "DEBUG: Block candidate added");
// }

// function delayedInterval(callback, interval, delay) {
//   setTimeout(() => {
//     callback();

//     setInterval(callback, interval);
//   }, delay);
// }

// delayedInterval(() => {
//   debugBlock();
// }, 60000, 50000);

async function recordShareData(miner, job, jobDiff, shareDiff, blockCandidate, hashHex, shareType, blockTemplate, pool) {
  try {
    const dateNow = Date.now();
    const dateNowSeconds = Math.floor(dateNow / 1000);
    const coin = pool !== null ? pool.coin : config.coin;
    const login = pool !== null ? miner.childLogin : miner.login;
    const jobHeight = pool !== null ? job.childHeight : job.height;
    const workerName = miner.workerName;
    const rewardType = pool !== null ? miner.childRewardType : miner.rewardType;
    const cleanupExpiration = 86400 * cleanupInterval;

    // Initialize multi
    const multi = redisClient.multi();

    // Weighting older shares lower than newer ones to prevent pool hopping
    if (slushMiningEnabled) {
      const age = (dateNow - await redisClient.hGet(`${coin}:stats`, 'lastBlockFound')) / 1000;
      const score = jobDiff * Math.exp(age / config.poolServer.slushMining.weight);
      multi.hIncrByFloat(`${coin}:scores:${rewardType}:roundCurrent`, login, score);
    } else {
      job.score = jobDiff;
      multi.hIncrByFloat(`${coin}:scores:${rewardType}:roundCurrent`, login, job.score);
    }

    // Base Redis commands
    multi.hIncrBy(`${coin}:shares_actual:${rewardType}:roundCurrent`, login, shareDiff);
    multi.zAdd(`${coin}:hashrate`, { score: dateNowSeconds, value: `${shareDiff}||${login}||${dateNow}||${rewardType}` });
    multi.hIncrBy(`${coin}:workers:${login}`, 'hashes', shareDiff);
    multi.hSet(`${coin}:workers:${login}`, 'lastShare', dateNowSeconds);
    multi.expire(`${coin}:workers:${login}`, cleanupExpiration);
    multi.expire(`${coin}:payments:${login}`, cleanupExpiration);

    // Worker-specific commands
    if (workerName) {
      multi.zAdd(`${coin}:hashrate`, { score: dateNowSeconds, value: `${shareDiff}||${login}~${workerName}||${dateNow}||${rewardType}` });
      multi.hIncrBy(`${coin}:unique_workers:${login}~${workerName}`, 'hashes', shareDiff);
      multi.hSet(`${coin}:unique_workers:${login}~${workerName}`, 'lastShare', dateNowSeconds);
      multi.expire(`${coin}:unique_workers:${login}~${workerName}`, cleanupExpiration);
    }

    // Block candidate handling
    if (blockCandidate) {
      multi.hSet(`${coin}:stats`, `lastBlockFound${rewardType}`, dateNow);
      multi.rename(`${coin}:scores:prop:roundCurrent`, `${coin}:scores:prop:round${jobHeight.toString(10)}`);
      multi.rename(`${coin}:shares_actual:prop:roundCurrent`, `${coin}:shares_actual:prop:round${jobHeight.toString(10)}`);
      if (rewardType === 'prop') {
        multi.hGetAll(`${coin}:scores:prop:round${jobHeight.toString(10)}`);
        multi.hGetAll(`${coin}:shares_actual:prop:round${jobHeight.toString(10)}`);
      }
    }

    // Execute the pipeline
    const replies = await multi.exec();

    if (slushMiningEnabled) {
      const score = parseFloat(replies[0]);
      const age = parseFloat(replies[1]);
      log('info', logSystem, `Submitted score ${score} for difficulty ${jobDiff} and round age ${age}s`);
    }

    if (blockCandidate) {
      const workerScores = replies[replies.length - 2];
      const workerShares = replies[replies.length - 1];
      let totalScore = 0;
      let totalShares = 0;

      if (rewardType === 'prop') {
        totalScore = Object.values(workerScores).reduce((p, c) => p + parseFloat(c), 0);
        totalShares = Object.values(workerShares).reduce((p, c) => p + parseInt(c, 10), 0);
      }

      await redisClient.zAdd(`${coin}:blocks:candidates`, {
        score: jobHeight.toString(10),
        value: [
          rewardType,
          login,
          hashHex,
          Math.floor(dateNow / 1000),
          shareDiff,
          totalShares,
          totalScore,
        ].join('||'),
      });

      notifications.sendToAll('blockFound', {
        HEIGHT: jobHeight,
        HASH: hashHex,
        DIFFICULTY: shareDiff,
        SHARES: totalShares,
        MINER: `${login.substring(0, 7)}...${login.substring(login.length - 7)}`,
      });
    }

    log('info', logSystem, `Accepted ${shareType} share at difficulty ${jobDiff}/${shareDiff} from ${login}@${miner.ip}`);
  } catch (err) {
    log('error', logSystem, `Failed to insert share data into Redis: ${err.message}`);

    if (err.replies && err.errorIndexes) {
        log('error', logSystem, `Pipeline replies: ${JSON.stringify(err.replies, null, 2)}`);
        log('error', logSystem, `Failed command indices: ${JSON.stringify(err.errorIndexes, null, 2)}`);
    }
  }
}


function getShareBuffer(miner, job, blockTemplate, params) {
  let nonce = params[2]; // The nonce provided in the parameters
  let reversedNonce = nonce.match(/.{2}/g).reverse().join(''); // Reverse byte order in groups of 2 hex digits

  // Prepare components
  let prePowHash = blockTemplate.prePowHash; // Hex string of blockTemplate.prePowHash
  let timestampHex = blockTemplate.timestamp.toString(16).padStart(16, "0"); // Pad timestamp to 8 bytes (16 hex characters)
  let zeroPadding = "0".repeat(64); // 32 zero-bytes in hex

  // Concatenate components into a single hex string
  let finalHex = prePowHash + timestampHex + zeroPadding + reversedNonce;

  // Convert the resulting hex string to a buffer
  try {
    let shareBuffer = Buffer.from(finalHex, 'hex');
    return shareBuffer;
  } catch (e) {
    log('error', logSystem, "Error creating share buffer for miner %s@%s with nonce %s: %s", [miner.login, miner.ip, nonce, e]);
    return null;
  }
}

/**
 * Process miner share data
 **/
function processShare (miner, job, blockTemplate, params) {
	let powState = new coinSDK.State(new coinSDK.Header(blockTemplate.header));

  let templateComp = Buffer.from(blockTemplate.buffer);
  
  let nonceHex = params[2].replace(/^0x/, ""); // Remove "0x" prefix if present
  let paddedNonceHex = nonceHex.padStart(16, "0");
  const bigNonce = BigInt(`0x${paddedNonceHex}`);
  
  // Pass the reversed nonce to checkPow
  let powResult = powState.checkPow(bigNonce);

  if (powResult[0]) {
    // Found a valid block
    blockTemplate.block.header.nonce = bigNonce;
    blockTemplate.block.header.hash = new coinSDK.Header(blockTemplate.block.header).finalize();
    const blockID = blockTemplate.block.header.hash

    let result = rpcClient.submitBlock({
      block: blockTemplate.block,
      allowNonDAABlocks: false,
    })
      .then((res) => {
        result = res;
        if (result.report.type === 'success') {
          log('info', logSystem,
            'Block %s found at height %d by miner %s.%s@%s',
            [blockID.substr(0, 6), blockTemplate.header.daaScore, miner.login, miner.workerName, miner.ip]
          );
          recordShareData(miner, job, miner.difficulty, ((1n << 256n)-1n)/powResult[1], true, blockID, 'valid', blockTemplate.block, null);
        } else {
          log('error', logSystem, 'Block submission from %s@%s rejected: "%s"', [miner.login, miner.ip, result.report.reason]);
        }
      })
    .catch((error) => {
      log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, e]);
    });

  } else {
    let poolTarget = coinSDK.calculateDifficulty(miner.difficulty);

    if (powResult[1] < poolTarget) {
      recordShareData(miner, job, miner.difficulty, ((1n << 256n)-1n)/powResult[1], false, null, 'valid', blockTemplate.block, null);
    } else {
      // Share does not meet pool difficulty
      log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [powResult[1].toString(16), miner.login, miner.ip]);
      return false;
    }
  }

	if (!job.childHeight) {
		return true;
	}

	var childBlockTemplate = blockTemplate.childBlockTemplate;

	if (childBlockTemplate) {
		return true;
	}
	return true;
}

/**
 * Start pool server on TCP ports
 **/
let httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nMining server online';

function startPoolServerTcp (callback) {
	log('info', logSystem, 'Clear values for connected workers in redis database.');
	redisClient.del(config.coin + ':active_connections');

	async.each(config.poolServer.ports, function (portData, cback) {
		let handleMessage = function (socket, jsonData, pushMessage) {
			if (!jsonData.id) {
				log('warn', logSystem, 'Miner RPC request missing RPC id');
				return;
			} else if (!jsonData.method) {
				log('warn', logSystem, 'Miner RPC request missing RPC method');
				return;
			} else if (!jsonData.params) {
				log('warn', logSystem, 'Miner RPC request missing RPC params');
				return;
			}

      let sendReply = function (error, params = null, result = null) {
        if (!socket.writable) return;
      
        let response = {
          id: jsonData.id,
          jsonrpc: "2.0",
          error: error ? {
            code: -1,
            message: error
          } : null
        };
      
        // Conditionally include params if present
        if (params !== null) {
          response.params = params;
        }
      
        // Conditionally include result if present
        if (result !== null) {
          response.result = result;
        }
      
        let sendData = JSON.stringify(response) + "\n";
      
        // console.log("sending,", sendData);
        socket.write(sendData);
      };

			handleMinerMethod(jsonData.method, jsonData.params, socket, portData, sendReply, pushMessage);
		};

		let socketResponder = function (socket) {
			socket.setKeepAlive(true);
			socket.setEncoding('utf8');

			let dataBuffer = '';

			let pushMessage = function (method, id, params) {
				if (!socket.writable) return;
				let sendData = JSONbig.stringify({
					jsonrpc: "2.0",
          id: id,
					method: method,
					params: params
				}) + "\n";

        // console.log("pushmessage sending,", sendData);
        socket.write(sendData);
			};

			socket.on('data', function (d) {
					dataBuffer += d;
					if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) { //10KB
						dataBuffer = null;
						log('warn', logSystem, 'Socket flooding detected and prevented from %s', [socket.remoteAddress]);
						socket.destroy();
						return;
					}
					if (dataBuffer.indexOf('\n') !== -1) {
						let messages = dataBuffer.split('\n');
						let incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
						for (let i = 0; i < messages.length; i++) {
							let message = messages[i];
							if (message.trim() === '') continue;
							let jsonData;
							try {
								jsonData = JSON.parse(message);
							} catch (e) {
								if (message.indexOf('GET /') === 0) {
									if (message.indexOf('HTTP/1.1') !== -1) {
										socket.end('HTTP/1.1' + httpResponse);
										break;
									} else if (message.indexOf('HTTP/1.0') !== -1) {
										socket.end('HTTP/1.0' + httpResponse);
										break;
									}
								}

								log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message]);
								socket.destroy();

								break;
							}
							try {
								handleMessage(socket, jsonData, pushMessage);
							} catch (e) {
								log('warn', logSystem, 'Malformed message from ' + socket.remoteAddress + ' generated an exception. Message: ' + message);
								if (e.message) log('warn', logSystem, 'Exception: ' + e.message);
							}
						}
						dataBuffer = incomplete;
					}
				})
				.on('error', function (err) {
					if (err.code !== 'ECONNRESET')
						log('warn', logSystem, 'Socket error from %s %j', [socket.remoteAddress, err]);
				})
				.on('close', function () {
					pushMessage = function () {};
				});
		};

		if (portData.ssl) {
			if (!config.poolServer.sslCert) {
				log('error', logSystem, 'Could not start server listening on port %d (SSL): SSL certificate not configured', [portData.port]);
				cback(true);
			} else if (!config.poolServer.sslKey) {
				log('error', logSystem, 'Could not start server listening on port %d (SSL): SSL key not configured', [portData.port]);
				cback(true);
			} else if (!fs.existsSync(config.poolServer.sslCert)) {
				log('error', logSystem, 'Could not start server listening on port %d (SSL): SSL certificate file not found (configuration error)', [portData.port]);
				cback(true);
			} else if (!fs.existsSync(config.poolServer.sslKey)) {
				log('error', logSystem, 'Could not start server listening on port %d (SSL): SSL key file not found (configuration error)', [portData.port]);
				cback(true);
			} else {
				let options = {
					key: fs.readFileSync(config.poolServer.sslKey),
					cert: fs.readFileSync(config.poolServer.sslCert),
				};

				if (config.poolServer.sslCA && fs.existsSync(config.poolServer.sslCA)) {
					options.ca = fs.readFileSync(config.poolServer.sslCA)
				}

				tls.createServer(options, socketResponder)
					.listen(portData.port, function (error, result) {
						if (error) {
							log('error', logSystem, 'Could not start server listening on port %d (SSL), error: $j', [portData.port, error]);
							cback(true);
							return;
						}

						log('info', logSystem, 'Clear values for SSL port %d in redis database.', [portData.port]);
            redisClient.del(`${config.coin}:ports:${portData.port}`);
            redisClient.hSet(`${config.coin}:ports:${portData.port}`, 'port', portData.port);

						log('info', logSystem, 'Started server listening on port %d (SSL)', [portData.port]);
						cback();
					});
			}
		} else {
			net.createServer(socketResponder)
				.listen(portData.port, function (error, result) {
					if (error) {
						log('error', logSystem, 'Could not start server listening on port %d, error: $j', [portData.port, error]);
						cback(true);
						return;
					}

					log('info', logSystem, 'Clear values for port %d in redis database.', [portData.port]);
          redisClient.del(`${config.coin}:ports:${portData.port}`);
          redisClient.hSet(`${config.coin}:ports:${portData.port}`, 'port', portData.port);

					log('info', logSystem, 'Started server listening on port %d', [portData.port]);
					cback();
				});
		}
	}, function (err) {
		if (err) {
			callback(false);
		} else {
			callback(true);
		}
	});
}

/**
 * Initialize pool server
 **/

(function init (loop) {
	async.waterfall([
			function (callback) {
				if (!poolStarted) {
					startPoolServerTcp(function (successful) {
						poolStarted = true
					});
					setTimeout(init, 1000, loop);
					return;
				}
				callback(true)
			}
		],
		function (err) {
			if (loop === true) {
				setTimeout(function () {
					init(true);
				}, config.poolServer.blockRefreshInterval);
			}
		}
	);
})();
