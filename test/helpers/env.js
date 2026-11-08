const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('../../src/main/store');

// Stand-in for Electron safeStorage: real AES encryption with a test key.
function testCipher({ available = true, backend = 'test' } = {}) {
  const key = crypto.randomBytes(32);
  return {
    available: () => available,
    backend: () => backend,
    async encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    async decrypt(b64) {
      const buf = Buffer.from(b64, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

function tempDir(prefix = 'hostdeck-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeStore(opts) {
  const dir = tempDir();
  return { dir, store: new Store({ dir, cipher: testCipher(opts) }) };
}

module.exports = { testCipher, tempDir, makeStore };
