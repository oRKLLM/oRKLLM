import { getCredentials, saveCredentials, verifyCredentials, MODELS_DIR, LIBRKLLMRT_PATH } from '../config.js';
import pool from '../pool.js';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getStats, clearSessionStats, clearAllTimeStats } from '../stats.js';
import { dbGetSetting, dbSetSetting, dbGetModelSettings, dbSetModelSettings, dbDeleteModelSettings } from '../db.js';

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
 * Sign session details into a cookie string
 * @param {string} username 
 * @returns {string} signed cookie value
 */
function signCookie(username) {
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = `${username}|${expires}`;
  const hmac = crypto.createHmac('sha256', cookieSecret).update(payload).digest('hex');
  return `${payload}|${hmac}`;
}

/**
 * Verify cookie payload and signature
 * @param {string} cookieValue 
 * @returns {string|null} username if valid, null otherwise
 */
function verifyCookie(cookieValue) {
  if (!cookieValue) return null;
  try {
    const parts = cookieValue.split('|');
    if (parts.length !== 3) return null;
    const [username, expiresStr, signature] = parts;
    const expires = parseInt(expiresStr);
    if (Date.now() > expires) return null;
    
    const payload = `${username}|${expires}`;
    const expectedHmac = crypto.createHmac('sha256', cookieSecret).update(payload).digest('hex');
    if (signature === expectedHmac) {
      return username;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

export default async function adminRoutes(fastify, options) {
  
  // Middleware Hook to intercept and verify sessions
  fastify.addHook('preHandler', async (request, reply) => {
    const publicPaths = [
      '/api/admin/auth-status',
      '/api/admin/setup',
      '/api/admin/login'
    ];
    const urlPath = request.url.split('?')[0];
    if (publicPaths.includes(urlPath)) {
      return;
    }

    if (request.url.startsWith('/api/admin/')) {
      const cookie = request.cookies.orkllm_session;
      const user = verifyCookie(cookie);
      if (!user) {
        reply.status(401).send({ error: 'Unauthorized. Please login.' });
      } else {
        request.user = user;
      }
    }
  });

  // GET /api/admin/auth-status
  fastify.get('/auth-status', async (request, reply) => {
    const creds = getCredentials();
    if (!creds) {
      return { status: 'need_setup' };
    }
    
    const cookie = request.cookies.orkllm_session;
    const user = verifyCookie(cookie);
    if (user) {
      return { status: 'authenticated', username: user };
    }
    
    return { status: 'need_login' };
  });

  // POST /api/admin/reset-for-testing — only available in mock/test mode
  if (process.env.ORKLLM_MOCK) {
    fastify.post('/reset-for-testing', async (request, reply) => {
      const { dbResetForTesting } = await import('../db.js');
      dbResetForTesting();
      pool.unloadAll?.();
      return { ok: true };
    });
  }

  // POST /api/admin/setup
  fastify.post('/setup', async (request, reply) => {
    const creds = getCredentials();
    if (creds) {
      return reply.status(400).send({ error: 'Setup already completed' });
    }

    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password required' });
    }
    if (password.length < 6) {
      return reply.status(400).send({ error: 'Password must be at least 6 characters long' });
    }

    saveCredentials(username, password);
    const sessionCookie = signCookie(username);
    
    reply.setCookie('orkllm_session', sessionCookie, {
      path: '/',
      httpOnly: true,
      secure: false, // Set to true if deployed with SSL
      sameSite: 'strict',
      maxAge: 24 * 60 * 60
    });

    return { success: true };
  });

  // POST /api/admin/login
  fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password required' });
    }

    const isValid = verifyCredentials(username, password);
    if (!isValid) {
      return reply.status(401).send({ error: 'Invalid username or password' });
    }

    const sessionCookie = signCookie(username);
    reply.setCookie('orkllm_session', sessionCookie, {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60
    });

    return { success: true };
  });

  // POST /api/admin/logout
  fastify.post('/logout', async (request, reply) => {
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
        hfToken: dbGetSetting('hf_token') ?? ''
      }
    };
  });

  // POST /api/admin/global-settings
  fastify.post('/global-settings', async (request, reply) => {
    const { idleTimeoutMinutes, temperature, topP, topK, maxNewTokens, repPenalty, hfToken } = request.body || {};
    if (typeof idleTimeoutMinutes === 'number') {
      pool.setIdleTimeout(idleTimeoutMinutes);
    }
    if (typeof temperature === 'number') dbSetSetting('default_temperature', temperature);
    if (typeof topP === 'number') dbSetSetting('default_top_p', topP);
    if (typeof topK === 'number') dbSetSetting('default_top_k', topK);
    if (typeof maxNewTokens === 'number') dbSetSetting('default_max_new_tokens', maxNewTokens);
    if (typeof repPenalty === 'number') dbSetSetting('default_rep_penalty', repPenalty);
    if (typeof hfToken === 'string') dbSetSetting('hf_token', hfToken);
    return { success: true };
  });

  // POST /api/admin/change-password
  fastify.post('/change-password', async (request, reply) => {
    const { currentPassword, newPassword } = request.body || {};
    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: 'currentPassword and newPassword required' });
    }
    if (newPassword.length < 6) {
      return reply.status(400).send({ error: 'Password must be at least 6 characters' });
    }
    const user = request.user;
    const isValid = verifyCredentials(user, currentPassword);
    if (!isValid) {
      return reply.status(401).send({ error: 'Current password is incorrect' });
    }
    saveCredentials(user, newPassword);
    return { success: true };
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
