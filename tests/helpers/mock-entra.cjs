// A local stand-in for Microsoft Entra ID's OpenID Connect endpoints, for tests only.
// Serves discovery, signing keys, authorize, and token endpoints; signs ID tokens with a key generated per run.
// It enforces the authorization code, PKCE (S256), redirect URI, and client secret like the real service.
const http = require('node:http');
const crypto = require('node:crypto');

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

async function startMockEntra({ tenantId, clientId, clientSecret }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-key', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const tokenRequests = [];
  let nextSignIn = null;
  let issuer, base;

  function sign(claims, key = privateKey) {
    const data = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'mock-key' })}.${b64(claims)}`;
    return `${data}.${crypto.sign('sha256', Buffer.from(data), key).toString('base64url')}`;
  }

  // Simulates the user approving sign-in at Microsoft. Returns the callback URL Microsoft would redirect to.
  // `options` can break the result: { badSignature, expired, audience, issuer, nonce, state }.
  function authorize(authorizeUrl, claims, options = {}) {
    const q = new URL(authorizeUrl).searchParams;
    if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') throw new Error('mock: unexpected authorize request');
    const code = crypto.randomBytes(16).toString('base64url');
    codes.set(code, { claims, options, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', options.state ?? q.get('state'));
    return back.href;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === `/${tenantId}/v2.0/.well-known/openid-configuration`) {
      return json(200, {
        issuer, authorization_endpoint: `${base}/${tenantId}/oauth2/v2.0/authorize`, token_endpoint: `${base}/${tenantId}/oauth2/v2.0/token`,
        jwks_uri: `${base}/${tenantId}/discovery/v2.0/keys`, end_session_endpoint: `${base}/${tenantId}/oauth2/v2.0/logout`,
        response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic']
      });
    }
    if (url.pathname === `/${tenantId}/discovery/v2.0/keys`) return json(200, { keys: [jwk] });
    if (url.pathname === `/${tenantId}/oauth2/v2.0/authorize`) {
      // Browser checks: approve automatically as the account queued with signInNext().
      if (!nextSignIn) { res.writeHead(400); return res.end('mock: no sign-in queued'); }
      const location = authorize(url.href, nextSignIn);
      res.writeHead(302, { Location: location }); return res.end();
    }
    if (url.pathname === `/${tenantId}/oauth2/v2.0/logout`) { res.writeHead(302, { Location: url.searchParams.get('post_logout_redirect_uri') || base }); return res.end(); }
    if (url.pathname === `/${tenantId}/oauth2/v2.0/token` && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      return req.on('end', () => {
        const p = new URLSearchParams(body);
        tokenRequests.push(Object.fromEntries([...p].filter(([k]) => k !== 'client_secret')));
        const entry = codes.get(p.get('code'));
        codes.delete(p.get('code'));
        if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
        if (!entry || p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== entry.redirectUri) return json(400, { error: 'invalid_grant' });
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
        if (challenge !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const now = Math.floor(Date.now() / 1000);
        const o = entry.options;
        const claims = {
          iss: o.issuer || issuer, aud: o.audience || clientId, iat: o.expired ? now - 7200 : now, nbf: o.expired ? now - 7200 : now, exp: o.expired ? now - 3600 : now + 3600,
          nonce: o.nonce || entry.nonce, tid: tenantId, ver: '2.0', ...entry.claims
        };
        json(200, { token_type: 'Bearer', access_token: 'mock-access-token', expires_in: 3600, scope: 'openid profile email', id_token: sign(claims, o.badSignature ? otherKey : privateKey) });
      });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  issuer = `${base}/${tenantId}/v2.0`;
  return {
    issuer, authorize, tokenRequests,
    signInNext(claims) { nextSignIn = claims; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

module.exports = { startMockEntra };
