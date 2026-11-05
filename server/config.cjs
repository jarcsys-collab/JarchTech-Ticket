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
// Local/test only. The official deployment runs neither of these two: a deployed server refuses to start with either
// enabled, and so does a server whose APP_BASE_URL is not localhost (a local server pointed at a shared address).
// Inspection mode: signed-in people preview the Requestor, Admin, and Developer views on sample data in their own browser.
const INSPECTION_MODES = ['enabled', 'disabled'];
// Simulation: one shared, server-stored test workspace where signed-in members switch freely between the Requestor,
// Admin, and Developer views. Separate from real roles, which it never changes.
const BETA_SIMULATION_MODES = ['enabled', 'disabled'];
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'; // personal Microsoft accounts
// Due-date reminders and escalation (in-app; optionally email). Whole days, in the workspace timezone.
const REMINDER_SETTINGS = {
  REMINDER_DUE_SOON_DAYS: ['dueSoonDays', 2, 0, 60],
  REMINDER_ESCALATE_OVERDUE_DAYS: ['escalateOverdueDays', 2, 0, 60],
  REMINDER_ACCEPTANCE_DAYS: ['acceptanceDays', 2, 1, 60],
  REMINDER_ESCALATE_ACCEPTANCE_DAYS: ['escalateAcceptanceDays', 5, 1, 120],
  REMINDER_PENDING_DAYS: ['pendingDays', 2, 1, 60],
  REMINDER_INTERVAL_MINUTES: ['intervalMinutes', 5, 1, 1440]
};
// Optional email delivery. Off unless EMAIL_DELIVERY names a provider and its settings are complete.
const EMAIL_PROVIDERS = ['disabled', 'resend', 'power-automate'];
const FLOW_HOST = /(^|\.)(logic\.azure\.com|powerplatform\.com|powerautomate\.com)$/i;
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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
  const reminders = loadReminders(env, problems);
  const email = loadEmail(env, problems);
  const limits = loadLimits(env, { nodeEnv, deployed, problems });

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze({ nodeEnv, deployed, port, host, database: database && Object.freeze(database), auth: Object.freeze(auth), reminders: Object.freeze(reminders), email: Object.freeze(email), limits: Object.freeze(limits) });
}

// Abuse limits and attachment capacity. Rate limits are always on when deployed; automated tests opt in with
// RATE_LIMITS=enabled because they sign in and save far faster than people do.
function loadLimits(env, { nodeEnv, deployed, problems }) {
  const raw = (env.RATE_LIMITS || '').trim();
  if (raw && !['enabled', 'disabled'].includes(raw)) problems.push('RATE_LIMITS must be enabled or disabled.');
  if (raw === 'disabled' && deployed) problems.push('RATE_LIMITS cannot be disabled when deployed.');
  const quota = (env.ATTACHMENT_QUOTA_MB || '').trim();
  const quotaMb = quota === '' ? 200 : Number(quota);
  if (!Number.isInteger(quotaMb) || quotaMb < 1 || quotaMb > 102400) problems.push('ATTACHMENT_QUOTA_MB must be a whole number from 1 to 102400.');
  return { rate: raw ? raw === 'enabled' : nodeEnv !== 'test', attachmentQuotaBytes: quotaMb * 1024 * 1024 };
}

function loadReminders(env, problems) {
  const value = name => (env[name] || '').trim();
  const out = { enabled: (value('REMINDERS') || 'enabled') === 'enabled', timezone: value('WORKSPACE_TIMEZONE') || 'Asia/Manila' };
  if (!['enabled', 'disabled'].includes(value('REMINDERS') || 'enabled')) problems.push('REMINDERS must be enabled or disabled.');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: out.timezone }); } catch { problems.push('WORKSPACE_TIMEZONE must be an IANA time zone such as Asia/Manila.'); }
  for (const [name, [key, fallback, min, max]] of Object.entries(REMINDER_SETTINGS)) {
    const raw = value(name);
    const n = raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) problems.push(`${name} must be a whole number from ${min} to ${max}.`);
    out[key] = n;
  }
  if (out.escalateAcceptanceDays < out.acceptanceDays) problems.push('REMINDER_ESCALATE_ACCEPTANCE_DAYS must not be less than REMINDER_ACCEPTANCE_DAYS.');
  return out;
}

