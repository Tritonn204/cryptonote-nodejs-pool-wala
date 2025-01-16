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
  constructor() {
    this.currentBlockTemplate = {};
    this.validBlockTemplates = {};
    this.validJobIDs = {};
  }

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

  generateJobID(indexOfChildPool) {
    if (!this.localJobCounters) {
      this.localJobCounters = {};
    }
  
    // Initialize the counter for the pool if it doesn't exist
    if (!this.localJobCounters[indexOfChildPool]) {
      this.localJobCounters[indexOfChildPool] = 0;
    }
  
    // Increment the counter and return it as a 4-byte hex string
    const jobID = this.localJobCounters[indexOfChildPool]++;
    return jobID.toString(16).padStart(8, "0"); // Ensure it's 8 characters long
  }

  process(template, indexOfChildPool) {
    // Parse the block template
    const header = new Header(template.block.header);
    const powState = new State(header);

    // Pre-compute the PoW hash
    const prePowHash = powState.prePowHash;

    // Compute timestampHex with padding
    let timestampHex = header.timestamp.toString(16);
    while (timestampHex.length < 16) {
      timestampHex = "0" + timestampHex; // Pad with leading zeroes
    }

    // Prepare the blob with padding and nonce space
    const padding64 = "0".repeat(64); // 64 zeroes
    const nonceSpace16 = "0".repeat(16); // 16 zeroes
    const templateBlob = prePowHash + timestampHex + padding64 + nonceSpace16;

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
    if (!this.validBlockTemplates[indexOfChildPool]) {
      this.validBlockTemplates[indexOfChildPool] = [];
    }
    if (!this.validJobIDs[indexOfChildPool]) {
      this.validJobIDs[indexOfChildPool] = [];
    }
  
    // Add the current template to the list of valid templates if one exists
    if (this.currentBlockTemplate[indexOfChildPool]) {
      this.validBlockTemplates[indexOfChildPool].push(this.currentBlockTemplate[indexOfChildPool]);
    }
  
    // Maintain a maximum of 3 valid block templates
    while (this.validBlockTemplates[indexOfChildPool].length > 3) {
      this.validBlockTemplates[indexOfChildPool].shift();
    }
  
    // Update the current block template for the pool
    this.currentBlockTemplate[indexOfChildPool] = template;

    // Generate a new job ID
    const newJobID = this.generateJobID(indexOfChildPool);

    // Add the new job ID to the valid job IDs list
    this.validJobIDs[indexOfChildPool].push(newJobID);

    // Maintain a maximum of 10 valid job IDs
    while (this.validJobIDs[indexOfChildPool].length > 10) {
      this.validJobIDs[indexOfChildPool].shift();
    }

    // Simulate job creation for testing
    const job = this.getJobForTesting(template, newJobID);

    // Log the job structure for verification
    console.log("Generated job structure for testing:", JSON.stringify(job, null, 2));
    
    // Notify connected miners about the new block template
    notifyConnectedMiners(indexOfChildPool);
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
let noncePattern = new RegExp("^[0-9A-Fa-f]{8}$");

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
let POOL_NONCE_SIZE = 16 + 1; // +1 for old XMR/new TRTL bugs
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
	for (let minerId in connectedMiners) {
		let miner = connectedMiners[minerId];
		if (!miner.noRetarget) {
			miner.retarget(now);
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
	let now = Date.now() / 1000 | 0;
	for (let minerId in connectedMiners) {
		let miner = connectedMiners[minerId];
		if (indexOfChildPool === miner.activeChildPool)
			miner.pushMessage('mining.notify', id, miner.getJob());
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
function Miner (rewardType, childRewardType, id, childPoolIndex, login, pass, ip, port, agent, childLogin, startingDiff, noRetarget, pushMessage) {
	this.rewardType = rewardType;
	this.childRewardType = childRewardType;
	this.rewardTypeAsKey = GetRewardTypeAsKey(rewardType);
	this.childRewardTypeAsKey = GetRewardTypeAsKey(childRewardType);

	this.lastChildBlockHeight = 0;
	this.id = id;
	this.activeChildPool = childPoolIndex || 0;
	this.login = login;
	this.pass = pass;
	this.ip = ip;
	this.port = port;
	this.proxy = false;
	if (agent && agent.includes('xmr-node-proxy')) {
		this.proxy = true;
	}
	this.workerName = 'undefined';
	this.childLogin = childLogin;
	if (pass.lastIndexOf('@') >= 0 && pass.lastIndexOf('@') < pass.length) {
		passDelimiterPos = pass.lastIndexOf('@') + 1;
		this.workerName = pass.substr(passDelimiterPos, pass.length)
			.trim();
	}
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
		log('info', logSystem, 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login]);
		this.pendingDifficulty = newDiff;
    this.pushMessage('mining.set_difficulty', null, newDiff);
	},
	heartbeat: function () {
		this.lastBeat = Date.now();
	},
	getTargetHex: function () {
		if (this.pendingDifficulty) {
			this.lastDifficulty = this.difficulty;
			this.difficulty = this.pendingDifficulty;
			this.pendingDifficulty = null;
		}
		let padded = Buffer.alloc(32);
		padded.fill(0);
		let diffBuff = diff1.div(this.difficulty).toBuffer();
		diffBuff.copy(padded, 32 - diffBuff.length);
		let buff = padded.slice(0, 4);
		let buffArray = buff.toByteArray().reverse();
		let buffReversed = Buffer.from(buffArray);
		this.target = buffReversed.readUInt32BE(0);
		let hex = buffReversed.toString('hex');
		return hex;
	},
  getJob: function () {
    const blockTemplate = currentBlockTemplate[this.activeChildPool];
  
    // Ensure a valid block template exists
    if (!blockTemplate) {
      throw new Error("No block template available for the current child pool.");
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
    const job =
      [
        String(this.id), // Job ID as a string
        chunks.map(Number), // Convert decimal strings to numbers
        timestamp, // Timestamp as a decimal number
      ];
  
    log('info', logSystem, `"New Job Sent:, ${job}`);

    // Cache the job for reuse
    this.cachedJob = job;
  
    return this.cachedJob;
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
function handleMinerMethod (method, params, ip, portData, sendReply, pushMessage) {
	let miner = connectedMiners[params.id];

	// Check for ban here, so preconnected attackers can't continue to screw you
	if (IsBannedIp(ip)) {
		sendReply('Your IP is banned');
		return;
	}

	switch (method) {
		case 'login':
			let login = params.login;
			if (!login) {
				sendReply('Missing login');
				return;
			}

			if (!validateMinerPaymentId_difficulty(login, ip, config.poolServer, 'parent ', sendReply))
			{
				return;
			}

			let calculated = utils.determineRewardData(login);
			login = calculated.address;
			let rewardType = calculated.rewardType;

			let address = '';
			let paymentid = null;
			let port = portData.port;
			let pass = params.pass;
			let childLogin = pass.trim();
			let childPoolIndex = 0;
			let childRewardType = rewardType;

			let difficulty = portData.difficulty;
			let noRetarget = false;
			if (config.poolServer.fixedDiff.enabled) {
				let fixedDiffCharPos = login.lastIndexOf(config.poolServer.fixedDiff.addressSeparator);
				if (fixedDiffCharPos !== -1 && (login.length - fixedDiffCharPos < 32)) {
					diffValue = login.substr(fixedDiffCharPos + 1);
					difficulty = parseInt(diffValue);
					login = login.substr(0, fixedDiffCharPos);
					if (!difficulty || difficulty != diffValue) {
						log('warn', logSystem, 'Invalid difficulty value "%s" for login: %s', [diffValue, login]);
						difficulty = portData.difficulty;
					} else {
						noRetarget = true;
						if (difficulty < config.poolServer.varDiff.minDiff) {
							difficulty = config.poolServer.varDiff.minDiff;
						}
					}
				}
			}

			addr = login.split(config.poolServer.paymentId.addressSeparator);
			address = addr[0] || null;
			paymentId = addr[1] || null;
			if (!address) {
				log('warn', logSystem, 'No address specified for login');
				sendReply('Invalid address used for login');
				return
			}

			if (paymentId && paymentId.match('^([a-zA-Z0-9]){0,15}$')) {
				if (config.poolServer.paymentId.validation) {
					process.send({
						type: 'banIP',
						ip: ip
					});
					log('warn', logSystem, 'Invalid paymentId specified for login');
				} else {
					log('warn', logSystem, 'Invalid paymentId specified for login');
				}
				sendReply(`Invalid paymentId specified for login, ${portData.ip} banned for ${config.poolServer.banning.time / 60} minutes`);
				return;
			}

			if (!utils.validateMinerAddress(address)) {
				let addressPrefix = utils.getAddressPrefix(address);
				if (!addressPrefix) addressPrefix = 'N/A';

				log('warn', logSystem, 'Invalid address used for login (prefix: %s): %s', [addressPrefix, address]);
				sendReply('Invalid address used for login');
				return;
			}

			let minerId = utils.uid();
			miner = new Miner(rewardType, childRewardType, minerId, childPoolIndex, login, pass, ip, port, params.agent, childLogin, difficulty, noRetarget, pushMessage);
			connectedMiners[minerId] = miner;

			sendReply(null, {
				id: minerId,
				job: miner.getJob(),
				status: 'OK'
			});

			newConnectedWorker(miner);
			break;
		case 'getjob':
			if (!miner) {
				sendReply('Unauthenticated');
				return;
			}
			miner.heartbeat();
			sendReply(null, miner.getJob());
			break;
		case 'submit':
			if (!miner) {
				sendReply('Unauthenticated');
				return;
			}
			miner.heartbeat();

			let job = miner.validJobs.filter(function (job) {
				return job.id === params.job_id;
			})[0];

			if (!job) {
				sendReply('Invalid job id');
				return;
			}

			if (!params.nonce || !params.result) {
				sendReply('Attack detected');
				let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
				log('warn', logSystem, 'Malformed miner share: ' + JSON.stringify(params) + ' from ' + minerText);
				return;
			}

			if (!noncePattern.test(params.nonce)) {
				let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
				log('warn', logSystem, 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + minerText);
				perIPStats[miner.ip] = {
					validShares: 0,
					invalidShares: 999999
				};
				miner.checkBan(false);
				sendReply('Duplicate share1');
				return;
			}

			// Force lowercase for further comparison
			params.nonce = params.nonce.toLowerCase();

			if (!miner.proxy) {
				if (job.submissions.indexOf(params.nonce) !== -1) {
					let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
					log('warn', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
					perIPStats[miner.ip] = {
						validShares: 0,
						invalidShares: 999999
					};
					miner.checkBan(false);
					sendReply('Duplicate share2');
					return;
				}

				job.submissions.push(params.nonce);
			} else {
				if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {
					let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
					log('warn', logSystem, 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + minerText);
					perIPStats[miner.ip] = {
						validShares: 0,
						invalidShares: 999999
					};
					miner.checkBan(false);
					sendReply('Duplicate share3');
					return;
				}
				let nonce_test = `${params.nonce}_${params.poolNonce}_${params.workerNonce}`;
				if (job.submissions.indexOf(nonce_test) !== -1) {
					let minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
					log('warn', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
					perIPStats[miner.ip] = {
						validShares: 0,
						invalidShares: 999999
					};
					miner.checkBan(false);
					sendReply('Duplicate share4');
					return;
				}
				job.submissions.push(nonce_test);

			}

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
				sendReply('Rejected share: invalid result');
				return;
			}

			let now = Date.now() / 1000 | 0;
			miner.shareTimeRing.append(now - miner.lastShareTime);
			miner.lastShareTime = now;

			sendReply(null, {
				status: 'OK'
			});
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
 * New connected worker
 **/
function newConnectedWorker (miner) {
	log('info', logSystem, 'Miner connected %s@%s on port', [miner.login, miner.ip, miner.port]);
	if (miner.workerName !== 'undefined') log('info', logSystem, 'Worker Name: %s', [miner.workerName]);
	if (miner.difficulty) log('info', logSystem, 'Miner difficulty fixed to %s', [miner.difficulty]);

	redisClient.sadd(`${config.coin}:workers_ip:${miner.login}`, miner.ip);
	redisClient.hincrby(`${config.coin}:ports:${miner.port}`, 'users', 1);

	redisClient.hincrby(`${config.coin}:active_connections${miner.rewardTypeAsKey}`, `${miner.login}~${miner.workerName}`, 1, function (error, connectedWorkers) {
		if (connectedWorkers === 1) {
			notifications.sendToMiner(miner.login, 'workerConnected', {
				'LOGIN': miner.login,
				'MINER': `${miner.login.substring(0,7)}...${miner.login.substring(miner.login.length-7)}`,
				'IP': miner.ip.replace('::ffff:', ''),
				'PORT': miner.port,
				'WORKER_NAME': miner.workerName !== 'undefined' ? miner.workerName : ''
			});
		}
	});
}

/**
 * Remove connected worker
 **/
function removeConnectedWorker (miner, reason) {
	redisClient.hincrby(`${config.coin}:ports:${miner.port}`, 'users', '-1');

	redisClient.hincrby(`${config.coin}:active_connections${miner.rewardTypeAsKey}`, `${miner.login}~${miner.workerName}`, -1, function (error, connectedWorkers) {
		if (reason === 'banned') {
			notifications.sendToMiner(miner.login, 'workerBanned', {
				'LOGIN': miner.login,
				'MINER': `${miner.login.substring(0,7)}...${miner.login.substring(miner.login.length-7)}`,
				'IP': miner.ip.replace('::ffff:', ''),
				'PORT': miner.port,
				'WORKER_NAME': miner.workerName !== 'undefined' ? miner.workerName : ''
			});
		} else if (!connectedWorkers || connectedWorkers <= 0) {
			notifications.sendToMiner(miner.login, 'workerTimeout', {
				'LOGIN': miner.login,
				'MINER': `${miner.login.substring(0,7)}...${miner.login.substring(miner.login.length-7)}`,
				'IP': miner.ip.replace('::ffff:', ''),
				'PORT': miner.port,
				'WORKER_NAME': miner.workerName !== 'undefined' ? miner.workerName : '',
				'LAST_HASH': utils.dateFormat(new Date(miner.lastBeat), 'yyyy-mm-dd HH:MM:ss Z')
			});
		}
	});
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

function recordShareData (miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate, pool) {
	let dateNow = Date.now();
	let dateNowSeconds = dateNow / 1000 | 0;
	let coin = pool !== null ? pool.coin : config.coin;
	let login = pool !== null ? miner.childLogin : miner.login;
	let job_height = pool !== null ? job.childHeight : job.height;
	let workerName = miner.workerName;
	let rewardType = pool !== null ? miner.childRewardType : miner.rewardType;
	let updateScore;
	// Weighting older shares lower than newer ones to prevent pool hopping
	if (slushMiningEnabled) {
		// We need to do this via an eval script because we need fetching the last block time and
		// calculating the score to run in a single transaction (otherwise we could have a race
		// condition where a block gets discovered between the time we look up lastBlockFound and
		// insert the score, which would give the miner an erroneously huge proportion on the new block)
		updateScore = ['eval', `
            local age = (ARGV[3] - redis.call('hget', KEYS[2], 'lastBlockFound')) / 1000
            local score = string.format('%.17g', ARGV[2] * math.exp(age / ARGV[4]))
            redis.call('hincrbyfloat', KEYS[1], ARGV[1], score)
            return {score, tostring(age)}
            `,
			2 /*keys*/ , coin + ':scores:roundCurrent', coin + ':stats',
			/* args */
			login, job.difficulty, Date.now(), config.poolServer.slushMining.weight
		];
	} else {
		job.score = job.difficulty;
		updateScore = ['hincrbyfloat', `${coin}:scores:${rewardType}:roundCurrent`, login, job.score]
	}

	let redisCommands = [
		updateScore,
		['hincrby', `${coin}:shares_actual:${rewardType}:roundCurrent`, login, job.difficulty],
		['zadd', `${coin}:hashrate`, dateNowSeconds, [job.difficulty, login, dateNow, rewardType].join(':')],
		['hincrby', `${coin}:workers:${login}`, 'hashes', job.difficulty],
		['hset', `${coin}:workers:${login}`, 'lastShare', dateNowSeconds],
		['expire', `${coin}:workers:${login}`, (86400 * cleanupInterval)],
		['expire', `${coin}:payments:${login}`, (86400 * cleanupInterval)]
	];

	if (workerName) {
		redisCommands.push(['zadd', `${coin}:hashrate`, dateNowSeconds, [job.difficulty, login + '~' + workerName, dateNow, rewardType].join(':')]);
		redisCommands.push(['hincrby', `${coin}:unique_workers:${login}~${workerName}`, 'hashes', job.difficulty]);
		redisCommands.push(['hset', `${coin}:unique_workers:${login}~${workerName}`, 'lastShare', dateNowSeconds]);
		redisCommands.push(['expire', `${coin}:unique_workers:${login}~${workerName}`, (86400 * cleanupInterval)]);
	}

	if (blockCandidate) {
		redisCommands.push(['hset', `${coin}:stats`, `lastBlockFound${rewardType}`, Date.now()]);
		redisCommands.push(['rename', `${coin}:scores:prop:roundCurrent`, coin + ':scores:prop:round' + job_height]);
		redisCommands.push(['rename', `${coin}:scores:solo:roundCurrent`, coin + ':scores:solo:round' + job_height]);
		redisCommands.push(['rename', `${coin}:shares_actual:prop:roundCurrent`, `${coin}:shares_actual:prop:round${job_height}`]);
		redisCommands.push(['rename', `${coin}:shares_actual:solo:roundCurrent`, `${coin}:shares_actual:solo:round${job_height}`]);
		if (rewardType === 'prop') {
			redisCommands.push(['hgetall', `${coin}:scores:prop:round${job_height}`]);
			redisCommands.push(['hgetall', `${coin}:shares_actual:prop:round${job_height}`]);
		}
		if (rewardType === 'solo') {
			redisCommands.push(['hget', `${coin}:scores:solo:round${job_height}`, login]);
			redisCommands.push(['hget', `${coin}:shares_actual:solo:round${job_height}`, login]);
		}

	}

	redisClient.multi(redisCommands)
		.exec(function (err, replies) {
			if (err) {
				log('error', logSystem, 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
				return;
			}

			if (slushMiningEnabled) {
				job.score = parseFloat(replies[0][0]);
				let age = parseFloat(replies[0][1]);
				log('info', logSystem, 'Submitted score ' + job.score + ' for difficulty ' + job.difficulty + ' and round age ' + age + 's');
			}

			if (blockCandidate) {
				let workerScores = replies[replies.length - 2];
				let workerShares = replies[replies.length - 1];
				let totalScore = 0;
				let totalShares = 0;
				if (rewardType === 'solo') {
					totalScore = workerScores
					totalShares = workerShares
				}
				if (rewardType === 'prop') {
					totalScore = Object.keys(workerScores)
						.reduce(function (p, c) {
							return p + parseFloat(workerScores[c])
						}, 0);
					totalShares = Object.keys(workerShares)
						.reduce(function (p, c) {
							return p + parseInt(workerShares[c])
						}, 0);
				}
				redisClient.zadd(coin + ':blocks:candidates', job_height, [
					rewardType,
					login,
					hashHex,
					Date.now() / 1000 | 0,
					blockTemplate.difficulty,
					totalShares,
					totalScore
				].join(':'), function (err, result) {
					if (err) {
						log('error', logSystem, 'Failed inserting block candidate %s \n %j', [hashHex, err]);
					}
				});

				notifications.sendToAll('blockFound', {
					'HEIGHT': job_height,
					'HASH': hashHex,
					'DIFFICULTY': blockTemplate.difficulty,
					'SHARES': totalShares,
					'MINER': login.substring(0, 7) + '...' + login.substring(login.length - 7)
				});
			}

		});

	log('info', logSystem, 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty, shareDiff, login, miner.ip]);
}

function getShareBuffer (miner, job, blockTemplate, params) {
	let nonce = params.nonce;
	let resultHash = params.result;
	let template = Buffer.alloc(blockTemplate.buffer.length);
	if (!miner.proxy) {
		blockTemplate.buffer.copy(template);
		template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
	} else {
		blockTemplate.buffer.copy(template);
		template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
		template.writeUInt32BE(params.poolNonce, job.clientPoolLocation);
		template.writeUInt32BE(params.workerNonce, job.clientNonceLocation);
	}

	try {
	    let shareBuffer = utils.cnUtil.construct_block_blob(template, Buffer.from(nonce, 'hex'), cnBlobType);
		return shareBuffer;
	} catch (e) {
		log('error', logSystem, "Can't get share buffer with nonce %s from %s@%s: %s", [nonce, miner.login, miner.ip, e]);
		return null;
	}
}

/**
 * Process miner share data
 **/
function processShare (miner, job, blockTemplate, params) {
	let shareBuffer = getShareBuffer(miner, job, blockTemplate, params)
	if (!shareBuffer) {
		return false
	}
	let resultHash = params.result
	let hash;
	let shareType;

	if (shareTrustEnabled && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 && Math.random() > miner.trust.probability) {
		hash = Buffer.from(resultHash, 'hex');
		shareType = 'trusted';
	} else {
	    let convertedBlob = utils.cnUtil.convert_blob(shareBuffer, cnBlobType);
		let hard_fork_version = convertedBlob[0];

		if (blockTemplate.isRandomX) {
			hash = cryptoNight(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), cnVariant);
		} else {
			if (typeof config.includeHeight !== "undefined" && config.includeHeight)
				hash = cryptoNight(convertedBlob, cnVariant, job.height);
			else
				hash = cryptoNight(convertedBlob, cnVariant);
		}
		log('info', logSystem, 'Mining pool algorithm: %s variant %d, Hard fork version: %d', [cnAlgorithm, cnVariant, hard_fork_version]);
		shareType = 'valid'
	}

	if (hash.toString('hex') !== resultHash) {
		log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
		return false;
	}

	let hashArray = hash.toByteArray()
		.reverse();
	let hashNum = bignum.fromBuffer(Buffer.from(hashArray));
	let hashDiff = diff1.div(hashNum);

	if (hashDiff.ge(blockTemplate.difficulty)) {

		apiInterfaces.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function (error, result) {
			if (error) {
				log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
			} else {
			    let blockFastHash = utils.cnUtil.get_block_id(shareBuffer, cnBlobType).toString('hex');
				log('info', logSystem,
					'Block %s found at height %d by miner %s@%s - submit result: %j',
					[blockFastHash.substr(0, 6), job.height, miner.login, miner.ip, result]
				);
				recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate, null);
			}
		});
	} else if (hashDiff.lt(job.difficulty)) {
		log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip]);
		return false;
	} else {
		recordShareData(miner, job, hashDiff.toString(), false, null, shareType, null, null);
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

			let sendReply = function (error, result) {
				if (!socket.writable) return;
				let sendData = JSON.stringify({
					id: jsonData.id,
					jsonrpc: "2.0",
					error: error ? {
						code: -1,
						message: error
					} : null,
					result: result
				}) + "\n";
				socket.write(sendData);
			};

			handleMinerMethod(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
		};

		let socketResponder = function (socket) {
			socket.setKeepAlive(true);
			socket.setEncoding('utf8');

			let dataBuffer = '';

			let pushMessage = function (method, id, params) {
				if (!socket.writable) return;
				let sendData = JSON.stringify({
					jsonrpc: "2.0",
          id: id,
					method: method,
					params: params
				}) + "\n";
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
