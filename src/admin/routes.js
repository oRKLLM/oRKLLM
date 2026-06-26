import { getCredentials, saveCredentials, verifyCredentials, hashPassword, checkPassword, MODELS_DIR, LIBRKLLMRT_PATH, RUNTIMES_DIR, LLAMA_RUNTIME_DIR, parseRuntimeVersion, getPlatform, getNpuCoreCount, getGpuInfo, getDeviceDrivers } from '../config.js';
import { signCookie, verifyCookie, issueSessionCookie } from '../auth/session.js';
import { clearAllCache, getCacheStats } from '../cache.js';
import pool from '../pool.js';
import { getConversionScheduler } from '../conversion.js';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { getStats, clearSessionStats, clearAllTimeStats } from '../stats.js';
import { getMetricsSnapshot } from '../monitor.js';
import { supportsThinkingToggle } from '../gguf.js';
import {
  dbGetSetting, dbSetSetting, dbGetModelSettings, dbSetModelSettings, dbDeleteModelSettings,
  dbCreateUser, dbGetUserById, dbGetUserByUsername, dbGetUserBySubject, dbListUsers, dbUpdateUser, dbUsersEmpty,
  dbGetAuthProviderConfig, dbSetAuthProviderConfig, dbClearAuthProviderConfig,
  dbLogAudit, dbGetAuditLog, dbGetSchemaVersion,
  dbCreateBenchRun, dbListBenchRuns, dbDeleteBenchRun, dbClearBenchRuns,
} from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { isLlamaRuntimeAvailable, getLlamaRuntimeInfo, getLlamaReleases, syncLlamaRuntime, getLlamaSyncState } from '../llama_sync.js';
import { getDramStatus, getCpuStatus } from '../monitor.js';
import { getState as getPerfState } from '../perf_governor.js';
import { fetchBaseEmbeddings, extractLocalEmbeddings, localBaseHasEmbeddings, findReusableEmbeddings, readEmbeddingsMeta, copyEmbeddings } from '../hf_embeddings.js';
import { convertPtToSafetensors } from '../pt_to_safetensors.js';
import { activeStreams } from '../streams.js';


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

