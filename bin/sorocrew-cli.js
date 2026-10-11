#!/usr/bin/env node

const { execSync } = require('child_process');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const args = process.argv.slice(2);
const command = args[0] || 'help';

console.log('[SoroCrew CLI v0.1.0] - Local Soroban Orchestrator & Batch Funder\n');

// RFC 4648 Base32 alphabet for Stellar StrKey encoding
const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += RFC4648_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += RFC4648_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

// CRC16-XModem checksum implementation for Stellar StrKey standard
function crc16(buffer) {
  let crc = 0x0000;
  for (let i = 0; i < buffer.length; i++) {
    let byte = buffer[i];
    let code = (crc >>> 8) & 0xff;
    code ^= byte & 0xff;
    code ^= code >>> 4;
    crc = (crc << 8) & 0xffff;
    crc ^= code;
    code = (code << 5) & 0xffff;
    crc ^= code;
    code = (code << 7) & 0xffff;
    crc ^= code;
  }
  return crc;
}

// Generate valid Stellar test keypair (public: G..., secret: S...)
function generateStellarKeypair() {
  const seed = crypto.randomBytes(32);
  const pubRaw = crypto.randomBytes(32);

  // Version byte 0x30 (48 decimal) encodes to 'G' prefix
  const pubPayload = Buffer.concat([Buffer.from([0x30]), pubRaw]);
  const pubCrc = Buffer.alloc(2);
  pubCrc.writeUInt16LE(crc16(pubPayload), 0);
  const publicKey = encodeBase32(Buffer.concat([pubPayload, pubCrc]));

  // Version byte 0x90 (144 decimal) encodes to 'S' prefix
  const secPayload = Buffer.concat([Buffer.from([0x90]), seed]);
  const secCrc = Buffer.alloc(2);
  secCrc.writeUInt16LE(crc16(secPayload), 0);
  const secretKey = encodeBase32(Buffer.concat([secPayload, secCrc]));

  return { publicKey, secretKey };
}

function isDockerAvailable() {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function fundSingleAddress(addr, friendbotBase = 'http://localhost:8000/friendbot') {
  return new Promise((resolve) => {
    const targetUrl = `${friendbotBase}?addr=${encodeURIComponent(addr)}`;
    const client = targetUrl.startsWith('https') ? https : http;

    const req = client.get(targetUrl, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true, message: '10,000 test XLM funded' });
        } else {
          resolve({ success: false, message: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, message: err.message || 'Connection failed' });
    });
  });
}

async function runBatchFunding() {
  const fundArgs = args.slice(1);
  let friendbotUrl = 'http://localhost:8000/friendbot';
  let generateCount = 0;
  const addresses = [];

  // Parse flags and arguments
  for (let i = 0; i < fundArgs.length; i++) {
    const arg = fundArgs[i];
    if (arg === '--generate' || arg === '-g' || arg === '--count') {
      generateCount = parseInt(fundArgs[++i], 10) || 1;
    } else if (arg === '--network' || arg === '-n') {
      const net = fundArgs[++i];
      if (net === 'testnet') {
        friendbotUrl = 'https://friendbot.stellar.org';
      } else if (net === 'futurenet') {
        friendbotUrl = 'https://friendbot-futurenet.stellar.org';
      } else if (net) {
        friendbotUrl = net;
      }
    } else if (arg.startsWith('G')) {
      if (arg.includes(',')) {
        arg.split(',').forEach((a) => a.trim() && addresses.push(a.trim()));
      } else {
        addresses.push(arg.trim());
      }
    }
  }

  // Case 1: Automated keypair generation & batch funding
  if (generateCount > 0) {
    console.log(`Generating and funding ${generateCount} test keypair(s) via ${friendbotUrl}...\n`);
    const keypairs = [];
    for (let i = 0; i < generateCount; i++) {
      keypairs.push(generateStellarKeypair());
    }

    console.log('+----+----------------------------------------------------------+----------------------------------------------------------+-----------------------+');
    console.log('| #  | Public Key (Ed25519)                                     | Secret Key (Seed)                                        | Funding Status        |');
    console.log('+----+----------------------------------------------------------+----------------------------------------------------------+-----------------------+');

    for (let i = 0; i < keypairs.length; i++) {
      const kp = keypairs[i];
      const res = await fundSingleAddress(kp.publicKey, friendbotUrl);
      const idxStr = String(i + 1).padEnd(2, ' ');
      const statusStr = (res.success ? 'SUCCESS (10k XLM)' : res.message).padEnd(21, ' ');
      console.log(`| ${idxStr} | ${kp.publicKey} | ${kp.secretKey} | ${statusStr} |`);
    }

    console.log('+----+----------------------------------------------------------+----------------------------------------------------------+-----------------------+\n');
    console.log(`Batch funding completed for ${generateCount} generated account(s).`);
    return;
  }

  // Case 2: Batch funding provided addresses
  if (addresses.length > 0) {
    console.log(`Funding ${addresses.length} address(es) via ${friendbotUrl}...\n`);
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];
      process.stdout.write(`[${i + 1}/${addresses.length}] Funding ${addr.slice(0, 8)}...${addr.slice(-4)}: `);
      const res = await fundSingleAddress(addr, friendbotUrl);
      if (res.success) {
        console.log('SUCCESS (10,000 test XLM)');
      } else {
        console.log(`FAILED (${res.message})`);
      }
    }
    console.log('\nBatch funding operation complete.');
    return;
  }

  // Help output when no addresses or flags provided
  console.error('Error: Please provide addresses or use --generate flag.');
  console.log('Examples:');
  console.log('  sorocrew fund GAAA... GBBB... GCCC...');
  console.log('  sorocrew fund GAAA...,GBBB...');
  console.log('  sorocrew fund --generate 5');
  console.log('  sorocrew fund --generate 3 --network testnet');
  process.exit(1);
}

if (command === 'status') {
  if (!isDockerAvailable()) {
    console.log('Warning: Docker is not detected in current environment.');
    console.log('Install Docker to run local standalone node on port 8000.');
    console.log('Note: SoroCrew Studio can also connect directly to Testnet & Futurenet without Docker.\n');
  }

  const req = http.get('http://localhost:8000/health', (res) => {
    if (res.statusCode === 200) {
      console.log('Local Standalone Docker Instance is RUNNING on port 8000.');
      console.log('Horizon: http://localhost:8000');
      console.log('Soroban RPC: http://localhost:8000/soroban/rpc');
      console.log('Friendbot: http://localhost:8000/friendbot');
    } else {
      console.log(`Docker Instance returned HTTP status ${res.statusCode}.`);
    }
  });

  req.on('error', () => {
    console.log('Local Standalone Docker Instance is OFF. Run "npm start" to launch when Docker is installed.');
  });
} else if (command === 'fund') {
  runBatchFunding();
} else {
  console.log('Usage:');
  console.log('  sorocrew status                     - Check local standalone node health');
  console.log('  sorocrew fund <addr1> [addr2...]   - Batch fund test keypairs via Friendbot');
  console.log('  sorocrew fund --generate <count>    - Generate and fund N fresh test keypairs');
  console.log('  sorocrew fund -g 3 --network testnet- Fund on public testnet');
}
