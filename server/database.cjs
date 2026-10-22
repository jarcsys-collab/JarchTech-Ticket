// MongoDB connection for the configured database. Nothing is read or written yet; the server only checks
// reachability with a ping. The driver connects lazily on the first command.
const { MongoClient } = require('mongodb');
const { redact, secretsFromUri } = require('./redact.cjs');

const SERVER_SELECTION_TIMEOUT_MS = 5000;

// Used when no database is configured (browser-only prototype mode).
const notConfigured = Object.freeze({
  configured: false,
  name: null,
  async ping() { return { ok: false, reason: 'not-configured' }; },
  async close() {},
  redact: text => redact(text)
});

function createDatabase(config) {
  if (!config) return notConfigured;
  const secrets = secretsFromUri(config.uri);
  let client;
  try {
    client = new MongoClient(config.uri, { appName: 'jarctech-ticket', serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
  } catch (err) {
    // Parse errors can quote the connection string, so only the redacted message leaves this module.
    throw new Error('MONGODB_URI could not be used: ' + redact(err.message, secrets));
  }
  let closed = false;
  return {
    configured: true,
    name: config.name,
    db: () => client.db(config.name),
    async ping(timeoutMS = 2000) {
      if (closed) return { ok: false, reason: 'closed' };
      try {
        await client.db(config.name).command({ ping: 1 }, { timeoutMS });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: 'unreachable', error: redact(`${err.name}: ${err.message}`, secrets) };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
    redact: text => redact(text, secrets)
  };
}

module.exports = { createDatabase };
