// Checks the email settings without sending any email and without collecting any message: the settings are valid, and the
// running app accepts the flow's secret. It prints no secrets or addresses. Safe to run at any time.
//   railway run -p <project> -s <service> -e production npm run email:check
const { ConfigError, loadConfig } = require('../server/config.cjs');

(async () => {
  let config;
  try { config = loadConfig(process.env); }
  catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
  const email = config.email;
  console.log(`Email delivery: ${email.enabled ? email.provider : 'disabled'}`);
  if (!email.enabled) return;
  console.log(`Test recipients only: ${email.testRecipients.length ? 'yes' : 'no'}`);
  if (email.provider !== 'power-automate') return console.log('This provider has no connection check.');
  console.log(`Allowed domains: ${email.allowedDomains.join(', ')}`);
  console.log(`Previous secret also accepted: ${email.collectSecrets.length > 1 ? 'yes' : 'no'}`);
  const res = await fetch(`${email.appUrl}/api/v1/email-flow/check`, { method: 'POST', headers: { Authorization: `Bearer ${email.collectSecrets[0]}` } });
  if (res.status === 200) return console.log('The running app has delivery on and accepts this secret. Nothing was collected or sent. This does not prove the flow is on: see Users, Email delivery.');
  console.error(res.status === 404 ? 'The running app has delivery off, or has not redeployed yet.' : `The running app refused it (HTTP ${res.status}).`);
  process.exit(1);
})().catch(err => { console.error(`Check failed: ${err.name}`); process.exit(1); });