// EMAIL_DELIVERY=resend sends email through Resend's HTTPS API (no Microsoft Entra or Graph permissions involved).
// The sender is always named JarcTech Ticket, at the address in EMAIL_FROM. Optional: EMAIL_REPLY_TO, the reply address for
// automatic reminders; EMAIL_TEST_RECIPIENTS, a comma-separated list that limits all delivery to those accounts.
function loadEmail(env, problems) {
  const value = name => (env[name] || '').trim();
  const provider = value('EMAIL_DELIVERY') || 'disabled';
  if (!EMAIL_PROVIDERS.includes(provider)) { problems.push('EMAIL_DELIVERY must be disabled, resend, or power-automate.'); return { enabled: false, provider: 'disabled' }; }
  if (provider === 'disabled') return { enabled: false, provider };
  const before = problems.length;
  if (provider === 'power-automate') return loadPowerAutomate(value, problems, before);
  const from = value('EMAIL_FROM'), key = value('RESEND_API_KEY');
  const address = (/<([^<>]+)>\s*$/.exec(from) || [null, from])[1];
  if (!from) problems.push('EMAIL_FROM is required when EMAIL_DELIVERY=resend (for example "JarcTech Ticket <tickets@your-domain>").');
  else if (PLACEHOLDER.test(from) && !EMAIL_ADDRESS.test(address)) problems.push('EMAIL_FROM still contains a placeholder.');
  else if (!EMAIL_ADDRESS.test(address)) problems.push('EMAIL_FROM must be an email address, optionally as "Name <address>".');
  if (!key) problems.push('RESEND_API_KEY is required when EMAIL_DELIVERY=resend.');
  else if (PLACEHOLDER.test(key)) problems.push('RESEND_API_KEY still contains a placeholder. Enter the real value in .env or Railway variables.');
  if (!(value('APP_BASE_URL'))) problems.push('APP_BASE_URL is required when EMAIL_DELIVERY is enabled, for the sign-in link in emails.');
  const replyTo = value('EMAIL_REPLY_TO');
  if (replyTo && !EMAIL_ADDRESS.test(replyTo)) problems.push('EMAIL_REPLY_TO must be a plain email address.');
  const testRecipients = value('EMAIL_TEST_RECIPIENTS').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
  if (testRecipients.some(a => !EMAIL_ADDRESS.test(a))) problems.push('EMAIL_TEST_RECIPIENTS must be email addresses separated by commas.');
  if (problems.length > before) return { enabled: false, provider };
  return { enabled: true, provider, from: `JarcTech Ticket <${address}>`, apiKey: key, appUrl: value('APP_BASE_URL').replace(/\/$/, ''), replyTo: replyTo || null, testRecipients };
}

