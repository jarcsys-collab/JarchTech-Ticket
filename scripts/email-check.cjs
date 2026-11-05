// Checks the configured email connection without sending any email, and without touching any record: the settings are valid,
// the app can sign in, and the flow answers. It prints no secrets, addresses, or flow URL. Read-only, so it can run at any time.
//   railway run -p <project> -s <service> -e production npm run email:check
const { ConfigError, loadConfig } = require('../server/config.cjs');
const { createProvider } = require('../server/workspace/email-providers.cjs');

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
  const result = await createProvider({ config: email, fetch: globalThis.fetch, now: () => new Date() }).check();
  if (result.ok) return console.log('Sign-in: ok. Flow: on, and it answered. No email was sent. This cannot prove the Outlook connection is still valid.');
  console.error(`Failed at ${result.step}${result.code ? ` (${result.code})` : ''}. No email was sent.`);
  process.exit(1);
})().catch(err => { console.error(`Check failed: ${err.name}`); process.exit(1); });
