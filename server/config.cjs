// Reads and validates server settings from environment variables.
// Problems name the variable but never repeat its value, so secrets cannot leak into logs.
const fs = require('node:fs');
const net = require('node:net');
const { parseEnv } = require('node:util');

const DEFAULT_PORT = 4175;
const RAILWAY_MARKERS = ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID'];
const PLACEHOLDER = /<[^<>]+>/; // .env.example placeholders look like <db-password>
const DB_NAME = /^[^/\\. "$*<>:|?]{1,63}$/;

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid configuration:\n- ' + problems.join('\n- '));
    this.problems = problems;
  }
}

// Deployed means production rules apply: a database is required and the server listens on all interfaces.
function isDeployed(env) {
  return env.NODE_ENV === 'production' || RAILWAY_MARKERS.some(k => env[k]);
}

// Adds variables from a .env file without overriding anything already set (Railway or shell values win).
// Returns the names that were added. Values are never returned or logged.
function loadEnvFile(file, env = process.env) {
  if (!fs.existsSync(file)) return [];
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  const added = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] === undefined) { env[name] = value; added.push(name); }
  }
  return added;
}

function loadConfig(env = process.env) {
  const problems = [];
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) problems.push('NODE_ENV must be development, test, or production.');
  const deployed = isDeployed(env);

  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && env.PORT.trim() !== '') {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push('PORT must be a whole number from 0 to 65535.');
  }
  const host = (env.HOST || '').trim() || (deployed ? '0.0.0.0' : '127.0.0.1');
  if (!net.isIP(host) && host !== 'localhost') problems.push('HOST must be an IP address such as 127.0.0.1, 0.0.0.0, or ::, or "localhost".');

  const uri = (env.MONGODB_URI || '').trim();
  const name = (env.MONGODB_DB_NAME || '').trim();
  let database = null;
  if (!uri && !name) {
    if (deployed) problems.push('MONGODB_URI and MONGODB_DB_NAME are required when deployed (NODE_ENV=production or running on Railway).');
  } else {
    if (!uri) problems.push('MONGODB_URI is required when MONGODB_DB_NAME is set. Remove both to run without a database.');
    else if (!/^mongodb(\+srv)?:\/\/\S+$/.test(uri)) problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv:// and contain no spaces.');
    else if (PLACEHOLDER.test(uri)) problems.push('MONGODB_URI still contains a placeholder such as <db-password>. Enter the real value, or remove MONGODB_URI and MONGODB_DB_NAME to run without a database.');
    if (!name) problems.push('MONGODB_DB_NAME is required when MONGODB_URI is set.');
    else if (!DB_NAME.test(name)) problems.push('MONGODB_DB_NAME must be 1-63 characters with no spaces and none of / \\ . " $ * < > : | ?');
    database = { uri, name };
  }

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze({ nodeEnv, deployed, port, host, database: database && Object.freeze(database) });
}

module.exports = { ConfigError, DEFAULT_PORT, isDeployed, loadConfig, loadEnvFile };