// EMAIL_DELIVERY=power-automate calls one flow as a service principal. The sender is fixed inside the flow, so there is no
// EMAIL_FROM. The flow address and the secret are never logged. EMAIL_ALLOWED_DOMAINS keeps recipients inside the company,
// and the flow checks the same thing itself.
function loadPowerAutomate(value, problems, before) {
  const flowUrl = value('EMAIL_FLOW_URL');
  let url = null;
  try { url = new URL(flowUrl); } catch {}
  if (!flowUrl) problems.push('EMAIL_FLOW_URL is required when EMAIL_DELIVERY=power-automate.');
  else if (!url || url.protocol !== 'https:' || !FLOW_HOST.test(url.hostname)) problems.push('EMAIL_FLOW_URL must be the https address of a Power Automate flow trigger.');
  const tenantId = value('ENTRA_TENANT_ID').toLowerCase();
  if (!GUID.test(tenantId)) problems.push('ENTRA_TENANT_ID is required when EMAIL_DELIVERY=power-automate.');
  const clientId = value('EMAIL_FLOW_CLIENT_ID').toLowerCase(), clientSecret = value('EMAIL_FLOW_CLIENT_SECRET');
  if (!GUID.test(clientId)) problems.push('EMAIL_FLOW_CLIENT_ID must be the application (client) ID, a GUID, of the app registration the flow allows.');
  if (!clientSecret) problems.push('EMAIL_FLOW_CLIENT_SECRET is required when EMAIL_DELIVERY=power-automate.');
  else if (PLACEHOLDER.test(clientSecret)) problems.push('EMAIL_FLOW_CLIENT_SECRET still contains a placeholder.');
  else if (clientSecret === value('ENTRA_CLIENT_SECRET')) problems.push('EMAIL_FLOW_CLIENT_SECRET must not be the sign-in secret. Use the separate app registration for email.');
  const allowedDomains = value('EMAIL_ALLOWED_DOMAINS').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  if (!allowedDomains.length || allowedDomains.some(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) problems.push('EMAIL_ALLOWED_DOMAINS must list the company email domains, separated by commas.');
  const replyTo = value('EMAIL_REPLY_TO');
  if (replyTo && !EMAIL_ADDRESS.test(replyTo)) problems.push('EMAIL_REPLY_TO must be a plain email address.');
  const testRecipients = value('EMAIL_TEST_RECIPIENTS').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
  if (testRecipients.some(a => !EMAIL_ADDRESS.test(a))) problems.push('EMAIL_TEST_RECIPIENTS must be email addresses separated by commas.');
  if (!value('APP_BASE_URL')) problems.push('APP_BASE_URL is required when EMAIL_DELIVERY is enabled, for the sign-in link in emails.');
  if (problems.length > before) return { enabled: false, provider: 'power-automate' };
  return { enabled: true, provider: 'power-automate', flowUrl, tenantId, clientId, clientSecret, allowedDomains, appUrl: value('APP_BASE_URL').replace(/\/$/, ''), replyTo: replyTo || null, testRecipients };
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

// Database settings only, for the db:setup, admin:bootstrap, db:migrate-request-types, and beta:seed commands. Both settings are required.
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
    else if (!mode && [...ENTRA_VARS, 'ACCESS_POLICY', 'INSPECTION_MODE', 'BETA_SIMULATION'].some(value)) problems.push('Microsoft Entra settings are present but AUTH_MODE is not set. Set AUTH_MODE=entra to require sign-in, or AUTH_MODE=demo for the browser-only demo.');
    else if (mode === 'demo' && value('ACCESS_POLICY')) problems.push('ACCESS_POLICY applies only when AUTH_MODE=entra. Remove it for demo mode.');
    else if (mode === 'demo' && value('BETA_SIMULATION')) problems.push('BETA_SIMULATION applies only when AUTH_MODE=entra, because the shared workspace needs signed-in members.');
    else if (mode === 'demo' && value('INSPECTION_MODE')) problems.push('INSPECTION_MODE applies only when AUTH_MODE=entra. Demo mode already has the Demo role selector.');
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
  const inspectionMode = value('INSPECTION_MODE') || 'disabled';
  if (!INSPECTION_MODES.includes(inspectionMode)) problems.push('INSPECTION_MODE must be enabled or disabled.');
  const betaMode = value('BETA_SIMULATION') || 'disabled';
  if (!BETA_SIMULATION_MODES.includes(betaMode)) problems.push('BETA_SIMULATION must be enabled or disabled.');
  // The official deployment has no simulation or preview, whatever else is configured.
  const localOnly = () => { try { return LOCAL_HOSTS.includes(new URL(value('APP_BASE_URL')).hostname); } catch { return false; } };
  for (const [name, setting] of [['BETA_SIMULATION', betaMode], ['INSPECTION_MODE', inspectionMode]]) {
    if (setting === 'enabled' && (deployed || !localOnly())) problems.push(`${name}=enabled is for local and test use only (http://localhost). Remove it, or set it to disabled, for the official deployment.`);
  }
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
    accessPolicy,
    inspection: inspectionMode === 'enabled',
    beta: betaMode === 'enabled'
  };
}

module.exports = { ConfigError, DEFAULT_PORT, isDeployed, loadConfig, loadDatabaseConfig, loadEnvFile };