// --- accelerated downloads via aria2c (apt package `aria2`, binary `aria2c`) ---
// 16-connection, resumable HF downloads — far faster than a single Node stream on a
// fat .gguf/.safetensors over a high-latency link. Falls back to the Node stream when
// aria2c isn't on PATH. Pattern follows the well-known hfd HF fast-download helper.
let _aria2Avail = null;
function hasAria2() {
  if (_aria2Avail === null) {
    try { _aria2Avail = spawnSync('aria2c', ['--version'], { stdio: 'ignore' }).status === 0; }
    catch { _aria2Avail = false; }
  }
  return _aria2Avail;
}
function _toBps(n, unit) {
  const u = { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824, KB: 1000, MB: 1e6, GB: 1e9 };
  return Math.round(n * (u[unit] || 1));
}
// Download `url` into `dir/outName` with aria2c; updates job.{bytesDown,speedBps} from aria2's
// progress readout (job.totalBytes is the denominator, set by the caller's HEAD). Resolves on
// success; on job.status==='cancelled' kills aria2c and cleans up; rejects on non-zero exit.
function downloadWithAria2({ url, dir, outName, token, job }) {
  return new Promise((resolve, reject) => {
    const args = ['-c', '-x8', '-s8', '-k1M', '--file-allocation=none', '--summary-interval=1',
      '--console-log-level=warn', '--auto-file-renaming=false', '--allow-overwrite=true',
      '--max-tries=5', '--retry-wait=2', '-d', dir, '-o', outName];
    if (token) args.push(`--header=Authorization: Bearer ${token}`);
    args.push(url);
    const child = spawn('aria2c', args);
    job._proc = child;   // so pause/cancel can signal it
    const onData = (buf) => {
      const s = buf.toString();
      const pm = s.match(/\((\d+)%\)/);
      if (pm && job.totalBytes > 0) job.bytesDown = Math.round(job.totalBytes * (+pm[1]) / 100);
      const dm = s.match(/DL:([\d.]+)([KMG]i?B|B)?/);
      if (dm) job.speedBps = _toBps(+dm[1], dm[2] || 'B');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    // kill on pause OR cancel; the .tmp + .aria2 control file are KEPT (aria2c -c resumes from them)
    const iv = setInterval(() => { if (job.status === 'cancelled' || job.status === 'paused') { try { child.kill('SIGTERM'); } catch {} } }, 300);
    child.on('error', (e) => { clearInterval(iv); job._proc = null; reject(e); });   // ENOENT etc. -> caller may fall back
    child.on('close', (code) => {
      clearInterval(iv); job._proc = null; job.speedBps = 0;
      if (job.status === 'paused') return resolve();   // leave .tmp + .aria2 for resume
      if (job.status === 'cancelled') {
        try { fs.unlinkSync(path.join(dir, outName)); } catch {}
        try { fs.unlinkSync(path.join(dir, outName + '.aria2')); } catch {}
        return resolve();
      }
      if (code === 0) { job.bytesDown = job.totalBytes || job.bytesDown; resolve(); }
      else reject(new Error(`aria2c exited ${code}`));
    });
  });
}
// Single-connection Node-stream download (fallback when aria2c is unavailable). Resumable via a
// Range request from the existing .tmp size; pause stops cleanly and keeps the .tmp for resume.
async function downloadNodeStream({ url, headers, tmpPath, job }) {
  let start = 0; try { start = fs.statSync(tmpPath).size; } catch {}
  const h = { ...headers };
  if (start > 0) h['Range'] = `bytes=${start}-`;
  let res = await fetch(url, { headers: h });
  while (res.status >= 300 && res.status < 400 && res.headers.get('location')) res = await fetch(res.headers.get('location'), { headers: h });
  if (res.status === 416) return;                       // already complete
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const append = res.status === 206;                    // server honored Range
  if (!append) start = 0;
  if (!job.totalBytes) job.totalBytes = parseInt(res.headers.get('content-length') || '0', 10) + start;
  job.bytesDown = start;
  const fileStream = fs.createWriteStream(tmpPath, { flags: append ? 'a' : 'w' });
  const reader = res.body.getReader();
  let lastCheck = Date.now(), base = start;
  while (true) {
    if (job.status === 'cancelled') { reader.cancel(); fileStream.close(); fs.unlink(tmpPath, () => {}); return; }
    if (job.status === 'paused') { reader.cancel(); await new Promise(r => fileStream.end(r)); job.speedBps = 0; return; }  // keep .tmp
    const { value, done } = await reader.read();
    if (done) break;
    fileStream.write(Buffer.from(value));
    job.bytesDown += value.length;
    const now = Date.now();
    if (now - lastCheck >= 500) { job.speedBps = Math.round((job.bytesDown - base) / ((now - lastCheck) / 1000)); base = job.bytesDown; lastCheck = now; }
  }
  await new Promise((rs, rj) => fileStream.end(err => err ? rj(err) : rs()));
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

    const { username, password, autoDownloadRuntimes } = request.body || {};
    if (!username || !password) return reply.status(400).send({ error: 'Username and password required' });
    if (password.length < 6) return reply.status(400).send({ error: 'Password must be at least 6 characters long' });

    const { hash, salt } = hashPassword(password);
    const id = uuidv4();
    dbCreateUser({ id, username, email: null, role: 'admin', authProvider: 'local', authSubject: null, passwordHash: hash, passwordSalt: salt });
    // Keep legacy auth table in sync for backward compatibility
    saveCredentials(username, password);

    if (typeof autoDownloadRuntimes === 'boolean') {
      dbSetSetting('auto_download_runtimes', autoDownloadRuntimes ? '1' : '0');
    }

    issueSessionCookie(reply, { id, username, role: 'admin' });
    logAudit({ user: { id, username }, ip: request.ip }, 'setup', null);

    // Kick off background runtime sync if opted in
    if (autoDownloadRuntimes) {
      import('../runtime_sync.js')
        .then(m => m.syncRuntimes())
        .catch(e => console.error('[Setup] Runtime sync failed:', e.message));
    }

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
    status.schemaVersion = dbGetSchemaVersion();
    // SoC + NPU core count (single source of truth in config.js)
    status.platform = getPlatform();
    status.npuCores = getNpuCoreCount();
    status.gpu = getGpuInfo();   // { model, cores } from the Mali gpuinfo node, or null
    status.drivers = getDeviceDrivers();   // { npu:{name,version}, gpu:{name,version} } or null
    status.llamaRuntime = getLlamaRuntimeInfo();
    const dram = getDramStatus(); // null off-board; { governor, curFreqMhz, maxFreqMhz, throttled }
    status.dram = dram ? { ...dram, management: getPerfState() } : null;
    const cpuFreq = getCpuStatus(); // perf-cluster CPU governor/clock (prefill is CPU-op bound)
    status.cpuFreq = cpuFreq ? { ...cpuFreq, management: getPerfState() } : null;
    status.activeStreams = Array.from(activeStreams.keys());
    return status;
  });

  // GET /api/admin/runtimes — list available versioned librkllmrt.so files + live sync state
  fastify.get('/runtimes', async (request, reply) => {
    const { getSyncState } = await import('../runtime_sync.js');
    const runtimes = pool.constructor.getAvailableRuntimes();
    const systemExists = fs.existsSync(LIBRKLLMRT_PATH);
    const systemVersion = systemExists ? pool.constructor.readSoVersion(LIBRKLLMRT_PATH) : null;
    // Effective runtime = best available candidate (newest versioned runtime, or system fallback)
    const effectiveRuntime = runtimes[0]
      ? { path: runtimes[0].path, version: runtimes[0].version, exists: true, file: runtimes[0].file }
      : { path: LIBRKLLMRT_PATH, version: systemVersion, exists: systemExists };
    return {
      runtimesDir: RUNTIMES_DIR,
      systemRuntime: { path: LIBRKLLMRT_PATH, version: systemVersion, exists: systemExists },
      effectiveRuntime,
      runtimes,
      syncState: getSyncState(),
    };
  });

  // GET /api/admin/stats
  fastify.get('/stats', async (request, reply) => {
    return getStats();
  });

  // GET /api/admin/metrics — a one-shot telemetry snapshot (same shape the
  // /ws/metrics stream pushes) so the Dashboard can prefill its gauges on load
  // instead of waiting for the WebSocket's first tick. Serves the cached
  // snapshot when fresh; recomputes only when stale.
  fastify.get('/metrics', async (request, reply) => {
    const m = await getMetricsSnapshot();
    return { ...m, stats: getStats() };
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
    // Async load: kick the load off and return 202 immediately. A model load
    // can take tens of seconds (CPU-bound gguf prefill), and holding the HTTP
    // request open that long lets a reverse proxy (nginx proxy_read_timeout)
    // reset the connection — the client then sees a spurious "Network error"
    // and the PWA falls back to its offline shell. The client polls
    // GET /api/admin/status for { loading, loadError, isLoaded } instead.
    getConversionScheduler()?.preempt();   // yield the NPU: kill any in-flight .orkpack conversion
    pool.beginLoad(model, options || {});
    return reply.status(202).send({ accepted: true, model });
  });

  // POST /api/admin/abort — stop the in-flight generation. The Chat "Stop" button
  // calls this directly (not just aborting the fetch) because a buffering reverse
  // proxy may not propagate the client's SSE disconnect to the upstream, so the
  // request.raw 'close' handler in routes.js can't be relied on. pool.abort() sends
  // {type:'abort'} to the active worker → abort_inference → g_abort breaks the
  // decode loop.
  fastify.post('/abort', async () => {
    await pool.abort();
    return { success: true };
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

  // POST /api/admin/pin — prevent active model from idle-unloading
  fastify.post('/pin', async (request, reply) => {
    if (!pool.isLoaded) return reply.status(409).send({ error: 'No model loaded' });
    pool.setPin(true);
    return { success: true, pinned: true, model: pool.getStatus().model };
  });

  // POST /api/admin/unpin — re-enable idle timeout for active model
  fastify.post('/unpin', async (request, reply) => {
    pool.setPin(false);
    return { success: true, pinned: false, model: pool.getStatus().model };
  });

  // POST /api/admin/langfuse/test — verify Langfuse connectivity
  fastify.post('/langfuse/test', async (request, reply) => {
    const { baseUrl, publicKey, secretKey } = request.body || {};
    const resolvedBaseUrl   = baseUrl   || dbGetSetting('langfuse_base_url')   || '';
    const resolvedPublicKey = publicKey || dbGetSetting('langfuse_public_key') || '';
    const resolvedSecretKey = secretKey || dbGetSetting('langfuse_secret_key') || '';
    if (!resolvedBaseUrl || !resolvedPublicKey || !resolvedSecretKey)
      return reply.status(400).send({ error: 'Langfuse credentials not configured' });
    try {
      const { LangfuseClient } = await import('@langfuse/client');
      const lf = new LangfuseClient({
        publicKey: resolvedPublicKey,
        secretKey: resolvedSecretKey,
        baseUrl:   resolvedBaseUrl,
      });
      // Healthcheck: list projects (v3 API endpoint available on all Langfuse versions)
      const res = await fetch(`${resolvedBaseUrl}/api/public/health`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${resolvedPublicKey}:${resolvedSecretKey}`).toString('base64') },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return reply.status(502).send({ error: `Langfuse returned ${res.status}` });
      return { ok: true };
    } catch (e) {
      return reply.status(502).send({ error: e.message });
    }
  });

  // POST /api/admin/prefill-cache { prompt, savePath }
  // Runs prefill for a prompt, aborts after first decode token, saves KV cache.
  // Returns { firstToken, savedPath } — use firstToken to detect whether saved
  // cache includes decode state (case B) or is a clean prefill snapshot (case A).
  fastify.post('/prefill-cache', async (request, reply) => {
    const { prompt, savePath } = request.body || {};
    if (!prompt || !savePath) return reply.status(400).send({ error: 'prompt and savePath required' });
    if (!pool.isLoaded) return reply.status(409).send({ error: 'No model loaded' });
    try {
      const result = await pool.prefillAndCache(prompt, savePath);
      return result;
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // POST /api/admin/infer-with-cache { prompt, loadCachePath?, saveCachePath?, maxTokens? }
  // Direct inference with explicit cache paths — for testing prefillAndCache output.
  fastify.post('/infer-with-cache', async (request, reply) => {
    const { prompt, loadCachePath, saveCachePath, maxTokens } = request.body || {};
    // prompt may be empty string when loadCachePath supplies all context
    if (prompt === undefined || prompt === null) return reply.status(400).send({ error: 'prompt required' });
    if (!pool.isLoaded) return reply.status(409).send({ error: 'No model loaded' });
    try {
      let text = '';
      const cachePaths = (loadCachePath || saveCachePath)
        ? { loadCachePath: loadCachePath || null, saveCachePath: saveCachePath || null }
        : {};
      const result = await pool.generate(
        pool.activeModel.name,
        prompt,
        { max_new_tokens: maxTokens || 20 },
        (msg) => { if (msg.text) text += msg.text; },
        cachePaths,
      );
      return { text, perf: result.perf };
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
    dbSetSetting('idle_timeout_minutes', String(timeout));
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
        modelsDir: MODELS_DIR,
        runtimesDir: RUNTIMES_DIR,
        llamaRuntimeDir: LLAMA_RUNTIME_DIR,
        platform: getPlatform(),
        npuCores: getNpuCoreCount(),   // pool size cap (rk3576→2, rk3588→3, else 1)
        // Hardware capacity for the dynamic cache-limit ceilings: hot cache ≤ 50%
        // RAM, cold cache ≤ 80% of the disk holding the cache.
        ramTotalMB: Math.floor(os.totalmem() / 1048576),
        diskTotalMB: (() => {
          const cacheDir = dbGetSetting('cache_dir') || path.join(os.homedir(), '.config', 'orkllm', 'cache');
          for (const p of [cacheDir, MODELS_DIR, '/']) {
            try { const s = fs.statfsSync(p); return Math.floor((s.blocks * s.bsize) / 1048576); } catch { /* next */ }
          }
          return null;
        })(),
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
        cacheMaxContextTokens: parseInt(dbGetSetting('cache_max_context_tokens')    ?? '8192'),
        kvCacheQuant:          dbGetSetting('kv_cache_quant') ?? 'off',
        localAuthDisabled: dbGetSetting('local_auth_disabled') === '1',
        trustedProxy: dbGetSetting('trusted_proxy') ?? '',
        pinnedModel: dbGetSetting('pinned_model') ?? '',
        autoDownloadRuntimes: dbGetSetting('auto_download_runtimes') === '1',
        autoDownloadLlamaRuntime: dbGetSetting('auto_download_llama_runtime') === '1',
        npuPoolSize: parseInt(dbGetSetting('npu_pool_size') ?? '1'),
        langfuseEnabled:    dbGetSetting('langfuse_enabled')    === '1',
        langfuseBaseUrl:    dbGetSetting('langfuse_base_url')   ?? '',
        langfusePublicKey:  dbGetSetting('langfuse_public_key') ?? '',
        langfuseSecretKey:  dbGetSetting('langfuse_secret_key') ?? '',
        mcpInferenceEnabled: dbGetSetting('mcp_inference_enabled') === '1',
        managePerformance: (dbGetSetting('manage_performance') ?? '1') === '1',
      },
      cacheStats: getCacheStats()
    };
  });

  // POST /api/admin/global-settings
  fastify.post('/global-settings', async (request, reply) => {
    const { idleTimeoutMinutes, temperature, topP, topK, maxNewTokens, repPenalty, hfToken,
            cacheEnabled, cacheHotLimitMB, cacheColdLimitMB, cacheDir, cacheMaxContextTokens,
            kvCacheQuant,
            localAuthDisabled, trustedProxy, autoDownloadRuntimes, autoDownloadLlamaRuntime, npuPoolSize,
            langfuseEnabled, langfuseBaseUrl, langfusePublicKey, langfuseSecretKey,
            mcpInferenceEnabled, managePerformance,
          } = request.body || {};
    if (typeof idleTimeoutMinutes === 'number') {
      pool.setIdleTimeout(idleTimeoutMinutes);
    }
    if (typeof temperature === 'number') dbSetSetting('default_temperature', temperature);
    if (typeof topP === 'number') dbSetSetting('default_top_p', topP);
    if (typeof topK === 'number') dbSetSetting('default_top_k', topK);
    if (typeof maxNewTokens === 'number') dbSetSetting('default_max_new_tokens', maxNewTokens);
    if (typeof repPenalty === 'number') dbSetSetting('default_rep_penalty', repPenalty);
    if (typeof hfToken === 'string') dbSetSetting('hf_token', hfToken);
    if (typeof cacheEnabled === 'boolean') {
      dbSetSetting('cache_enabled', cacheEnabled ? '1' : '0');
      if (cacheEnabled) pool.triggerMcpCacheGeneration?.();
    }
    if (typeof cacheHotLimitMB === 'number')  dbSetSetting('cache_hot_limit_mb',        cacheHotLimitMB);
    if (typeof cacheColdLimitMB === 'number') dbSetSetting('cache_cold_limit_mb',       cacheColdLimitMB);
    if (typeof cacheDir === 'string')         dbSetSetting('cache_dir',                 cacheDir);
    if (typeof cacheMaxContextTokens === 'number') dbSetSetting('cache_max_context_tokens', cacheMaxContextTokens);
    const validQuant = ['off', 'q8', 'pq8', 'pq4'];
    if (typeof kvCacheQuant === 'string' && validQuant.includes(kvCacheQuant))
      dbSetSetting('kv_cache_quant', kvCacheQuant);
    if (typeof localAuthDisabled === 'boolean') dbSetSetting('local_auth_disabled', localAuthDisabled ? '1' : '0');
    if (typeof trustedProxy === 'string') dbSetSetting('trusted_proxy', trustedProxy);
    if (typeof autoDownloadRuntimes === 'boolean') dbSetSetting('auto_download_runtimes', autoDownloadRuntimes ? '1' : '0');
    if (typeof autoDownloadLlamaRuntime === 'boolean') dbSetSetting('auto_download_llama_runtime', autoDownloadLlamaRuntime ? '1' : '0');
    if (typeof npuPoolSize === 'number' && npuPoolSize >= 1 && npuPoolSize <= 8)
      dbSetSetting('npu_pool_size', String(npuPoolSize));
    if (typeof langfuseEnabled   === 'boolean') dbSetSetting('langfuse_enabled',    langfuseEnabled ? '1' : '0');
    if (typeof langfuseBaseUrl   === 'string')  dbSetSetting('langfuse_base_url',   langfuseBaseUrl);
    if (typeof langfusePublicKey === 'string')  dbSetSetting('langfuse_public_key', langfusePublicKey);
    if (typeof langfuseSecretKey === 'string' && langfuseSecretKey)
      dbSetSetting('langfuse_secret_key', langfuseSecretKey);
    if (typeof mcpInferenceEnabled === 'boolean') {
      dbSetSetting('mcp_inference_enabled', mcpInferenceEnabled ? '1' : '0');
      if (mcpInferenceEnabled) pool.triggerMcpCacheGeneration?.();
    }
    if (typeof managePerformance === 'boolean') {
      dbSetSetting('manage_performance', managePerformance ? '1' : '0');
      // Pin immediately when turned on (appliance stays at performance for the
      // whole service lifetime, not just while a model is loaded); restore the
      // board defaults when turned off.
      const { applyPerformance, restoreGovernor } = await import('../perf_governor.js');
      if (managePerformance) applyPerformance();
      else restoreGovernor();
    }
    logAudit(request, 'settings_change', null);
    return { success: true };
  });

  // POST /api/admin/runtimes/sync — manually trigger runtime download
  fastify.post('/runtimes/sync', async (request, reply) => {
    const { syncRuntimes } = await import('../runtime_sync.js');
    syncRuntimes().catch(e => console.error('[RuntimeSync] Manual sync failed:', e.message));
    return { success: true, message: 'Runtime sync started in background' };
  });

  // POST /api/admin/runtimes/download — download a specific version
  fastify.post('/runtimes/download', async (request, reply) => {
    const { version } = request.body || {};
    if (!version) return reply.status(400).send({ error: 'version required' });
    const { syncRuntimes } = await import('../runtime_sync.js');
    syncRuntimes(version).catch(e => console.error('[RuntimeSync] Download failed:', e.message));
    return { success: true, message: `Downloading runtime ${version} in background` };
  });

  // ── Llama runtime (libllama.so bundle for .gguf serving) ─────────────────
  // GET /api/admin/llama-runtime — install state + version info
  fastify.get('/llama-runtime', async () => {
    return {
      ...getLlamaRuntimeInfo(),
      syncState: getLlamaSyncState(),
      autoDownload: dbGetSetting('auto_download_llama_runtime') === '1',
      licenseAccepted: dbGetSetting('llama_license_accepted') === '1',
    };
  });

  // GET /api/admin/llama-runtime/license — upstream LICENSE text (shown in the accept modal)
  let _llamaLicense = null;
  fastify.get('/llama-runtime/license', async () => {
    if (_llamaLicense) return _llamaLicense;
    const { LLAMA_RUNTIME_MIRRORS } = await import('../config.js');
    for (const slug of LLAMA_RUNTIME_MIRRORS) {
      try {
        const res = await fetch(`https://api.github.com/repos/${slug}/contents/LICENSE`,
          { headers: { 'User-Agent': 'oRKLLM', 'Accept': 'application/vnd.github.raw' } });
        if (res.ok) { _llamaLicense = { source: slug, text: await res.text() }; return _llamaLicense; }
      } catch (e) { /* try next */ }
    }
    return { source: null, text: 'License text unavailable. See https://github.com/ggml-org/llama.cpp/blob/master/LICENSE (MIT).' };
  });

  // POST /api/admin/llama-runtime/accept-license — record that the admin accepted the upstream license
  fastify.post('/llama-runtime/accept-license', async (request) => {
    dbSetSetting('llama_license_accepted', '1');
    logAudit(request, 'llama_license_accept', null);
    return { success: true };
  });

  // GET /api/admin/llama-runtime/releases — available tags from the mirror
  fastify.get('/llama-runtime/releases', async () => {
    const releases = await getLlamaReleases();
    return { releases };
  });

  // POST /api/admin/llama-runtime/sync — download or update the llama runtime bundle
  fastify.post('/llama-runtime/sync', async (request, reply) => {
    // The llama.cpp runtime bundle is MIT-licensed upstream software; require an
    // explicit license acceptance before fetching it.
    if (dbGetSetting('llama_license_accepted') !== '1') {
      return reply.status(422).send({ error: 'llama.cpp runtime license not accepted', code: 'LICENSE_NOT_ACCEPTED' });
    }
    const { tag, force } = request.body || {};
    // A manual sync is an explicit user action, so default to force=true — this
    // re-fetches even when the installed tag matches (handles re-released/overwritten
    // tags). Pass force:false to keep the skip-if-present behaviour.
    syncLlamaRuntime(tag || null, { force: force !== false })
      .catch(e => console.error('[LlamaSync] Manual sync failed:', e.message));
    return { success: true, message: 'Llama runtime sync started in background' };
  });

  // ── Tailscale (optional, runtime-detected) ────────────────────────────────
  // GET /api/admin/tailscale — current state (installed/loggedIn/serve/url)
  fastify.get('/tailscale', { preHandler: requireAdmin }, async () => {
    const ts = await import('../tailscale.js');
    const state = await ts.getState();
    state.serveEnabledSetting = dbGetSetting('tailscale_serve_enabled') === '1';
    return state;
  });

  // POST /api/admin/tailscale/setup { authKey, hostname } — join tailnet + serve.
  // The auth key is used once and never persisted (tailscaled keeps its own state).
  fastify.post('/tailscale/setup', { preHandler: requireAdmin }, async (request, reply) => {
    const { authKey, hostname } = request.body || {};
    if (!authKey) return reply.status(400).send({ error: 'authKey required' });
    const ts = await import('../tailscale.js');
    if (!(await ts.isAvailable())) {
      return reply.status(409).send({ error: 'Tailscale is not installed on the server', code: 'NOT_INSTALLED' });
    }
    const upRes = await ts.up({ authKey, hostname });
    if (!upRes.ok) return reply.status(500).send({ error: upRes.error });
    // Wait for the node to be fully up (final MagicDNS name) before serving,
    // so serve binds to the correct hostname (avoids cert/name mismatch).
    await ts.waitUntilRunning(15000);
    const port = request.server.server.address()?.port || 8000;
    const serveRes = await ts.enableServe(port);
    if (!serveRes.ok) return reply.status(500).send({ error: serveRes.error });
    dbSetSetting('tailscale_serve_enabled', '1');
    logAudit(request, 'tailscale_setup', hostname || null);
    const state = await ts.getState();
    return { success: true, serveUrl: state.serveUrl };
  });

  // POST /api/admin/tailscale/serve { enabled } — toggle serve on/off
  fastify.post('/tailscale/serve', { preHandler: requireAdmin }, async (request, reply) => {
    const { enabled } = request.body || {};
    if (typeof enabled !== 'boolean') return reply.status(400).send({ error: 'enabled (boolean) required' });
    const ts = await import('../tailscale.js');
    if (!(await ts.isAvailable())) {
      return reply.status(409).send({ error: 'Tailscale is not installed on the server', code: 'NOT_INSTALLED' });
    }
    const port = request.server.server.address()?.port || 8000;
    const res = enabled ? await ts.enableServe(port) : await ts.disableServe();
    if (!res.ok) return reply.status(500).send({ error: res.error });
    dbSetSetting('tailscale_serve_enabled', enabled ? '1' : '0');
    logAudit(request, 'tailscale_serve', enabled ? 'on' : 'off');
    const state = await ts.getState();
    return { success: true, serveUrl: state.serveUrl };
  });

  // ── Benchmark history ─────────────────────────────────────────────────────
  // GET /api/admin/bench-runs — recent runs, newest first
  fastify.get('/bench-runs', async () => {
    return { runs: dbListBenchRuns(50) };
  });

  // POST /api/admin/bench-runs — persist a completed run
  fastify.post('/bench-runs', async (request, reply) => {
    const { model, ttft_ms, prefill_tps, gen_tps, gen_tokens, total_ms, max_tokens,
            spec_enabled, spec_strategy, spec_hardware } = request.body || {};
    if (!model) return reply.status(400).send({ error: 'model required' });
    const id = uuidv4();
    dbCreateBenchRun({ id, model, ttft_ms, prefill_tps, gen_tps, gen_tokens, total_ms, max_tokens,
                       spec_enabled, spec_strategy, spec_hardware });
    return { id };
  });

  // DELETE /api/admin/bench-runs — clear history
  fastify.delete('/bench-runs', async (request) => {
    dbClearBenchRuns();
    logAudit(request, 'bench_runs_clear', null);
    return { success: true };
  });

  // DELETE /api/admin/bench-runs/:id — delete a single run
  fastify.delete('/bench-runs/:id', async (request) => {
    const { id } = request.params;
    dbDeleteBenchRun(id);
    logAudit(request, 'bench_run_delete', id);
    return { success: true };
  });

  // GET /api/admin/eagle3-heads — Eagle-3 draft heads in MODELS_DIR, any format.
  // (/v1/models lists only servable .rkllm models; a Vulkan head is .gguf — the
  // format the native Vulkan draft shaders consume — so the Eagle-3 config picker
  // uses this instead.) format: 'npu' (.rkllm) | 'vulkan' (.gguf). A bf16
  // .safetensors is the training intermediate and is also surfaced (tagged
  // 'vulkan') so a head pending GGUF conversion is still visible.
  fastify.get('/eagle3-heads', async () => {
    const heads = [];
    (function scan(dir, prefix = '') {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) scan(path.join(dir, e.name), rel);
        else if (/EAGLE3|Eagle3Draft/i.test(rel) && /\.(rkllm|gguf|safetensors)$/i.test(e.name)) {
          heads.push({ id: rel, format: /\.rkllm$/i.test(e.name) ? 'npu' : 'vulkan' });
        }
      }
    })(MODELS_DIR);
    return { heads };
  });

  // GET /api/admin/library — downloaded models sorted into three categories for
  // the Models page: servable `.rkllm` models, base models (safetensors source
  // of draft-head embeddings), and draft models. Classification is by the
  // files present + each repo's config.json architecture (no name guessing).
  // Each draft entry carries a `draftKind`: 'eagle3' or 'dflash'.
  fastify.get('/library', async () => {
    const available = [], base = [], drafts = [];
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
    const listFiles = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
    const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return null; } };
    const dirSizeOf = (dir) => {
      let total = 0;
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) total += dirSizeOf(p);
          else { try { total += fs.statSync(p).size; } catch {} }
        }
      } catch {}
      return total;
    };
    // ORK conversion state for a .gguf: the offline scheduler pre-packs GGUF weights into the
    // NPU-native arena format and persists it next to the model. We reflect filesystem state only —
    // the scheduler owns the actual conversion. `<model>.orkpack` present → done; a sidecar
    // `<model>.orkpack.json` ({status,progress}) → queued/converting/error; neither → none.
    const orkConversionState = (ggufPath) => {
      const packPath = ggufPath.replace(/\.gguf$/i, '.orkpack');
      try { const st = fs.statSync(packPath); if (st.size > 0) return { status: 'done', packedBytes: st.size }; } catch {}
      const s = readJson(packPath + '.json');
      if (s && s.status) return { status: s.status, progress: Math.max(0, Math.min(100, Math.round(s.progress || 0))) };
      return { status: 'none' };
    };

    // Servable models: every .rkllm or .gguf anywhere under MODELS_DIR.
    // .rkllm → rkllm runtime; .gguf → llama runtime (open NPU stack).
    (function scanModels(dir, prefix = '') {
      for (const e of listFiles(dir)) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) scanModels(path.join(dir, e.name), rel);
        // thinkingToggle: can the model's reasoning be turned off? rkllm honours
        // enable_thinking natively; for gguf it depends on the chat template
        // (Qwen3+ yes, LFM2.5-MoE no). The UI hides the Enable-Thinking setting
        // when false so it isn't offered where it can't take effect.
        else if (/\.(rkllm|gguf)$/i.test(e.name)) {
          const abs = path.join(dir, e.name);
          const isRk = /\.rkllm$/i.test(e.name);
          // A draft head can ship as a loose .gguf/.rkllm (no safetensors repo dir, so the
          // config-arch classifier below never sees it). Route it to the Draft Models card by
          // name/path instead of dumping it among the servable models in Available. EAGLE-3
          // (/eagle-?3/i, so "EAGLE3" with no hyphen is caught — same match the /eagle3-heads
          // endpoint uses) and DFlash (/dflash/i) drafters both land here, tagged by draftKind.
          const draftKind = /eagle-?3/i.test(rel) ? 'eagle3' : /dflash/i.test(rel) ? 'dflash' : null;
          if (draftKind) {
            drafts.push({
              draftKind,
              dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : rel,
              headFile: rel,
              format: isRk ? 'npu' : 'gguf',
              hasConfig: false,
              targetModelType: null,
              embeddingsPresent: true,   // a .gguf/.rkllm head is self-contained — no separate embeddings.safetensors
              sizeBytes: sizeOf(abs),
            });
          } else if (isRk) {
            available.push({ id: rel, sizeBytes: sizeOf(abs), runtime: 'rkllm', thinkingToggle: true });
          } else {
            available.push({ id: rel, sizeBytes: sizeOf(abs), runtime: 'llama', thinkingToggle: supportsThinkingToggle(abs), orkConversion: orkConversionState(abs) });
          }
        }
      }
    })(MODELS_DIR);

    // Classify each repo directory that holds safetensors as base vs draft.
    // Downloads nest under {owner}/{repo}/… so we walk (bounded depth) and treat
    // any directory that DIRECTLY contains a .safetensors file as a repo dir; its
    // path relative to MODELS_DIR (e.g. "unsloth/Qwen3-1.7B") is the identifier,
    // preserving the owner prefix. The walk stops descending once it finds a repo
    // dir, so the old flat layout (repo at the top level) still classifies.
    const repoDirs = [];
    (function findRepoDirs(dir, rel = '', depth = 0) {
      if (depth > 3) return;
      const entries = listFiles(dir);
      const names = entries.filter(f => f.isFile()).map(f => f.name);
      if (names.some(n => /\.safetensors$/i.test(n))) { if (rel) repoDirs.push({ rel, abs: dir, names }); return; }
      for (const e of entries) if (e.isDirectory()) findRepoDirs(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    })(MODELS_DIR);

    for (const { rel, abs, names } of repoDirs) {
      const cfg = readJson(path.join(abs, 'config.json'));
      const arch = cfg?.architectures?.[0] || '';
      const draftKind = (/eagle3/i.test(arch) || /eagle-?3/i.test(rel)) ? 'eagle3'
                      : (/dflash/i.test(arch) || /dflash/i.test(rel)) ? 'dflash'
                      : null;
      if (draftKind) {
        const head = names.find(n => /\.rkllm$/i.test(n)) || names.find(n => /\.safetensors$/i.test(n) && n !== 'embeddings.safetensors') || names.find(n => /\.gguf$/i.test(n));
        drafts.push({
          draftKind,
          dir: rel,
          headFile: head ? `${rel}/${head}` : null,
          format: head && /\.rkllm$/i.test(head) ? 'npu' : 'vulkan',
          hasConfig: !!cfg,
          targetModelType: cfg?.target_model_type || null,
          embeddingsPresent: names.includes('embeddings.safetensors'),
          sizeBytes: dirSizeOf(abs),
        });
      } else {
        base.push({ dir: rel, arch: arch || null, hasEmbeddings: localBaseHasEmbeddings(abs), sizeBytes: dirSizeOf(abs) });
      }
    }
    // Reuse candidates: every existing embeddings.safetensors under MODELS_DIR.
    // A draft of the SAME target shares the byte-identical embed_tokens table, so
    // a draft that's missing embeddings can copy/hardlink an existing one instead
    // of re-extracting (a 1+ GB slice). Attach to each embeddings-missing draft
    // the shape-distinct candidates from OTHER drafts (excluding itself).
    const allEmbeddings = findReusableEmbeddings(MODELS_DIR);
    for (const d of drafts) {
      if (d.embeddingsPresent) continue;
      const seen = new Set();
      const cands = [];
      for (const c of allEmbeddings) {
        if (c.dir === d.dir) continue;
        const sig = `${c.dtype}|${(c.shape || []).join('x')}`;
        if (seen.has(sig)) continue;     // one representative per distinct shape/dtype
        seen.add(sig);
        cands.push({ sourceDir: c.dir, shape: c.shape, dtype: c.dtype, sizeBytes: c.nbytes });
      }
      d.reuseCandidates = cands;
    }

    // Disk usage of the models volume (best-effort; statfsSync needs Node ≥ 18.15).
    let disk = null;
    try { const s = fs.statfsSync(MODELS_DIR); disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }; } catch {}
    return { available, base, drafts, disk };
  });

  // GET /api/admin/cache-stats — lightweight hot/cold prefix-cache stats for
  // live observability (the Settings page polls this so the figures update as
  // inference populates the cache, without a full global-settings fetch).
  fastify.get('/cache-stats', async () => ({ cacheStats: getCacheStats() }));

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

  // OIDC/SAML routes are at /auth/oidc/... and /auth/saml/... — see src/auth/routes.js
  // OIDC/SAML routes are at /auth/oidc/... and /auth/saml/... — see src/auth/routes.js

  // GET /api/admin/models/settings/:modelId
  fastify.get('/models/settings/*', async (request, reply) => {
    const modelId = request.params['*'];
    if (!modelId || modelId.includes('..')) {
      return reply.status(400).send({ error: 'Invalid model ID' });
    }
    const settings = dbGetModelSettings(modelId);
    return { modelId, settings };
  });

  // POST /api/admin/models/settings/*
  fastify.post('/models/settings/*', async (request, reply) => {
    const modelId = request.params['*'];
    if (!modelId || modelId.includes('..')) {
      return reply.status(400).send({ error: 'Invalid model ID' });
    }
    const settings = request.body || {};
    dbSetModelSettings(modelId, settings);
    return { success: true, modelId, settings };
  });

  // GET /api/admin/hf/search?q=<query>&sort=downloads&rkllm=true&platform=rk3576&limit=20&offset=0
  fastify.get('/hf/search', async (request, reply) => {
    const { q = '', sort = 'downloads', rkllm = 'false', platform = '', limit = '20', offset = '0' } = request.query;
    const hfToken = dbGetSetting('hf_token') ?? '';
    let search = q;
    if (rkllm === 'true') search = `${search} rkllm`.trim();
    if (platform) search = `${search} ${platform}`.trim();
    const pageSize = Math.min(parseInt(limit) || 20, 50);
    const params = new URLSearchParams({
      search,
      sort,
      direction: '-1',
      limit: String(pageSize),
      offset: String(Math.max(0, parseInt(offset) || 0)),
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
        // Weight size: parameter count from safetensors metadata
        paramCount: m.safetensors?.total ?? null,
        // Total repo storage in bytes (all files including weights)
        storageBytes: m.usedStorage ?? null,
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
          paramCount: item.safetensors?.total ?? null,
          storageBytes: item.usedStorage ?? null,
        }))
        .filter(m => m.id);
      return { title: col.title ?? slug, description: col.description ?? '', models };
    } catch (e) {
      return reply.status(502).send({ error: `Failed to reach HuggingFace: ${e.message}` });
    }
  });

  // ── Model download queue ─────────────────────────────────────────────────
  // In-memory job store: { [id]: { id, repoId, filename, status, bytesDown, totalBytes, speedBps, startedAt, finishedAt, error } }
  const downloadJobs = new Map();

  // Cap concurrent downloads — the cap depends on the transfer path. aria2c already
  // opens 8 connections per file (-x8), so running many at once (e.g. 15 safetensors
  // shards) saturates the link; limit it to 2 (≈16 connections). The Node-stream
  // fallback is single-connection per file, so a higher cap (6) gives more useful
  // parallelism. Enqueue jobs as 'queued' and promote the next (FIFO — the Map
  // preserves insertion order) whenever a slot frees.
  function maxConcurrentDownloads() {
    return hasAria2() ? 2 : 6;
  }
  function activeDownloadCount() {
    let n = 0;
    for (const j of downloadJobs.values()) if (j.status === 'downloading') n++;
    return n;
  }
  function pumpDownloadQueue() {
    while (activeDownloadCount() < maxConcurrentDownloads()) {
      let next = null;
      for (const j of downloadJobs.values()) if (j.status === 'queued') { next = j; break; }
      if (!next || typeof next._run !== 'function') break;
      next.status = 'downloading';
      next.startedAt = Date.now();
      Promise.resolve().then(() => next._run()).finally(() => pumpDownloadQueue());
    }
  }

  function jobSummary(job) {
    const elapsed = (Date.now() - job.startedAt) / 1000;
    return {
      id: job.id,
      repoId: job.repoId,
      filename: job.filename,
      status: job.status,        // 'downloading' | 'done' | 'error' | 'cancelled'
      bytesDown: job.bytesDown,
      totalBytes: job.totalBytes,
      progress: job.totalBytes > 0 ? Math.round((job.bytesDown / job.totalBytes) * 100) : 0,
      speedBps: job.speedBps,
      elapsed: Math.round(elapsed),
      error: job.error ?? null,
    };
  }

  // Give a draft head (EAGLE-3 or DFlash — the embed table is target-specific,
  // not draft-type-specific) its target's embeddings into the head directory
  // (headDirName under MODELS_DIR) as a download-queue job. The source is chosen
  // explicitly — no derivation — from one of:
  //   source.reuseDir   : copy/hardlink an existing embeddings.safetensors from
  //                        another draft of the same target (shape-validated) —
  //                        cheapest; no re-extraction
  //   source.baseRepoId : range-download only the embed tensor from a HF repo
  //   source.baseDir    : slice it out of an already-downloaded base model dir
  // Idempotent: skips when embeddings.safetensors exists or a job is in flight.
  function startEmbeddingsJob(headDirName, source, hfToken) {
    const repoDir = path.join(MODELS_DIR, headDirName);
    const destPath = path.join(repoDir, 'embeddings.safetensors');
    if (fs.existsSync(destPath)) return { skipped: 'exists' };
    for (const j of downloadJobs.values())
      if (j._dest === destPath && j.status === 'downloading') return { skipped: 'in-progress' };

    const fromReuse = !!source.reuseDir;
    // Validate the reuse source up-front so a bad request fails synchronously
    // (422) rather than as a queued-job error.
    let reuseSrcPath = null;
    if (fromReuse) {
      reuseSrcPath = path.join(MODELS_DIR, source.reuseDir, 'embeddings.safetensors');
      if (!fs.existsSync(reuseSrcPath)) return { error: `no embeddings.safetensors in ${source.reuseDir}` };
      if (!readEmbeddingsMeta(reuseSrcPath)) return { error: `source has no embed_tokens.weight: ${source.reuseDir}` };
    }
    if (!fs.existsSync(repoDir)) fs.mkdirSync(repoDir, { recursive: true });

    const fromRepo = !!source.baseRepoId;
    const label = fromReuse ? `reuse:${source.reuseDir}` : fromRepo ? source.baseRepoId : `local:${source.baseDir}`;
    const id = uuidv4();
    const job = { id, repoId: label, filename: `${headDirName}/embeddings.safetensors`, status: 'downloading',
                  bytesDown: 0, totalBytes: 0, speedBps: 0, startedAt: Date.now(), error: null, _dest: destPath };
    downloadJobs.set(id, job);

    (async () => {
      try {
        if (fromReuse) {
          await copyEmbeddings({ srcPath: reuseSrcPath, destPath, job });
        } else if (fromRepo) {
          await fetchBaseEmbeddings({ baseRepoId: source.baseRepoId, destPath, hfToken, job });
        } else {
          await extractLocalEmbeddings({ baseDir: path.join(MODELS_DIR, source.baseDir), destPath, job });
        }
        if (job.status !== 'cancelled') { job.status = 'done'; job.speedBps = 0; job.finishedAt = Date.now(); }
        console.log(`[Embeddings] Completed: ${label} → ${headDirName}/embeddings.safetensors`);
      } catch (e) {
        job.status = 'error';
        job.error = e.message;
        console.error(`[Embeddings] Failed ${label}: ${e.message}`);
      }
    })();
    return { id, source: label };
  }

  // GET /api/admin/hf/model-size?repoId=<id> — total repo storage (usedStorage), for the search-row
  // size badge. HF's list/search API has no size field, so the search results fetch this per-result.
  fastify.get('/hf/model-size', async (request, reply) => {
    const { repoId } = request.query;
    if (!repoId) return reply.status(400).send({ error: 'repoId required' });
    const hfToken = dbGetSetting('hf_token') ?? '';
    const headers = { 'User-Agent': 'oRKLLM/1.0' };
    if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
    try {
      const encodedId = repoId.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`https://huggingface.co/api/models/${encodedId}?full=true`, { headers });
      if (!res.ok) return reply.status(res.status).send({ error: `HF API error: ${res.status}` });
      const data = await res.json();
      return { storageBytes: data.usedStorage ?? null };
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // GET /api/admin/hf/files?repoId=<id> — list downloadable files in a HF repo
  // (weight files + companion config.json)
  fastify.get('/hf/files', async (request, reply) => {
    const { repoId } = request.query;
    if (!repoId) return reply.status(400).send({ error: 'repoId required' });
    const hfToken = dbGetSetting('hf_token') ?? '';
    const headers = { 'User-Agent': 'oRKLLM/1.0' };
    if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
    try {
      // repoId is "owner/repo" — encode each segment but keep the slash as path separator
      const encodedId = repoId.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`https://huggingface.co/api/models/${encodedId}?full=true`, { headers });
      if (!res.ok) return reply.status(res.status).send({ error: `HF API error: ${res.status}` });
      const data = await res.json();
      // Downloadable: weight files (.rkllm NPU models/heads, .safetensors Eagle-3
      // heads + base models, .gguf alt heads, .bin/.pt/.pth PyTorch heads — some
      // AngelSlim Eagle-3 heads ship only as pytorch_model.bin and need a local
      // convert to safetensors before the Vulkan loader can read them) plus the
      // .json metadata that base models and Eagle-3 heads need (config.json
      // carries the head's hyperparameters; model.safetensors.index.json maps a
      // base model's shards).
      const siblings = data.siblings ?? [];
      const hasSafetensors = siblings.some(f => /\.safetensors$/.test(f.rfilename || ''));
      const files = siblings
        .filter(f => {
          const n = f.rfilename || '';
          if (/\.(rkllm|gguf|safetensors)$/.test(n) || /\.json$/.test(n)) return true;
          // PyTorch weights only when the repo ships no safetensors — avoids
          // double-downloading base models that publish both formats.
          return /\.(bin|pt|pth)$/.test(n) && !hasSafetensors;
        })
        .map(f => ({ name: f.rfilename, size: f.size ?? null }));
      return { repoId, files };
    } catch (e) {
      return reply.status(502).send({ error: e.message });
    }
  });

  // POST /api/admin/download — enqueue a download
  fastify.post('/download', async (request, reply) => {
    const { repoId, filename, hfToken: tokenOverride } = request.body || {};
    if (!repoId || !filename) return reply.status(400).send({ error: 'repoId and filename required' });
    if (!/\.(rkllm|gguf|safetensors|bin|pt|pth)$/.test(filename) && !/\.json$/.test(filename))
      return reply.status(400).send({ error: 'Only .rkllm, .gguf, .safetensors, .bin, .pt, .pth or .json files allowed' });

    const id = uuidv4();
    // Save as {MODELS_DIR}/{owner}/{repo}/{filename}. Keeping the owner in the
    // path (a) prevents collisions between same-named repos from different owners
    // — e.g. unsloth/LFM2.5-8B-A1B-GGUF and LiquidAI/LFM2.5-8B-A1B-GGUF both
    // reduce to "LFM2.5-8B-A1B-GGUF" and would otherwise share one directory —
    // and (b) surfaces the owner prefix on the Models page, since the model scan
    // uses each file's path relative to MODELS_DIR as its id. Sanitize every
    // segment so a crafted repoId can't escape MODELS_DIR.
    const safeSeg = (s) => (String(s).replace(/[^\w.-]/g, '_').replace(/^\.+/, '_') || '_');
    const segs = repoId.split('/').filter(Boolean).map(safeSeg);
    const repoRel = segs.length > 1 ? path.join(segs[0], segs.slice(1).join('_')) : (segs[0] || '_');
    const repoDir = path.join(MODELS_DIR, repoRel);
    if (!fs.existsSync(repoDir)) fs.mkdirSync(repoDir, { recursive: true });
    const destPath = path.join(repoDir, path.basename(filename));
    const hfToken = tokenOverride || (dbGetSetting('hf_token') ?? '');

    const job = { id, repoId, filename, status: 'queued', bytesDown: 0, totalBytes: 0, speedBps: 0, startedAt: Date.now(), error: null, _dest: destPath };
    downloadJobs.set(id, job);

    // Download in background — aria2c (16-conn, resumable) when available, else Node stream.
    // Defined as a re-invokable thunk so /resume can re-enter it (aria2c -c / Range continues).
    const run = async () => {
      const encodedRepo = repoId.split('/').map(encodeURIComponent).join('/');
      const url = `https://huggingface.co/${encodedRepo}/resolve/main/${encodeURIComponent(filename)}`;
      const headers = { 'User-Agent': 'oRKLLM/1.0' };
      if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
      const tmpPath = destPath + '.tmp';

      try {
        // content-length via HEAD (follow redirects, preserve auth) — the progress denominator
        try {
          let h = await fetch(url, { method: 'HEAD', headers, redirect: 'manual' });
          for (let n = 0; n < 5 && h.status >= 300 && h.status < 400 && h.headers.get('location'); n++)
            h = await fetch(h.headers.get('location'), { method: 'HEAD', headers, redirect: 'manual' });
          job.totalBytes = parseInt(h.headers.get('content-length') || '0', 10);
        } catch {}

        if (hasAria2()) {
          console.log(`[Download] aria2c -x8 ${filename}`);
          await downloadWithAria2({ url, dir: repoDir, outName: path.basename(tmpPath), token: hfToken, job });
        } else {
          console.log(`[Download] node-stream (aria2c unavailable) ${filename}`);
          await downloadNodeStream({ url, headers, tmpPath, job });
        }
        if (job.status === 'cancelled') { try { fs.unlinkSync(tmpPath); } catch {} return; }
        if (job.status === 'paused') return;   // stopped mid-flight; .tmp kept for /resume

        fs.renameSync(tmpPath, destPath);
        console.log(`[Download] Completed: ${filename}`);

        // Auto-convert a PyTorch-format Eagle-3 head to safetensors so the Vulkan
        // draft loader can read it (pure-Node, in-process, no torch). Only when the
        // repo has no safetensors yet. Failure doesn't fail the download — the
        // .bin stays in place for manual conversion via scripts/.
        if (/\.(bin|pt|pth)$/.test(destPath)) {
          const outPath = path.join(repoDir, 'model.safetensors');
          const hasSt = fs.readdirSync(repoDir).some(n => /\.safetensors$/.test(n));
          if (!hasSt) {
            try {
              job.speedBps = 0;
              const r = await convertPtToSafetensors(destPath, outPath, { log: () => {} });
              console.log(`[Download] Converted ${path.basename(destPath)} → model.safetensors (${r.tensors} tensors, ${r.bytes} bytes)`);
            } catch (e) {
              console.error(`[Download] PT→safetensors conversion failed for ${path.basename(destPath)}: ${e.message}`);
            }
          }
        }

        job.status = 'done';
        job.speedBps = 0;
        job.finishedAt = Date.now();
      } catch (e) {
        if (job.status === 'paused' || job.status === 'cancelled') return;  // expected stop, not an error
        job.status = 'error';
        job.error = e.message;
        try { fs.unlinkSync(destPath + '.tmp'); } catch {}
        console.error(`[Download] Failed ${filename}: ${e.message}`);
      }
    };
    job._run = run;
    pumpDownloadQueue();   // starts now if a slot is free, else stays 'queued'

    return { success: true, id, message: `${job.status === 'queued' ? 'Queued' : 'Downloading'} ${filename}` };
  });

  // POST /api/admin/eagle3/embeddings — give a draft head (EAGLE-3 or DFlash; the
  // endpoint is draft-type-agnostic) its target's embeddings. The source is chosen
  // explicitly (no name derivation):
  //   { headDir, reuseDir }    → copy/hardlink an existing embeddings.safetensors
  //                              from another draft of the same target (cheapest)
  //   { headDir, baseRepoId }  → range-download just embed_tokens from a HF repo
  //   { headDir, baseDir }     → slice it from an already-downloaded base model
  // Runs as a download-queue job (progress visible in the queue).
  fastify.post('/eagle3/embeddings', async (request, reply) => {
    const { headDir, baseRepoId, baseDir, reuseDir, hfToken: tokenOverride } = request.body || {};
    if (!headDir) return reply.status(400).send({ error: 'headDir required' });
    if (!baseRepoId && !baseDir && !reuseDir) return reply.status(400).send({ error: 'reuseDir, baseRepoId or baseDir required' });
    if (headDir.includes('..') || (baseDir && baseDir.includes('..')) || (reuseDir && reuseDir.includes('..')))
      return reply.status(400).send({ error: 'invalid path' });
    const hfToken = tokenOverride || (dbGetSetting('hf_token') ?? '');
    const r = startEmbeddingsJob(headDir, { reuseDir, baseRepoId, baseDir }, hfToken);
    if (r.error) return reply.status(422).send(r);
    return { success: true, ...r };
  });

  // GET /api/admin/download/status — all jobs
  fastify.get('/download/status', async (request, reply) => {
    return [...downloadJobs.values()].map(jobSummary).reverse();
  });

  // POST /api/admin/download/:id/pause — stop an in-flight download, keep the partial for resume
  fastify.post('/download/:id/pause', async (request, reply) => {
    const job = downloadJobs.get(request.params.id);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (job.status === 'downloading') { job.status = 'paused'; job.speedBps = 0; try { job._proc?.kill('SIGTERM'); } catch {} pumpDownloadQueue(); }
    else if (job.status === 'queued') { job.status = 'paused'; job.speedBps = 0; }   // not started yet
    return { success: true, status: job.status };
  });

  // POST /api/admin/download/:id/resume — re-enter the download thunk (aria2c -c / Range continues)
  fastify.post('/download/:id/resume', async (request, reply) => {
    const job = downloadJobs.get(request.params.id);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (job.status === 'paused' && typeof job._run === 'function') { job.status = 'queued'; job.error = null; pumpDownloadQueue(); }   // respects the concurrency cap
    return { success: true, status: job.status };
  });

  // DELETE /api/admin/download/:id — cancel an in-flight/paused job (kill + clean partial) or clear a finished one
  fastify.delete('/download/:id', async (request, reply) => {
    const job = downloadJobs.get(request.params.id);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (job.status === 'downloading') {
      job.status = 'cancelled';                       // running thunk kills the proc + removes .tmp on close
      try { job._proc?.kill('SIGTERM'); } catch {}
    } else {
      // queued/paused/done/error/cancelled: drop the job and clean any leftover partial + aria2 control file
      if (job._dest) { try { fs.unlinkSync(job._dest + '.tmp'); } catch {} try { fs.unlinkSync(job._dest + '.tmp.aria2'); } catch {} }
      downloadJobs.delete(request.params.id);
    }
    pumpDownloadQueue();   // a freed/cancelled slot lets the next queued job start
    return { success: true };
  });

  // POST /api/admin/download/pause-all — pause every active/queued download (partials kept for resume)
  fastify.post('/download/pause-all', async (request, reply) => {
    let n = 0;
    for (const job of downloadJobs.values()) {
      if (job.status === 'downloading') { job.status = 'paused'; job.speedBps = 0; try { job._proc?.kill('SIGTERM'); } catch {} n++; }
      else if (job.status === 'queued') { job.status = 'paused'; job.speedBps = 0; n++; }
    }
    return { success: true, paused: n };
  });

  // POST /api/admin/download/resume-all — resume every paused download (re-queued; concurrency cap applies)
  fastify.post('/download/resume-all', async (request, reply) => {
    let n = 0;
    for (const job of downloadJobs.values()) {
      if (job.status === 'paused' && typeof job._run === 'function') { job.status = 'queued'; job.error = null; n++; }
    }
    pumpDownloadQueue();
    return { success: true, resumed: n };
  });

  // POST /api/admin/download/abort-all — cancel everything: kill procs, drop jobs, clean partials
  fastify.post('/download/abort-all', async (request, reply) => {
    let n = 0;
    for (const [id, job] of [...downloadJobs.entries()]) {
      if (job.status === 'downloading') { job.status = 'cancelled'; try { job._proc?.kill('SIGTERM'); } catch {} n++; }
      else {
        if (job._dest) { try { fs.unlinkSync(job._dest + '.tmp'); } catch {} try { fs.unlinkSync(job._dest + '.tmp.aria2'); } catch {} }
        downloadJobs.delete(id); n++;
      }
    }
    return { success: true, aborted: n };
  });

  // DELETE /api/admin/models/* — supports subdirectory paths e.g. RepoName/model.rkllm
  fastify.delete('/models/*', async (request, reply) => {
    const modelId = request.params['*'];
    if (!modelId || modelId.includes('..') || (!modelId.endsWith('.rkllm') && !modelId.endsWith('.gguf'))) {
      return reply.status(400).send({ error: 'Invalid model ID' });
    }
    // Path traversal guard: resolved path must be inside MODELS_DIR
    const modelPath = path.resolve(MODELS_DIR, modelId);
    if (!modelPath.startsWith(path.resolve(MODELS_DIR) + path.sep)) {
      return reply.status(400).send({ error: 'Invalid model path' });
    }
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

  // DELETE /api/admin/library/* — remove a whole repo directory (base model or Eagle-3 head),
  // identified by its path relative to MODELS_DIR (the `dir` shown on the Models page).
  fastify.delete('/library/*', async (request, reply) => {
    const rel = request.params['*'];
    if (!rel || rel.includes('..')) return reply.status(400).send({ error: 'Invalid path' });
    const dirPath = path.resolve(MODELS_DIR, rel);
    if (!dirPath.startsWith(path.resolve(MODELS_DIR) + path.sep)) return reply.status(400).send({ error: 'Invalid path' });
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return reply.status(404).send({ error: 'Directory not found' });
    // Guard: refuse if the currently-loaded model lives inside this directory.
    const loaded = pool.getStatus().model;
    if (loaded && (path.resolve(MODELS_DIR, loaded) + '').startsWith(dirPath + path.sep))
      return reply.status(409).send({ error: 'Cannot delete: contains the currently loaded model. Unload it first.' });
    fs.rmSync(dirPath, { recursive: true, force: true });
    return { success: true };
  });

  // ── Conversation history ─────────────────────────────────────────────────
  const { default: conversationRoutes } = await import('./conversations.js');
  await fastify.register(conversationRoutes);

  // ── MCP servers ──────────────────────────────────────────────────────────
  const { default: mcpRoutes } = await import('./mcp.js');
  await fastify.register(mcpRoutes);
}
