// Shared setup for the deliberate database commands (db:setup, admin:bootstrap, db:migrate-request-types, beta:seed).
// Reads settings like the server (a local .env never overrides existing values), requires --confirm-db to
// name the target database exactly, and never prints the connection string.
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { ConfigError, loadDatabaseConfig, loadEnvFile } = require('../server/config.cjs');
const { redact, secretsFromUri } = require('../server/redact.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`Unexpected argument: ${argv[i]}`);
    args[m[1]] = m[2] !== undefined ? m[2] : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

async function runDbCommand(usage, run) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`${err.message}\n${usage}`); process.exit(2); }

  const envFile = process.env.JARCTECH_ENV_FILE ?? path.join(__dirname, '..', '.env');
  if (process.env.NODE_ENV !== 'test' && envFile !== 'none') loadEnvFile(envFile);

  let database;
  try { database = loadDatabaseConfig(process.env); }
  catch (err) { if (!(err instanceof ConfigError)) throw err; console.error(err.message); process.exit(1); }
  if (args['confirm-db'] !== database.name) {
    console.error(`Refusing to run: pass --confirm-db ${database.name} to confirm the target database named in MONGODB_DB_NAME.\n${usage}`);
    process.exit(2);
  }

  const secrets = secretsFromUri(database.uri);
  const client = new MongoClient(database.uri, { appName: 'jarctech-ticket-cli', serverSelectionTimeoutMS: 10000 });
  try {
    await run(client.db(database.name), args, database.name);
  } catch (err) {
    console.error(redact(err.exitMessage || `${err.name}: ${err.message}`, secrets));
    process.exitCode = err.exitCode || 1;
  } finally {
    await client.close();
  }
}

function fail(message, exitCode = 1) {
  const err = new Error(message); err.exitMessage = message; err.exitCode = exitCode;
  return err;
}

module.exports = { fail, parseArgs, runDbCommand };
