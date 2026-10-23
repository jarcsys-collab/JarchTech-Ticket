const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigError, loadConfig, loadEnvFile } = require('../server/config.cjs');
const { redact, secretsFromUri } = require('../server/redact.cjs');

const SECRET = 'S3cret-Pa55';
const problemsFor = env => { try { loadConfig(env); return []; } catch (err) { assert.ok(err instanceof ConfigError); return err.problems; } };
// Valid-looking but fake Entra settings (no real tenant, app, or secret).
const ENTRA = {
  AUTH_MODE: 'entra', MONGODB_URI: 'mongodb://h/', MONGODB_DB_NAME: 'jt',
  ENTRA_TENANT_ID: '11111111-2222-4333-8444-555555555555', ENTRA_CLIENT_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  ENTRA_CLIENT_SECRET: 'fake-client-secret-value', SESSION_SECRET: 'fake-session-secret-0123456789abcdefghij', APP_BASE_URL: 'http://localhost:4177', PORT: '4177'
};

test('no database settings: local prototype mode on 127.0.0.1:4175', () => {
  const c = loadConfig({});
  assert.deepEqual({ ...c }, { nodeEnv: 'development', deployed: false, port: 4175, host: '127.0.0.1', database: null, auth: { mode: 'demo' } });
});

test('PORT and HOST are honoured; Railway and production default to all interfaces', () => {
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
  assert.equal(loadConfig({ PORT: '0' }).port, 0);
  const railway = { ...ENTRA, APP_BASE_URL: 'https://jarctech.example', RAILWAY_ENVIRONMENT_NAME: 'staging', PORT: '3000' };
  assert.equal(loadConfig(railway).host, '0.0.0.0');
  assert.equal(loadConfig(railway).deployed, true);
  assert.equal(loadConfig({ ...railway, RAILWAY_ENVIRONMENT_NAME: undefined, NODE_ENV: 'production' }).host, '0.0.0.0');
  assert.equal(loadConfig({ ...railway, HOST: '::' }).host, '::');
});

