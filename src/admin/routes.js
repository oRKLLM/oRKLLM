import { getCredentials, saveCredentials, verifyCredentials, hashPassword, checkPassword, MODELS_DIR, LIBRKLLMRT_PATH } from '../config.js';
import { clearAllCache, getCacheStats } from '../cache.js';
import pool from '../pool.js';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getStats, clearSessionStats, clearAllTimeStats } from '../stats.js';
import {
  dbGetSetting, dbSetSetting, dbGetModelSettings, dbSetModelSettings, dbDeleteModelSettings,
  dbCreateUser, dbGetUserById, dbGetUserByUsername, dbGetUserBySubject, dbListUsers, dbUpdateUser, dbUsersEmpty,
  dbGetAuthProviderConfig, dbSetAuthProviderConfig, dbClearAuthProviderConfig,
  dbLogAudit, dbGetAuditLog,
} from '../db.js';
import { v4 as uuidv4 } from 'uuid';

function getOrCreateCookieSecret() {
  let secret = dbGetSetting('cookie_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    dbSetSetting('cookie_secret', secret);
  }
  return secret;
}

function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = ['localhost', '127.0.0.1'];
  
  try {
    const hostname = os.hostname();
    if (hostname && !addresses.includes(hostname)) {
      addresses.push(hostname);
      if (!hostname.includes('.')) {
        addresses.push(`${hostname}.local`);
      }
    }
  } catch (e) {}

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  
  return Array.from(new Set(addresses));
}

const cookieSecret = getOrCreateCookieSecret();

/**
 * Sign session cookie: userId|username|role|expires|hmac
 * Backward-compatible: old format username|expires|hmac is detected by part count.
 */
function signCookie(userId, username, role) {
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  const payload = `${userId}|${username}|${role}|${expires}`;
  const hmac = crypto.createHmac('sha256', cookieSecret).update(payload).digest('hex');
  return `${payload}|${hmac}`;
}

/**
 * Verify cookie → { id, username, role } or null.
 * Handles both new 5-part format and legacy 3-part format.
 */
function verifyCookie(cookieValue) {
  if (!cookieValue) return null;
  try {
    const parts = cookieValue.split('|');

    if (parts.length === 5) {
      // New format: userId|username|role|expires|hmac
      const [userId, username, role, expiresStr, signature] = parts;
      const expires = parseInt(expiresStr);
      if (Date.now() > expires) return null;
      const payload = `${userId}|${username}|${role}|${expires}`;
      const expected = crypto.createHmac('sha256', cookieSecret).update(payload).digest('hex');
      if (signature === expected) return { id: userId, username, role };
    } else if (parts.length === 3) {
      // Legacy format: username|expires|hmac
      const [username, expiresStr, signature] = parts;
      const expires = parseInt(expiresStr);
      if (Date.now() > expires) return null;
      const payload = `${username}|${expires}`;
      const expected = crypto.createHmac('sha256', cookieSecret).update(payload).digest('hex');
      if (signature === expected) return { id: 'local-admin', username, role: 'admin' };
    }
  } catch (e) {}
  return null;
}

/**
 * Migrate legacy single-user auth table to multi-user users table on first use.
 */
function migrateIfNeeded() {
  if (!dbUsersEmpty()) return;
  const creds = getCredentials();
  if (!creds) return;
  try {
    dbCreateUser({
      id: 'local-admin',
      username: creds.username,
      email: null,
      role: 'admin',
      authProvider: 'local',
      authSubject: null,
      passwordHash: creds.hash,
      passwordSalt: creds.salt,
    });
    console.log('[Auth] Migrated legacy credentials to multi-user table');
  } catch (e) {
    console.error('[Auth] Migration error:', e.message);
  }
}

function logAudit(request, action, resource) {
  try {
    const user = request.user;
    dbLogAudit({
      id: uuidv4(),
      userId: user?.id ?? null,
      username: user?.username ?? 'anonymous',
      action,
      resource: resource ?? null,
      ipAddress: request.ip ?? null,
    });
  } catch (e) {}
}

