// Address.js
// JavaScript implementation of the Bech32 encoding and decoding module

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const REV_CHARSET = Array(123).fill(100);
for (let i = 0; i < CHARSET.length; i++) {
    REV_CHARSET[CHARSET.charCodeAt(i)] = i;
}

// Polymod function for Bech32 checksum
function polymod(values) {
  let c = 1n; // Use BigInt for 64-bit calculations
  const GENERATORS = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ];

  for (const d of values) {
    const c0 = c >> 35n; // Extract the top 5 bits
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d); // Ensure `d` is converted to BigInt

    for (let i = 0; i < 5; i++) {
      if ((c0 >> BigInt(i)) & 1n) {
        c ^= GENERATORS[i];
      }
    }
  }
  return c ^ 1n; // Final XOR operation
}

// Checksum function
function checksum(payload, prefix) {
  const prefixValues = Array.from(prefix).map((c) => c.charCodeAt(0) & 0x1f);
  const values = [
    ...prefixValues,
    0, // Separator
    ...payload.map((x) => x), // Ensure payload is 5-bit
    0, 0, 0, 0, 0, 0, 0, 0, // Padding
  ];

  const result = polymod(values);

  // console.log('Prefix Values:', prefixValues);
  // console.log('Payload Values:', payload);
  // console.log('Checksum (raw):', result.toString(16));

  return result;
}


// Convert an 8-bit array to 5-bit array
function conv8to5(payload) {
    const fiveBit = [];
    let buffer = 0;
    let bits = 0;

    for (const byte of payload) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            fiveBit.push((buffer >> bits) & 0x1f);
        }
    }

    if (bits > 0) {
        fiveBit.push((buffer << (5 - bits)) & 0x1f);
    }

    return fiveBit;
}

// Convert a 5-bit array to 8-bit array
function conv5to8(payload) {
    const eightBit = [];
    let buffer = 0;
    let bits = 0;

    for (const value of payload) {
        buffer = (buffer << 5) | value;
        bits += 5;
        while (bits >= 8) {
            bits -= 8;
            eightBit.push((buffer >> bits) & 0xff);
        }
    }

    return eightBit;
}

// Address class
class Address {
    constructor(prefix, version, payload) {
        this.prefix = prefix;
        this.version = version;
        this.payload = payload;
    }

    encodePayload() {
      const payloadWithVersion = [this.version, ...this.payload]; // Regular numbers
      const fiveBitPayload = conv8to5(payloadWithVersion); // 5-bit conversion
    
      // Pass fiveBitPayload to checksum
      const checksumValue = checksum(fiveBitPayload, this.prefix);
    
      // Compute checksum bytes
      const checksumBytes = [
        Number((checksumValue >> 35n) & 0x1fn),
        Number((checksumValue >> 30n) & 0x1fn),
        Number((checksumValue >> 25n) & 0x1fn),
        Number((checksumValue >> 20n) & 0x1fn),
        Number((checksumValue >> 15n) & 0x1fn),
        Number((checksumValue >> 10n) & 0x1fn),
        Number((checksumValue >> 5n) & 0x1fn),
        Number(checksumValue & 0x1fn),
      ];
    
      // Combine payload and checksum
      const combined = [...fiveBitPayload, ...checksumBytes];
      return `${this.prefix}:${combined.map((c) => CHARSET[c]).join('')}`;
    }

    static decodePayload(prefix, address) {
        const [decodedPrefix, data] = address.split(':');
        if (decodedPrefix !== prefix) {
            throw new Error(`Invalid prefix: expected ${prefix}, got ${decodedPrefix}`);
        }

        const payloadWithChecksum = Array.from(data).map((c) => {
            const value = REV_CHARSET[c.charCodeAt(0)];
            if (value === 100) {
                throw new Error(`Invalid character in address: ${c}`);
            }
            return value;
        });

        const payload = payloadWithChecksum.slice(0, -6);
        const checksumBytes = payloadWithChecksum.slice(-6);

        const expectedChecksum = checksum(payload, prefix);
        const actualChecksum = (checksumBytes[0] << 25) | (checksumBytes[1] << 20) | (checksumBytes[2] << 15) | (checksumBytes[3] << 10) | (checksumBytes[4] << 5) | checksumBytes[5];

        if (expectedChecksum !== actualChecksum) {
            throw new Error('Invalid checksum');
        }

        const payloadWithVersion = conv5to8(payload);
        const version = payloadWithVersion[0];
        const payloadData = payloadWithVersion.slice(1);

        return new Address(prefix, version, payloadData);
    }
}

module.exports = { Address, conv8to5, conv5to8, checksum, polymod };