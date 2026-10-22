const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigError, loadConfig, loadEnvFile } = require('../server/config.cjs');
const { redact, secretsFromUri } = require('../server/redact.cjs');

const SECRET = 'S3cret-Pa55';
const problemsFor = env => { try { loadConfig(env); return []; } catch (err) { assert.ok(err instanceof ConfigError); return err.problems; } };

test('no database settings: local prototype mode on 127.0.0.1:4175', () => {
  const c = loadConfig({});
  assert.deepEqual({ ...c }, { nodeEnv: 'development', deployed: false, port: 4175, host: '127.0.0.1', database: null });
});

test('PORT and HOST are honoured; Railway and production default to all interfaces', () => {
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
  assert.equal(loadConfig({ PORT: '0' }).port, 0);
  const railway = { RAILWAY_ENVIRONMENT_NAME: 'staging', PORT: '3000', MONGODB_URI: 'mongodb://h/', MONGODB_DB_NAME: 'jt' };
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
