// Microsoft Entra ID sign-in with openid-client: authorization code flow with PKCE, state, and nonce.
// The issuer is always the configured tenant's v2.0 endpoint. Tests pass `issuer` and `allowInsecure` in code
// to use a local mock provider; there is no environment variable for either.

function createOidc(auth, { issuer, allowInsecure = false } = {}) {
  const issuerUrl = new URL(issuer || `https://login.microsoftonline.com/${auth.tenantId}/v2.0`);
  const redirectUri = auth.baseUrl + '/auth/callback';
  let loading = null;

  // Discovery is fetched on first use and cached; a failure is retried on the next sign-in attempt.
  function configuration() {
    loading ??= (async () => {
      const client = await import('openid-client');
      const options = allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined;
      const config = await client.discovery(issuerUrl, auth.clientId, auth.clientSecret, undefined, options);
      // openid-client relies on TLS for ID tokens from the token endpoint by default; also verify their
      // signatures against the tenant's published keys.
      client.enableNonRepudiationChecks(config);
      return { client, config };
    })().catch(err => { loading = null; throw err; });
    return loading;
  }

  return {
    redirectUri,
    async begin() {
      const { client, config } = await configuration();
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        response_mode: 'query',
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce
      });
      return { url: url.href, flow: { state, nonce, verifier } };
    },
    // Exchanges the code and validates the ID token (signature, issuer, audience, expiry, nonce). Returns its claims.
    async finish(callbackUrl, flow) {
      const { client, config } = await configuration();
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      return tokens.claims();
    },
    async signOutUrl() {
      try {
        const { client, config } = await configuration();
        return client.buildEndSessionUrl(config, { post_logout_redirect_uri: auth.baseUrl + '/auth/signed-out', client_id: auth.clientId }).href;
      } catch {
        return null;
      }
    }
  };
}

module.exports = { createOidc };
