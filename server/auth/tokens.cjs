// Random tokens, hashing, and sealed (encrypted and authenticated) short-lived values for the sign-in flow.
const crypto = require('node:crypto');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function key(secret, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32));
}

// AES-256-GCM: the browser can hold the value but can neither read nor change it.
function seal(data, secret, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}

function unseal(value, secret, purpose) {
  try {
    const [iv, tag, body] = String(value).split('.').map(p => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(secret, purpose), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { randomToken, seal, sha256, unseal };
