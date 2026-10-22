// Entry point: loads settings, serves the prototype with health checks, and shuts down cleanly.
// Without MONGODB_URI the server runs exactly as the browser-only prototype; the UI never uses the database yet.
const path = require('node:path');
const { createServer } = require('./server/app.cjs');
const { ConfigError, loadConfig, loadEnvFile } = require('./server/config.cjs');
const { createDatabase } = require('./server/database.cjs');
const { createAuth } = require('./server/auth/index.cjs');

const SHUTDOWN_GRACE_MS = 8000;

// Starts the server for an already validated config. Resolves once listening.
// `oidc` and `now` are for tests only (a local mock sign-in provider and a controllable clock).
async function start(config, { log = console, oidc, now } = {}) {
  const database = createDatabase(config.database);
  const auth = config.auth.mode === 'entra' ? createAuth(config.auth, { database, log, oidc, now }) : null;
  let shuttingDown = false;
  const server = createServer({ database, auth, isShuttingDown: () => shuttingDown, log });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    await database.close();
    throw err;
  }
  const port = server.address().port;
  log.log(`JarcTech Ticket: http://localhost:${port}`);
  log.log(!auth
    ? 'Sign-in: none. Browser-only demo mode for local use; records stay in this browser.'
    : config.auth.accessPolicy === 'tenant-members'
      ? 'Sign-in: Microsoft Entra ID required. Access policy tenant-members: member accounts of the configured tenant may sign in; new users start as Requestor. Guests and other tenants are refused.'
      : 'Sign-in: Microsoft Entra ID required. Access policy invite-only: access is by admin invitation only.');
  if (database.configured) {
    log.log(`Database: ${database.name} configured. Checking connection...`);
    database.ping(5000).then(r => r.ok
      ? log.log('Database: connected.')
      : log.error(`Database: ${r.reason}. The app keeps running and /readyz reports not ready.${r.error ? ' ' + r.error : ''}`));
  } else {
    log.log('Database: not configured. Running as the browser-only prototype.');
  }

  // Stop accepting connections, let in-flight requests finish (forced after the grace period), then close the database.
  let stopping = null;
  function shutdown(reason = 'Shutdown') {
    return stopping ??= (async () => {
      shuttingDown = true;
      log.log(`${reason} received. Stopping...`);
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
      });
      await database.close();
      log.log('Shutdown complete.');
    })();
  }
  return { server, database, port, shutdown };
}

async function main() {
  // A local .env adds settings that are not already set; Railway variables and shell values win.
  // Tests and the browser walkthrough set NODE_ENV=test or JARCTECH_ENV_FILE=none so a developer's .env is never used.
  const envFile = process.env.JARCTECH_ENV_FILE ?? path.join(__dirname, '.env');
  if (process.env.NODE_ENV !== 'test' && envFile !== 'none') {
    const added = loadEnvFile(envFile);
    if (added.length) console.log(`Loaded ${added.length} setting(s) from ${path.basename(envFile)}.`);
  }

  let config;
  try { config = loadConfig(process.env); }
  catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }

  let app;
  try { app = await start(config); }
  catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is in use. Set PORT to another value (for example 4176).` : err.message);
    process.exit(1);
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      if (app.stopping) process.exit(1); // second signal: stop immediately
      app.stopping = true;
      await app.shutdown(signal);
      process.exit(0);
    });
  }
}

if (require.main === module) main();

module.exports = { createServer, start };
