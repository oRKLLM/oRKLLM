/**
 * Minimal OIDC server for E2E testing.
 *
 * Implements just enough of the OIDC Authorization Code + PKCE flow for oRKLLM's SSO tests:
 *   GET  /.well-known/openid-configuration  → discovery
 *   GET  /authorize                          → redirect to /login
 *   GET  /login                              → HTML form (username + groups)
 *   POST /login                              → validates & redirects with code
 *   POST /token                              → exchange code for id_token + access_token
 *   GET  /keys                               → JWKS
 *
 * Users, groups, and claims are determined entirely by what the login form submits.
 * No pre-configuration needed — any username/groups combination works.
 *
 * Usage: node e2e/mock-oidc-server.mjs [port]
 */
import http from 'http';
import crypto from 'crypto';
import { createSign } from 'crypto';

const PORT = parseInt(process.argv[2] || '8080');
const BASE_URL = `http://localhost:${PORT}`;

// Generate an RSA key pair for signing JWTs
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = crypto.randomBytes(8).toString('hex');

// In-memory code store: code → { sub, groups, nonce, redirectUri, codeVerifier }
const codes = new Map();

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJwt(payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const unsigned = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = crypto.createSign('sha256').update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(sig)}`;
}

function getPublicKeyComponents() {
  const der = publicKey.export({ type: 'pkcs1', format: 'der' });
  // Parse minimal RSA public key DER to extract n and e
  // Use Node's built-in KeyObject to get JWK directly
  const jwk = publicKey.export({ format: 'jwk' });
  return { n: jwk.n, e: jwk.e };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE_URL);

  // Discovery
  if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/authorize`,
      token_endpoint: `${BASE_URL}/token`,
      jwks_uri: `${BASE_URL}/keys`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'email', 'preferred_username', 'groups'],
    }));
  }

  // JWKS
  if (req.method === 'GET' && url.pathname === '/keys') {
    const { n, e } = getPublicKeyComponents();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ keys: [{ kty: 'RSA', use: 'sig', kid, alg: 'RS256', n, e }] }));
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/isalive') {
    res.writeHead(200); return res.end('ok');
  }

  // Authorization endpoint → show login form
  if (req.method === 'GET' && url.pathname === '/authorize') {
    const state = url.searchParams.get('state') || '';
    const nonce = url.searchParams.get('nonce') || '';
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const codeChallenge = url.searchParams.get('code_challenge') || '';
    const clientId = url.searchParams.get('client_id') || '';

    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!DOCTYPE html>
<html><body>
<h2>Mock OIDC Login</h2>
<form method="POST" action="/login">
  <input type="hidden" name="state" value="${state}">
  <input type="hidden" name="nonce" value="${nonce}">
  <input type="hidden" name="redirect_uri" value="${redirectUri}">
  <input type="hidden" name="code_challenge" value="${codeChallenge}">
  <input type="hidden" name="client_id" value="${clientId}">
  <label>Username: <input type="text" name="username" id="username" required></label><br>
  <label>Groups (comma-separated, e.g. /orkllm,/orkllm/admin):
    <input type="text" name="groups" value="/orkllm"></label><br>
  <button type="submit">Sign In</button>
</form>
</body></html>`);
  }

  // Login form POST → issue authorization code
  if (req.method === 'POST' && url.pathname === '/login') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const username = params.get('username') || 'testuser';
      const groupsRaw = params.get('groups') || '/orkllm';
      const groups = groupsRaw.split(',').map(g => g.trim()).filter(Boolean);
      const state = params.get('state') || '';
      const nonce = params.get('nonce') || '';
      const redirectUri = params.get('redirect_uri') || '';
      const codeChallenge = params.get('code_challenge') || '';

      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { sub: username, groups, nonce, redirectUri, codeChallenge });
      setTimeout(() => codes.delete(code), 300000); // 5 min TTL

      const dest = new URL(redirectUri);
      dest.searchParams.set('code', code);
      if (state) dest.searchParams.set('state', state);

      res.writeHead(302, { Location: dest.toString() });
      res.end();
    });
    return;
  }

  // Token endpoint → exchange code for tokens
  if (req.method === 'POST' && url.pathname === '/token') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const code = params.get('code');
      const codeVerifier = params.get('code_verifier');
      const entry = codes.get(code);

      if (!entry) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Unknown code' }));
      }

      // Verify PKCE if code_challenge was set
      if (entry.codeChallenge && codeVerifier) {
        const expected = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
        if (expected !== entry.codeChallenge) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE mismatch' }));
        }
      }

      codes.delete(code);

      const now = Math.floor(Date.now() / 1000);
      const idToken = signJwt({
        iss: BASE_URL,
        sub: entry.sub,
        aud: params.get('client_id') || 'orkllm-test',
        exp: now + 3600,
        iat: now,
        nonce: entry.nonce,
        preferred_username: entry.sub,
        email: `${entry.sub}@mock.test`,
        groups: entry.groups,
      });

      const accessToken = signJwt({ iss: BASE_URL, sub: entry.sub, exp: now + 3600, iat: now });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: accessToken, id_token: idToken, token_type: 'Bearer', expires_in: 3600 }));
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[MockOIDC] Listening on ${BASE_URL}`);
  console.log(`[MockOIDC] Discovery: ${BASE_URL}/.well-known/openid-configuration`);
});