test('database settings are optional locally but required when deployed', () => {
  assert.match(problemsFor({ NODE_ENV: 'production' }).join(), /MONGODB_URI and MONGODB_DB_NAME are required when deployed/);
  assert.match(problemsFor({ RAILWAY_PROJECT_ID: 'x' }).join(), /required when deployed/);
  const c = loadConfig({ MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/', MONGODB_DB_NAME: 'jarctech_ticket_local' });
  assert.equal(c.database.name, 'jarctech_ticket_local');
});

test('invalid settings are all reported together without repeating secret values', () => {
  const problems = problemsFor({ NODE_ENV: 'staging', PORT: '70000', HOST: 'my laptop', MONGODB_URI: `http://admin:${SECRET}@db`, MONGODB_DB_NAME: 'bad.name' });
  assert.equal(problems.length, 5, problems.join('\n'));
  for (const p of problems) assert.ok(!p.includes(SECRET) && !p.includes('admin'), p);
});

test('half-configured database and unedited placeholders are rejected with guidance', () => {
  assert.match(problemsFor({ MONGODB_URI: 'mongodb://h/' }).join(), /MONGODB_DB_NAME is required/);
  assert.match(problemsFor({ MONGODB_DB_NAME: 'jt' }).join(), /MONGODB_URI is required.*Remove both/);
  const placeholder = problemsFor({ MONGODB_URI: 'mongodb+srv://<db-user>:<db-password>@<cluster-host>/', MONGODB_DB_NAME: 'jt' }).join();
  assert.match(placeholder, /still contains a placeholder/);
});

test('.env loading adds missing settings only and never overrides existing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-config-test-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'PORT=5000\nMONGODB_DB_NAME=from_file\n# comment\n');
    const env = { PORT: '6000' };
    assert.deepEqual(loadEnvFile(file, env), ['MONGODB_DB_NAME']);
    assert.deepEqual(env, { PORT: '6000', MONGODB_DB_NAME: 'from_file' });
    assert.deepEqual(loadEnvFile(path.join(dir, 'missing.env'), env), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redaction removes connection strings, usernames, and passwords (encoded or not)', () => {
  const uri = `mongodb+srv://jt_user:${encodeURIComponent('p@ss/word')}@cluster0.example.net/?retryWrites=true`;
  const secrets = secretsFromUri(uri);
  const text = `failed ${uri} as jt_user with p@ss/word and p%40ss%2Fword`;
  const out = redact(text, secrets);
  for (const s of ['jt_user', 'p@ss/word', 'p%40ss%2Fword', uri]) assert.ok(!out.includes(s), out);
  assert.equal(redact('mongodb://other:hunter22@h:27017/db'), 'mongodb://<redacted>@h:27017/db');
  assert.equal(redact('no secrets here'), 'no secrets here');
});

test('demo mode is local only and never a fallback for incomplete sign-in settings', () => {
  assert.equal(loadConfig({}).auth.mode, 'demo');
  assert.equal(loadConfig({ AUTH_MODE: 'demo' }).auth.mode, 'demo');
  assert.match(problemsFor({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://h/', MONGODB_DB_NAME: 'jt' }).join(), /AUTH_MODE=entra is required when deployed/);
  assert.match(problemsFor({ AUTH_MODE: 'demo', RAILWAY_PROJECT_ID: 'x', MONGODB_URI: 'mongodb://h/', MONGODB_DB_NAME: 'jt' }).join(), /AUTH_MODE=entra is required when deployed/);
  const { AUTH_MODE, ...withoutMode } = ENTRA;
  assert.match(problemsFor(withoutMode).join(), /Entra settings are present but AUTH_MODE is not set/);
  assert.match(problemsFor({ ENTRA_CLIENT_ID: ENTRA.ENTRA_CLIENT_ID }).join(), /AUTH_MODE is not set/);
  assert.match(problemsFor({ AUTH_MODE: 'entra-ish' }).join(), /AUTH_MODE must be entra or demo/);
});

test('AUTH_MODE=entra requires complete, single-tenant settings and reports every problem without values', () => {
  const c = loadConfig(ENTRA);
  assert.deepEqual({ ...c.auth }, { mode: 'entra', tenantId: ENTRA.ENTRA_TENANT_ID, clientId: ENTRA.ENTRA_CLIENT_ID, clientSecret: ENTRA.ENTRA_CLIENT_SECRET, baseUrl: 'http://localhost:4177', sessionSecret: ENTRA.SESSION_SECRET, secureCookies: false, accessPolicy: 'invite-only', inspection: false });
  const missing = problemsFor({ AUTH_MODE: 'entra' });
  for (const name of ['MONGODB_URI and MONGODB_DB_NAME', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'APP_BASE_URL', 'SESSION_SECRET']) assert.ok(missing.some(p => p.includes(name)), name);
  assert.match(problemsFor({ ...ENTRA, ENTRA_TENANT_ID: 'common' }).join(), /directory \(tenant\) ID, a GUID/);
  assert.match(problemsFor({ ...ENTRA, ENTRA_TENANT_ID: 'organizations' }).join(), /directory \(tenant\) ID, a GUID/);
  assert.match(problemsFor({ ...ENTRA, ENTRA_CLIENT_ID: 'my-app' }).join(), /application \(client\) ID, a GUID/);
  assert.match(problemsFor({ ...ENTRA, ENTRA_CLIENT_SECRET: '<client-secret-value>' }).join(), /ENTRA_CLIENT_SECRET still contains a placeholder/);
  assert.match(problemsFor({ ...ENTRA, SESSION_SECRET: 'too-short' }).join(), /at least 32 characters/);
  assert.match(problemsFor({ ...ENTRA, SESSION_SECRET: 'same-value-for-both-secrets-0123456789', ENTRA_CLIENT_SECRET: 'same-value-for-both-secrets-0123456789' }).join(), /must be different/);
  const leaky = problemsFor({ ...ENTRA, ENTRA_TENANT_ID: 'tenant-' + SECRET, SESSION_SECRET: SECRET });
  for (const p of leaky) assert.ok(!p.includes(SECRET), p);
});

test('APP_BASE_URL must be https except localhost, have no path, and match the local port', () => {
  assert.match(problemsFor({ ...ENTRA, APP_BASE_URL: 'http://jarctech.example' }).join(), /must use https/);
  assert.match(problemsFor({ ...ENTRA, APP_BASE_URL: 'http://localhost:4177', NODE_ENV: 'production' }).join(), /must use https/);
  assert.match(problemsFor({ ...ENTRA, APP_BASE_URL: 'http://localhost:4177/app' }).join(), /no path/);
  assert.match(problemsFor({ ...ENTRA, APP_BASE_URL: 'http://localhost:4175' }).join(), /same port as PORT/);
  assert.match(problemsFor({ ...ENTRA, APP_BASE_URL: 'not a url' }).join(), /full URL/);
  const https = loadConfig({ ...ENTRA, APP_BASE_URL: 'https://jarctech.example/', PORT: '3000' });
  assert.equal(https.auth.baseUrl, 'https://jarctech.example'); assert.equal(https.auth.secureCookies, true);
});

test('ACCESS_POLICY is explicit: invite-only by default, tenant-members only when set, never in demo mode', () => {
  assert.equal(loadConfig(ENTRA).auth.accessPolicy, 'invite-only', 'unset means invite-only, so removing the line restores it');
  assert.equal(loadConfig({ ...ENTRA, ACCESS_POLICY: 'invite-only' }).auth.accessPolicy, 'invite-only');
  assert.equal(loadConfig({ ...ENTRA, ACCESS_POLICY: 'tenant-members' }).auth.accessPolicy, 'tenant-members');
  assert.match(problemsFor({ ...ENTRA, ACCESS_POLICY: 'everyone' }).join(), /ACCESS_POLICY must be invite-only or tenant-members/);
  assert.match(problemsFor({ ...ENTRA, ACCESS_POLICY: 'Tenant-Members' }).join(), /ACCESS_POLICY must be/);
  assert.match(problemsFor({ AUTH_MODE: 'demo', ACCESS_POLICY: 'tenant-members' }).join(), /applies only when AUTH_MODE=entra/);
  assert.match(problemsFor({ ACCESS_POLICY: 'tenant-members' }).join(), /AUTH_MODE is not set/);
  assert.match(problemsFor({ ...ENTRA, ENTRA_TENANT_ID: '9188040d-6c67-4c5b-b112-36a304b66dad' }).join(), /personal Microsoft account tenant/);
});

test('INSPECTION_MODE is an explicit beta option: off by default, entra only, and strictly validated', () => {
  assert.equal(loadConfig(ENTRA).auth.inspection, false, 'off unless enabled');
  assert.equal(loadConfig({ ...ENTRA, INSPECTION_MODE: 'disabled' }).auth.inspection, false);
  assert.equal(loadConfig({ ...ENTRA, INSPECTION_MODE: 'enabled' }).auth.inspection, true);
  assert.match(problemsFor({ ...ENTRA, INSPECTION_MODE: 'yes' }).join(), /INSPECTION_MODE must be enabled or disabled/);
  assert.match(problemsFor({ AUTH_MODE: 'demo', INSPECTION_MODE: 'enabled' }).join(), /INSPECTION_MODE applies only when AUTH_MODE=entra/);
  assert.match(problemsFor({ INSPECTION_MODE: 'enabled' }).join(), /AUTH_MODE is not set/);
});