function issueSessionCookie(reply, user) {
  const cookie = signCookie(user.id, user.username, user.role);
  reply.setCookie('orkllm_session', cookie, {
    path: '/', httpOnly: true, secure: false, sameSite: 'lax', maxAge: 24 * 60 * 60,
  });
}

export default async function adminRoutes(fastify, options) {

  // Run migration once on startup
  migrateIfNeeded();

  // ── Authentication middleware ────────────────────────────────────────────
  fastify.addHook('preHandler', async (request, reply) => {
    const publicPaths = [
      '/api/admin/auth-status',
      '/api/admin/setup',
      '/api/admin/login',
      '/api/admin/oidc/authorize',
      '/api/admin/oidc/callback',
      '/api/admin/saml/login',
      '/api/admin/saml/acs',
      '/api/admin/saml/metadata',
      '/api/admin/reset-for-testing', // test-only, gated by ORKLLM_MOCK check on the route itself
    ];
    const urlPath = request.url.split('?')[0];
    if (publicPaths.includes(urlPath)) return;

    if (request.url.startsWith('/api/admin/')) {
      const cookie = request.cookies.orkllm_session;
      const session = verifyCookie(cookie);
      if (!session) {
        return reply.status(401).send({ error: 'Unauthorized. Please login.' });
      }
      // Attach full user object from DB (ensures role is current even if cookie is old)
      const userRow = dbGetUserById(session.id);
      request.user = userRow
        ? { id: userRow.id, username: userRow.username, email: userRow.email, role: userRow.role, authProvider: userRow.auth_provider }
        : session; // fallback to cookie data for legacy-migrated sessions
    }
  });

  function requireAdmin(request, reply, done) {
    if (request.user?.role !== 'admin') {
      reply.status(403).send({ error: 'Admin access required' });
    } else {
      done();
    }
  }

  // ── Auth status ──────────────────────────────────────────────────────────
  fastify.get('/auth-status', async (request, reply) => {
    // Check if any users exist (includes legacy auth table)
    const hasUsers = !dbUsersEmpty() || !!getCredentials();
    if (!hasUsers) return { status: 'need_setup' };

    const cookie = request.cookies.orkllm_session;
    const session = verifyCookie(cookie);
    if (!session) {
      const provCfg = dbGetAuthProviderConfig();
      return {
        status: 'need_login',
        oidcEnabled: provCfg?.providerType === 'oidc',
        samlEnabled: provCfg?.providerType === 'saml',
        providerName: provCfg?.config?.displayName ?? null,
        localAuthDisabled: dbGetSetting('local_auth_disabled') === '1',
      };
    }

    // Fetch current user from DB to return up-to-date info
    const userRow = dbGetUserById(session.id);
    const user = userRow
      ? { id: userRow.id, username: userRow.username, email: userRow.email, role: userRow.role, authProvider: userRow.auth_provider }
      : { id: session.id, username: session.username, role: session.role, authProvider: 'local' };

    const providerCfg = dbGetAuthProviderConfig();
    return {
      status: 'authenticated',
      username: user.username, // backward compat
      user,
      oidcEnabled: providerCfg?.providerType === 'oidc',
      samlEnabled: providerCfg?.providerType === 'saml',
      providerName: providerCfg?.config?.displayName ?? null,
      localAuthDisabled: dbGetSetting('local_auth_disabled') === '1',
    };
  });

  // ── Test reset (mock mode only) ──────────────────────────────────────────
  if (process.env.ORKLLM_MOCK) {
    fastify.post('/reset-for-testing', async (request, reply) => {
      const { dbResetForTesting } = await import('../db.js');
      dbResetForTesting();
      pool.unloadAll?.();
      return { ok: true };
    });
  }

  // ── Setup (first-time admin account creation) ────────────────────────────
  fastify.post('/setup', async (request, reply) => {
    const hasUsers = !dbUsersEmpty() || !!getCredentials();
    if (hasUsers) return reply.status(400).send({ error: 'Setup already completed' });

    const { username, password } = request.body || {};
    if (!username || !password) return reply.status(400).send({ error: 'Username and password required' });
    if (password.length < 6) return reply.status(400).send({ error: 'Password must be at least 6 characters long' });

    const { hash, salt } = hashPassword(password);
    const id = uuidv4();
    dbCreateUser({ id, username, email: null, role: 'admin', authProvider: 'local', authSubject: null, passwordHash: hash, passwordSalt: salt });
    // Keep legacy auth table in sync for backward compatibility
    saveCredentials(username, password);

    issueSessionCookie(reply, { id, username, role: 'admin' });
    logAudit({ user: { id, username }, ip: request.ip }, 'setup', null);
    return { success: true };
  });

  // ── Local login ──────────────────────────────────────────────────────────
  fastify.post('/login', async (request, reply) => {
    if (dbGetSetting('local_auth_disabled') === '1') {
      return reply.status(403).send({ error: 'Local authentication is disabled. Use your configured SSO provider.' });
    }

    const { username, password } = request.body || {};
    if (!username || !password) return reply.status(400).send({ error: 'Username and password required' });

    const { valid, user } = verifyCredentials(username, password);
    if (!valid || !user) {
      return reply.status(401).send({ error: 'Invalid username or password' });
    }

    // Update last_login timestamp
    if (user.id !== 'local-admin') dbUpdateUser(user.id, { last_login_at: Date.now() });

    const sessionUser = { id: user.id, username: user.username, role: user.role };
    issueSessionCookie(reply, sessionUser);
    logAudit({ user: sessionUser, ip: request.ip }, 'login', null);
    return { success: true };
  });

  // ── Logout ───────────────────────────────────────────────────────────────
  fastify.post('/logout', async (request, reply) => {
    logAudit(request, 'logout', null);
    reply.clearCookie('orkllm_session', { path: '/' });
    return { success: true };
  });

  // GET /api/admin/status
  fastify.get('/status', async (request, reply) => {
    const status = pool.getStatus();
    const port = request.server.server.address()?.port || 8000;
    status.networkAddresses = getNetworkAddresses();
    status.port = port;
    status.libPath = LIBRKLLMRT_PATH;
    return status;
  });

  // GET /api/admin/stats
  fastify.get('/stats', async (request, reply) => {
    return getStats();
  });

  // POST /api/admin/stats/clear-session
  fastify.post('/stats/clear-session', async (request, reply) => {
    clearSessionStats();
    return { success: true };
  });

  // POST /api/admin/stats/clear-all
  fastify.post('/stats/clear-all', async (request, reply) => {
    clearAllTimeStats();
    return { success: true };
  });

  // POST /api/admin/load
  fastify.post('/load', async (request, reply) => {
    const { model, options } = request.body || {};
    if (!model) {
      return reply.status(400).send({ error: 'Model name required' });
    }
    try {
      const res = await pool.load(model, options || {});
      return { success: true, activeModel: res.activeModel };
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // POST /api/admin/unload
  fastify.post('/unload', async (request, reply) => {
    try {
      await pool.unload();
      return { success: true };
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // POST /api/admin/timeout
  fastify.post('/timeout', async (request, reply) => {
    const { timeout } = request.body || {};
    if (typeof timeout !== 'number') {
      return reply.status(400).send({ error: 'Timeout value in minutes required' });
    }
    pool.setIdleTimeout(timeout);
    return { success: true, idleTimeoutMs: pool.idleTimeoutMs };
  });

  // GET /api/admin/global-settings
  fastify.get('/global-settings', async (request, reply) => {
    const port = request.server.server.address()?.port || 8000;
    const host = process.env.ORKLLM_HOST || '127.0.0.1';
    return {
      server: {
        host,
        port,
        libPath: LIBRKLLMRT_PATH,
        modelsDir: MODELS_DIR
      },
      settings: {
        idleTimeoutMinutes: parseInt(dbGetSetting('idle_timeout_minutes') ?? '5'),
        temperature: parseFloat(dbGetSetting('default_temperature') ?? '0.8'),
        topP: parseFloat(dbGetSetting('default_top_p') ?? '0.9'),
        topK: parseInt(dbGetSetting('default_top_k') ?? '40'),
        maxNewTokens: parseInt(dbGetSetting('default_max_new_tokens') ?? '512'),
        repPenalty: parseFloat(dbGetSetting('default_rep_penalty') ?? '1.0'),
        hfToken: dbGetSetting('hf_token') ?? '',
        cacheEnabled:          dbGetSetting('cache_enabled') === '1',
        cacheHotLimitMB:       parseInt(dbGetSetting('cache_hot_limit_mb')          ?? '512'),
        cacheColdLimitMB:      parseInt(dbGetSetting('cache_cold_limit_mb')         ?? String(10 * 1024)),
        cacheDir:              dbGetSetting('cache_dir') ?? '',
        cacheMaxContextTokens: parseInt(dbGetSetting('cache_max_context_tokens')    ?? '3500'),
      },
      cacheStats: getCacheStats()
    };
  });

  // POST /api/admin/global-settings
  fastify.post('/global-settings', async (request, reply) => {
    const { idleTimeoutMinutes, temperature, topP, topK, maxNewTokens, repPenalty, hfToken,
            cacheEnabled, cacheHotLimitMB, cacheColdLimitMB, cacheDir, cacheMaxContextTokens,
            localAuthDisabled } = request.body || {};
    if (typeof idleTimeoutMinutes === 'number') {
      pool.setIdleTimeout(idleTimeoutMinutes);
    }
    if (typeof temperature === 'number') dbSetSetting('default_temperature', temperature);
    if (typeof topP === 'number') dbSetSetting('default_top_p', topP);
    if (typeof topK === 'number') dbSetSetting('default_top_k', topK);
    if (typeof maxNewTokens === 'number') dbSetSetting('default_max_new_tokens', maxNewTokens);
    if (typeof repPenalty === 'number') dbSetSetting('default_rep_penalty', repPenalty);
    if (typeof hfToken === 'string') dbSetSetting('hf_token', hfToken);
    if (typeof cacheEnabled === 'boolean') dbSetSetting('cache_enabled', cacheEnabled ? '1' : '0');
    if (typeof cacheHotLimitMB === 'number')  dbSetSetting('cache_hot_limit_mb',        cacheHotLimitMB);
    if (typeof cacheColdLimitMB === 'number') dbSetSetting('cache_cold_limit_mb',       cacheColdLimitMB);
    if (typeof cacheDir === 'string')         dbSetSetting('cache_dir',                 cacheDir);
    if (typeof cacheMaxContextTokens === 'number') dbSetSetting('cache_max_context_tokens', cacheMaxContextTokens);
    if (typeof localAuthDisabled === 'boolean') dbSetSetting('local_auth_disabled', localAuthDisabled ? '1' : '0');
    logAudit(request, 'settings_change', null);
    return { success: true };
  });

  // DELETE /api/admin/cache — clear all prefix cache files
  fastify.delete('/cache', async (request, reply) => {
    clearAllCache();
    return { success: true };
  });

  // POST /api/admin/change-password
  fastify.post('/change-password', async (request, reply) => {
    const { currentPassword, newPassword } = request.body || {};
    if (!currentPassword || !newPassword) return reply.status(400).send({ error: 'currentPassword and newPassword required' });
    if (newPassword.length < 6) return reply.status(400).send({ error: 'Password must be at least 6 characters' });

    const reqUser = request.user;
    const userRow = dbGetUserById(reqUser.id);
    if (userRow?.auth_provider !== 'local') return reply.status(400).send({ error: 'Password change not available for federated accounts' });

    // Verify current password
    const { valid } = verifyCredentials(reqUser.username, currentPassword);
    if (!valid) return reply.status(401).send({ error: 'Current password is incorrect' });

    const { hash, salt } = hashPassword(newPassword);
    if (userRow) {
      dbUpdateUser(reqUser.id, { password_hash: hash, password_salt: salt });
    }
    saveCredentials(reqUser.username, newPassword); // keep legacy table in sync
    logAudit(request, 'change_password', null);
    return { success: true };
  });

  // ── User management (admin only) ─────────────────────────────────────────

  fastify.get('/users', { preHandler: requireAdmin }, async (request, reply) => {
    return dbListUsers();
  });

  fastify.post('/users', { preHandler: requireAdmin }, async (request, reply) => {
    const { username, email, password, role } = request.body || {};
    if (!username || !password) return reply.status(400).send({ error: 'username and password required' });
    if (password.length < 6) return reply.status(400).send({ error: 'Password must be at least 6 characters' });
    if (role && !['admin', 'user'].includes(role)) return reply.status(400).send({ error: 'Invalid role' });
    if (dbGetUserByUsername(username)) return reply.status(409).send({ error: 'Username already exists' });

    const { hash, salt } = hashPassword(password);
    const id = uuidv4();
    dbCreateUser({ id, username, email: email ?? null, role: role ?? 'user', authProvider: 'local', authSubject: null, passwordHash: hash, passwordSalt: salt });
    logAudit(request, 'create_user', username);
    return { success: true, id };
  });

  fastify.patch('/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params;
    const { role, is_active, email } = request.body || {};
    if (id === request.user.id && is_active === 0) return reply.status(400).send({ error: 'Cannot deactivate your own account' });
    const fields = {};
    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) return reply.status(400).send({ error: 'Invalid role' });
      fields.role = role;
    }
    if (is_active !== undefined) fields.is_active = is_active ? 1 : 0;
    if (email !== undefined) fields.email = email;
    dbUpdateUser(id, fields);
    logAudit(request, 'update_user', id);
    return { success: true };
  });

  fastify.delete('/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params;
    if (id === request.user.id) return reply.status(400).send({ error: 'Cannot deactivate your own account' });
    dbUpdateUser(id, { is_active: 0 });
    logAudit(request, 'deactivate_user', id);
    return { success: true };
  });

  // ── Auth provider config (admin only) ────────────────────────────────────

  fastify.get('/auth-provider', { preHandler: requireAdmin }, async (request, reply) => {
    const cfg = dbGetAuthProviderConfig();
    if (!cfg) return { providerType: null, config: {} };
    // Redact secret fields
    const safeConfig = { ...cfg.config };
    if (safeConfig.clientSecret) safeConfig.clientSecret = '••••••••';
    return { providerType: cfg.providerType, config: safeConfig };
  });

  fastify.post('/auth-provider', { preHandler: requireAdmin }, async (request, reply) => {
    const { providerType, config } = request.body || {};
    if (!providerType || !['oidc', 'saml'].includes(providerType)) return reply.status(400).send({ error: 'providerType must be oidc or saml' });

    // If updating and there's an existing secret placeholder, keep the stored secret
    const existing = dbGetAuthProviderConfig();
    if (existing?.providerType === providerType && config.clientSecret === '••••••••') {
      config.clientSecret = existing.config.clientSecret;
    }

    dbSetAuthProviderConfig(providerType, config);
    logAudit(request, 'update_auth_provider', providerType);
    return { success: true };
  });

  fastify.delete('/auth-provider', { preHandler: requireAdmin }, async (request, reply) => {
    dbClearAuthProviderConfig();
    logAudit(request, 'disable_auth_provider', null);
    return { success: true };
  });

  // ── Audit log (admin only) ────────────────────────────────────────────────

  fastify.get('/audit-log', { preHandler: requireAdmin }, async (request, reply) => {
    const limit = parseInt(request.query.limit ?? '200');
    return dbGetAuditLog(Math.min(limit, 1000));
  });

  // ── OIDC endpoints ────────────────────────────────────────────────────────

  fastify.get('/oidc/authorize', async (request, reply) => {
    const cfg = dbGetAuthProviderConfig();
    if (cfg?.providerType !== 'oidc') return reply.status(400).send({ error: 'OIDC not configured' });
    const c = cfg.config;

    // Build authorization URL manually (avoids needing openid-client's full issuer discovery at this stage)
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    reply.setCookie('oidc_state', state, { path: '/', httpOnly: true, maxAge: 600 });
    reply.setCookie('oidc_nonce', nonce, { path: '/', httpOnly: true, maxAge: 600 });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
    });
    const authUrl = `${c.issuer.replace(/\/$/, '')}/protocol/openid-connect/auth?${params}`;
    return reply.redirect(authUrl);
  });

  fastify.get('/oidc/callback', async (request, reply) => {
    const cfg = dbGetAuthProviderConfig();
    if (cfg?.providerType !== 'oidc') return reply.status(400).send({ error: 'OIDC not configured' });
    const c = cfg.config;

    const { code, state, error: oidcError } = request.query;
    if (oidcError) return reply.redirect(`/?oidc_error=${encodeURIComponent(oidcError)}`);

    const storedState = request.cookies.oidc_state;
    if (!storedState || storedState !== state) return reply.status(400).send({ error: 'Invalid state parameter' });

    // Exchange code for tokens
    let tokenData;
    try {
      const { Issuer } = await import('openid-client');
      const issuer = await Issuer.discover(c.issuer);
      const client = new issuer.Client({ client_id: c.clientId, client_secret: c.clientSecret });
      const tokenSet = await client.callback(c.redirectUri, { code, state }, { state, nonce: request.cookies.oidc_nonce });
      tokenData = tokenSet.claims();
    } catch (e) {
      console.error('[OIDC] Token exchange failed:', e.message);
      return reply.redirect(`/?oidc_error=${encodeURIComponent('Authentication failed')}`);
    }

    const usernameClaim = c.usernameClaim || 'preferred_username';
    const emailClaim = c.emailClaim || 'email';
    const groupsClaim = c.groupsClaim || 'groups';
    const subject = tokenData.sub;
    const username = tokenData[usernameClaim] || tokenData.email || subject;
    const email = tokenData[emailClaim] || null;
    const groups = tokenData[groupsClaim] || [];

    // Determine role from group mapping
    let role = c.defaultRole || 'user';
    for (const mapping of (c.groupRoleMap || [])) {
      if (groups.includes(mapping.group)) { role = mapping.role; break; }
    }

    // Upsert user
    let user = dbGetUserBySubject('oidc', subject);
    if (!user) {
      if (!c.autoProvision) return reply.redirect(`/?oidc_error=${encodeURIComponent('User not provisioned. Contact your administrator.')}`);
      const id = uuidv4();
      dbCreateUser({ id, username, email, role, authProvider: 'oidc', authSubject: subject, passwordHash: null, passwordSalt: null });
      user = dbGetUserById(id);
    } else {
      dbUpdateUser(user.id, { last_login_at: Date.now(), email: email ?? user.email });
    }

    issueSessionCookie(reply, { id: user.id, username: user.username, role: user.role });
    logAudit({ user: { id: user.id, username: user.username }, ip: request.ip }, 'oidc_login', null);
    reply.clearCookie('oidc_state').clearCookie('oidc_nonce');
    return reply.redirect('/');
  });

  // ── SAML endpoints ────────────────────────────────────────────────────────

  fastify.get('/saml/metadata', async (request, reply) => {
    const cfg = dbGetAuthProviderConfig();
    if (cfg?.providerType !== 'saml') return reply.status(400).send({ error: 'SAML not configured' });

    const baseUrl = `${request.protocol}://${request.hostname}`;
    const entityId = `${baseUrl}/api/admin/saml/metadata`;
    const acsUrl = `${baseUrl}/api/admin/saml/acs`;

    const xml = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
                   AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                              Location="${acsUrl}" index="0"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
    reply.header('Content-Type', 'application/xml');
    return xml;
  });

  fastify.get('/saml/login', async (request, reply) => {
    const cfg = dbGetAuthProviderConfig();
    if (cfg?.providerType !== 'saml') return reply.status(400).send({ error: 'SAML not configured' });
    const c = cfg.config;

    try {
      const samlify = await import('samlify');
      const sp = samlify.ServiceProvider({
        entityID: `${request.protocol}://${request.hostname}/api/admin/saml/metadata`,
        assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${request.protocol}://${request.hostname}/api/admin/saml/acs` }],
      });
      const idp = samlify.IdentityProvider({ metadata: c.idpMetadataXml });
      const { context } = sp.createLoginRequest(idp, 'redirect');
      return reply.redirect(context);
    } catch (e) {
      console.error('[SAML] Login request failed:', e.message);
      return reply.status(500).send({ error: 'SAML login failed' });
    }
  });

  fastify.post('/saml/acs', async (request, reply) => {
    const cfg = dbGetAuthProviderConfig();
    if (cfg?.providerType !== 'saml') return reply.status(400).send({ error: 'SAML not configured' });
    const c = cfg.config;

    let samlUser;
    try {
      const samlify = await import('samlify');
      samlify.setSchemaValidator({ validate: () => Promise.resolve('skipped') }); // permissive for now
      const sp = samlify.ServiceProvider({
        entityID: `${request.protocol}://${request.hostname}/api/admin/saml/metadata`,
        assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${request.protocol}://${request.hostname}/api/admin/saml/acs` }],
      });
      const idp = samlify.IdentityProvider({ metadata: c.idpMetadataXml });
      const { extract } = await sp.parseLoginResponse(idp, 'post', { body: request.body });
      samlUser = extract;
    } catch (e) {
      console.error('[SAML] ACS parse failed:', e.message);
      return reply.redirect(`/?saml_error=${encodeURIComponent('SAML authentication failed')}`);
    }

    const nameId = samlUser.nameID || samlUser.nameId;
    const attrs = samlUser.attributes || {};
    const usernamePath = c.samlUsernamePath || 'uid';
    const emailPath = c.samlEmailPath || 'email';
    const groupsPath = c.samlGroupsPath || 'groups';
    const username = attrs[usernamePath]?.[0] || nameId;
    const email = attrs[emailPath]?.[0] || null;
    const groups = attrs[groupsPath] || [];

    let role = c.defaultRole || 'user';
    for (const mapping of (c.groupRoleMap || [])) {
      if (groups.includes(mapping.group)) { role = mapping.role; break; }
    }

    let user = dbGetUserBySubject('saml', nameId);
    if (!user) {
      if (!c.autoProvision) return reply.redirect(`/?saml_error=${encodeURIComponent('User not provisioned. Contact your administrator.')}`);
      const id = uuidv4();
      dbCreateUser({ id, username, email, role, authProvider: 'saml', authSubject: nameId, passwordHash: null, passwordSalt: null });
      user = dbGetUserById(id);
    } else {
      dbUpdateUser(user.id, { last_login_at: Date.now(), email: email ?? user.email });
    }

    issueSessionCookie(reply, { id: user.id, username: user.username, role: user.role });
    logAudit({ user: { id: user.id, username: user.username }, ip: request.ip }, 'saml_login', null);
    return reply.redirect('/');
  });

  // GET /api/admin/models/settings/:modelId
  fastify.get('/models/settings/:modelId', async (request, reply) => {
    const { modelId } = request.params;
    if (!modelId || modelId.includes('/') || modelId.includes('..')) {
      return reply.status(400).send({ error: 'Invalid model ID' });
    }
    const settings = dbGetModelSettings(modelId);
    return { modelId, settings };
  });

  // POST /api/admin/models/settings/:modelId
  fastify.post('/models/settings/:modelId', async (request, reply) => {
    const { modelId } = request.params;
    if (!modelId || modelId.includes('/') || modelId.includes('..')) {
      return reply.status(400).send({ error: 'Invalid model ID' });
    }
    const settings = request.body || {};
    dbSetModelSettings(modelId, settings);
    return { success: true, modelId, settings };
  });

  // GET /api/admin/hf/search?q=<query>&sort=downloads&rkllm=true&limit=20
  fastify.get('/hf/search', async (request, reply) => {
    const { q = '', sort = 'downloads', rkllm = 'false', limit = '20' } = request.query;
    const hfToken = dbGetSetting('hf_token') ?? '';
    const params = new URLSearchParams({
      search: rkllm === 'true' ? `${q} rkllm`.trim() : q,
      sort,
      direction: '-1',
      limit: String(Math.min(parseInt(limit) || 20, 50)),
      full: 'true',
    });
    const headers = { 'User-Agent': 'oRKLLM/1.0' };
    if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
    try {
      const res = await fetch(`https://huggingface.co/api/models?${params}`, { headers });
      if (!res.ok) return reply.status(res.status).send({ error: `HuggingFace API error: ${res.status}` });
      const models = await res.json();
      return models.map(m => ({
        id: m.id,
        downloads: m.downloads ?? 0,
        likes: m.likes ?? 0,
        tags: (m.tags ?? []).slice(0, 8),
        lastModified: m.lastModified,
        private: m.private ?? false,
      }));
    } catch (e) {
      return reply.status(502).send({ error: `Failed to reach HuggingFace: ${e.message}` });
    }
  });

  // GET /api/admin/hf/collection?url=<collection_url>
  fastify.get('/hf/collection', async (request, reply) => {
    const { url = '' } = request.query;
    // Accept full URLs: https://huggingface.co/collections/Qwen/qwen3-6787119e1f61f98e08fd3b4b
    // or short URLs:   https://huggingface.co/collections/Qwen/qwen3  (no hash)
    // Also accept bare paths: Qwen/qwen3
    let org, slug;
    const urlMatch = url.match(/(?:huggingface\.co\/collections\/)?([^/\s]+)\/([^/?#\s]+)/);
    if (!urlMatch) return reply.status(400).send({ error: 'Invalid collection URL. Expected: https://huggingface.co/collections/<org>/<slug>' });
    [, org, slug] = urlMatch;

    const hfToken = dbGetSetting('hf_token') ?? '';
    const headers = { 'User-Agent': 'oRKLLM/1.0' };
    if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

    async function fetchCollection(fullSlug) {
      const res = await fetch(`https://huggingface.co/api/collections/${fullSlug}`, { headers });
      if (!res.ok) return null;
      return res.json();
    }

    async function resolveSlug() {
      // Try the slug as-is first (works when the full hash slug is provided)
      const direct = await fetchCollection(`${org}/${slug}`);
      if (direct) return direct;

      // Short slug: search owner's collections and find the closest match
      const listRes = await fetch(`https://huggingface.co/api/collections?owner=${org}&limit=100`, { headers });
      if (!listRes.ok) return null;
      const list = await listRes.json();

      // Match: slug starts with <org>/<short_slug> (exact name, ignoring the trailing hash)
      const prefix = `${org}/${slug}`;
      const candidates = (list ?? []).filter(c => {
        const s = c.slug ?? '';
        // Match if slug equals prefix or slug starts with prefix + '-' then a hex hash
        return s === prefix || s.startsWith(prefix + '-');
      });

      // Prefer the shortest match (most exact name), then most downloads
      candidates.sort((a, b) => {
        const lenDiff = (a.slug?.length ?? 999) - (b.slug?.length ?? 999);
        if (lenDiff !== 0) return lenDiff;
        return (b.likes ?? 0) - (a.likes ?? 0);
      });

      if (!candidates.length) return null;
      return fetchCollection(candidates[0].slug);
    }

    try {
      const col = await resolveSlug();
      if (!col) return reply.status(404).send({ error: `Collection not found: ${org}/${slug}` });

      // Collection items have model data directly on the item object (not nested under item.item)
      const models = (col.items ?? [])
        .filter(item => item.type === 'model' || item.repoType === 'model')
        .map(item => ({
          id: item.id ?? item.modelId ?? '',
          downloads: item.downloads ?? 0,
          likes: item.likes ?? 0,
          tags: (item.tags ?? []).slice(0, 8),
          lastModified: item.lastModified,
          private: item.private ?? false,
        }))
        .filter(m => m.id);
      return { title: col.title ?? slug, description: col.description ?? '', models };
    } catch (e) {
      return reply.status(502).send({ error: `Failed to reach HuggingFace: ${e.message}` });
    }
  });

  // DELETE /api/admin/models/:modelId
  fastify.delete('/models/:modelId', async (request, reply) => {
    const { modelId } = request.params;
    if (!modelId || modelId.includes('/') || modelId.includes('..') || !modelId.endsWith('.rkllm')) {
      return reply.status(400).send({ error: 'Invalid model ID' });
    }
    const modelPath = path.join(MODELS_DIR, modelId);
    if (!fs.existsSync(modelPath)) {
      return reply.status(404).send({ error: 'Model file not found' });
    }
    if (pool.getStatus().model === modelId) {
      return reply.status(409).send({ error: 'Cannot delete the currently loaded model. Unload it first.' });
    }
    fs.unlinkSync(modelPath);
    dbDeleteModelSettings(modelId);
    return { success: true };
  });
}
