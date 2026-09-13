#!/usr/bin/env node
// Compute Chrome extension ID from a PEM private key.
// Same PEM => same ID => CRX upgrades keep settings.
// Usage: node tools/extid.js path/to/key.pem
const crypto = require('crypto');
const fs = require('fs');

const pemPath = process.argv[2];
if (!pemPath) {
  console.error('Usage: node tools/extid.js <key.pem>');
  process.exit(1);
}

const priv = crypto.createPrivateKey(fs.readFileSync(pemPath, 'utf8'));
const pub = crypto.createPublicKey(priv);
const spki = pub.export({ type: 'spki', format: 'der' });
const digest = crypto.createHash('sha256').update(spki).digest();
const hex = digest.subarray(0, 16).toString('hex');
const extId = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
console.log(extId);
