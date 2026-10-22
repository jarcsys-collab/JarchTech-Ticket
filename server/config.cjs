// Reads and validates server settings from environment variables.
// Problems name the variable but never repeat its value, so secrets cannot leak into logs.
const fs = require('node:fs');
const net = require('node:net');
const { parseEnv } = require('node:util');

const DEFAULT_PORT = 4175;
const RAILWAY_MARKERS = ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID'];
const PLACEHOLDER = /<[^<>]+>/; // .env.example placeholders look like <db-password>
const DB_NAME = /^[^/\\. "$*<>:|?]{1,63}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_VARS = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'APP_BASE_URL', 'SESSION_SECRET'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const MIN_SESSION_SECRET = 32;
// invite-only (default): only people an Admin invited. tenant-members: every member account of the configured
// tenant may sign in and is added as Requestor on first sign-in. Guests and other tenants are refused in both.
const ACCESS_POLICIES = ['invite-only', 'tenant-members'];
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'; // personal Microsoft accounts

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

  const database = readDatabase(env, { required: deployed, problems });
  const auth = loadAuth(env, { deployed, port, database, problems });

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze({ nodeEnv, deployed, port, host, database: database && Object.freeze(database), auth: Object.freeze(auth) });
}

function readDatabase(env, { required, problems }) {
  const uri = (env.MONGODB_URI || '').trim();
  const name = (env.MONGODB_DB_NAME || '').trim();
  if (!uri && !name) {
    if (required) problems.push('MONGODB_URI and MONGODB_DB_NAME are required when deployed (NODE_ENV=production or running on Railway).');
    return null;
  }
  if (!uri) problems.push('MONGODB_URI is required when MONGODB_DB_NAME is set. Remove both to run without a database.');
  else if (!/^mongodb(\+srv)?:\/\/\S+$/.test(uri)) problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv:// and contain no spaces.');
  else if (PLACEHOLDER.test(uri)) problems.push('MONGODB_URI still contains a placeholder such as <db-password>. Enter the real value, or remove MONGODB_URI and MONGODB_DB_NAME to run without a database.');
  if (!name) problems.push('MONGODB_DB_NAME is required when MONGODB_URI is set.');
  else if (!DB_NAME.test(name)) problems.push('MONGODB_DB_NAME must be 1-63 characters with no spaces and none of / \\ . " $ * < > : | ?');
  return { uri, name };
}

// Database settings only, for the db:setup and admin:bootstrap commands. Both settings are required.
function loadDatabaseConfig(env = process.env) {
  const problems = [];
  const database = readDatabase(env, { required: true, problems });
  if (!database && !problems.length) problems.push('MONGODB_URI and MONGODB_DB_NAME are required.');
  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(database);
}

// AUTH_MODE=entra requires Microsoft Entra sign-in. Demo mode (the browser-only prototype) is local only:
// it is refused when deployed, and Entra settings without an explicit AUTH_MODE are an error rather than
// a silent fallback to demo mode.
function loadAuth(env, { deployed, port, database, problems }) {
  const mode = (env.AUTH_MODE || '').trim();
  const value = name => (env[name] || '').trim();
  if (!mode || mode === 'demo') {
    if (deployed) problems.push('AUTH_MODE=entra is required when deployed. The browser-only demo mode is for local use only.');
    else if (!mode && [...ENTRA_VARS, 'ACCESS_POLICY'].some(value)) problems.push('Microsoft Entra settings are present but AUTH_MODE is not set. Set AUTH_MODE=entra to require sign-in, or AUTH_MODE=demo for the browser-only demo.');
    else if (mode === 'demo' && value('ACCESS_POLICY')) problems.push('ACCESS_POLICY applies only when AUTH_MODE=entra. Remove it for demo mode.');
    return { mode: 'demo' };
  }
  if (mode !== 'entra') { problems.push('AUTH_MODE must be entra or demo.'); return { mode: 'demo' }; }

  const before = problems.length;
  if (!database) problems.push('AUTH_MODE=entra needs MONGODB_URI and MONGODB_DB_NAME, because users and sessions are stored in MongoDB.');
  for (const name of ENTRA_VARS) {
    if (!value(name)) problems.push(`${name} is required when AUTH_MODE=entra.`);
    else if (PLACEHOLDER.test(value(name))) problems.push(`${name} still contains a placeholder. Enter the real value in .env or Railway variables.`);
  }
  if (value('ENTRA_TENANT_ID') && !GUID.test(value('ENTRA_TENANT_ID'))) problems.push('ENTRA_TENANT_ID must be the directory (tenant) ID, a GUID. Names such as common or organizations are not allowed because only the company tenant may sign in.');
  if (value('ENTRA_TENANT_ID').toLowerCase() === CONSUMER_TENANT) problems.push('ENTRA_TENANT_ID is the personal Microsoft account tenant. Use the company directory (tenant) ID.');
  const accessPolicy = value('ACCESS_POLICY') || 'invite-only';
  if (!ACCESS_POLICIES.includes(accessPolicy)) problems.push('ACCESS_POLICY must be invite-only or tenant-members.');
  if (value('ENTRA_CLIENT_ID') && !GUID.test(value('ENTRA_CLIENT_ID'))) problems.push('ENTRA_CLIENT_ID must be the application (client) ID, a GUID.');
  const secret = value('SESSION_SECRET');
  if (secret && secret.length < MIN_SESSION_SECRET) problems.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET} characters of random data.`);
  if (secret && secret === value('ENTRA_CLIENT_SECRET')) problems.push('SESSION_SECRET must be different from ENTRA_CLIENT_SECRET.');

  let baseUrl = null;
  if (value('APP_BASE_URL') && !PLACEHOLDER.test(value('APP_BASE_URL'))) {
    let url = null;
    try { url = new URL(value('APP_BASE_URL')); } catch { problems.push('APP_BASE_URL must be a full URL such as http://localhost:4177 or https://<your-domain>.'); }
    if (url) {
      const local = LOCAL_HOSTS.includes(url.hostname);
      if (!['http:', 'https:'].includes(url.protocol) || (url.pathname !== '/' || url.search || url.hash)) problems.push('APP_BASE_URL must be an http(s) origin with no path, query, or fragment.');
      else if (url.protocol === 'http:' && (!local || deployed)) problems.push('APP_BASE_URL must use https, except http://localhost for local development.');
      else if (local && port !== 0 && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== port) problems.push('APP_BASE_URL must use the same port as PORT, or the sign-in callback will reach a different server.');
      else baseUrl = url.origin;
    }
  }
  if (problems.length > before) return { mode: 'entra' };
  return {
    mode: 'entra',
    tenantId: value('ENTRA_TENANT_ID').toLowerCase(),
    clientId: value('ENTRA_CLIENT_ID').toLowerCase(),
    clientSecret: value('ENTRA_CLIENT_SECRET'),
    baseUrl,
    sessionSecret: secret,
    secureCookies: baseUrl.startsWith('https:'),
    accessPolicy
  };
}

module.exports = { ConfigError, DEFAULT_PORT, isDeployed, loadConfig, loadDatabaseConfig, loadEnvFile };
