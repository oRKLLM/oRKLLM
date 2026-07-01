// Langfuse OTel instrumentation — must be first before any other imports
import './instrumentation.js';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Writable } from 'stream';
import apiRoutes from './api/routes.js';
import adminRoutes from './admin/routes.js';
import authRoutes from './auth/routes.js';
import { getSystemMetrics } from './monitor.js';
import { getStats } from './stats.js';
import pool from './pool.js';
import { initConversionScheduler } from './conversion.js';
import { MODELS_DIR } from './config.js';
import { syncRuntimes } from './runtime_sync.js';
import { applyPerformance, pinOrchestrationToLittle } from './perf_governor.js';
import { migrateExistingEmbeddings } from './embeddings_store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logging interception for WebSocket streaming
const logBuffer = [];
const logClients = new Set();

// The log viewer filters by level (INFO/WARN/ERROR), so every streamed line needs a parseable
// level. Two line shapes reach the byte stream: (1) Pino/fastify.log JSON — carries its own
// `level` (the frontend parses it); (2) plain console.* text — has no level token, and warn vs
// error can't be told apart from the text. So we wrap console.* to record the intended level of
// the call in flight (`_emitLevel`); the write hook then prefixes plain lines with `[LEVEL]`.
// The REAL stdout/stderr still get the untagged bytes, so systemd/journalctl are unchanged.
let _emitLevel = null;
for (const [method, lvl] of [['log', 'info'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warn'], ['error', 'error']]) {
  const orig = typeof console[method] === 'function' ? console[method].bind(console) : null;
  if (!orig) continue;
  console[method] = (...args) => {
    const prev = _emitLevel; _emitLevel = lvl;
    try { return orig(...args); } finally { _emitLevel = prev; }
  };
}

// Tag each plain line with its level for the viewer; leave Pino JSON lines (which already carry a
// `level`) untouched so the frontend parses them directly and the display stays clean.
function tagForViewer(text, fromStderr) {
  const parts = text.split('\n');
  return parts.map((ln, i) => {
    if (ln === '' && i === parts.length - 1) return ln;   // keep the trailing newline
    if (ln.trimStart().startsWith('{')) return ln;         // structured (Pino) — has its own level
    const lvl = _emitLevel || (fromStderr ? 'error' : 'info');
    return `[${lvl.toUpperCase()}] ${ln}`;
  }).join('\n');
}

function broadcastLog(tagged) {
  logBuffer.push(tagged);
  if (logBuffer.length > 200) logBuffer.shift();
  for (const client of logClients) {
    try { if (client.readyState === 1) client.send(tagged); } catch (err) {}
  }
}

const originalStdoutWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
  broadcastLog(tagForViewer(chunk.toString(), false));
  return originalStdoutWrite.apply(process.stdout, arguments);
};

const originalStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, callback) {
  broadcastLog(tagForViewer(chunk.toString(), true));
  return originalStderrWrite.apply(process.stderr, arguments);
};

// Trusted proxy: trust X-Forwarded-* headers from nginx/reverse proxies
// Configurable via ORKLLM_TRUSTED_PROXY env var or stored setting
import { dbGetSetting } from './db.js';
import os from 'os';

function parseTrustedProxy(value) {
  if (!value) return false;
  if (value === 'true') return true;
  // Support comma-separated list of IPs/CIDRs/hostnames (like a SAN list)
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length === 1 ? parts[0] : parts;
}

function getTrustedProxy() {
  const env = process.env.ORKLLM_TRUSTED_PROXY;
  if (env) return parseTrustedProxy(env);
  try {
    const stored = dbGetSetting('trusted_proxy');
    if (stored) return parseTrustedProxy(stored);
  } catch {}
  return false;
}

// Create Fastify Server
const trustProxyCfg = getTrustedProxy();
const fastify = Fastify({
  // Pino writes numeric levels by default (info=30, warn=40, error=50). Emit the label instead
  // so log lines read "level":"info" rather than "level":30.
  logger: {
    level: 'info',
    formatters: { level: (label) => ({ level: label }) },
  },
  // Suppress the per-request "incoming request" / "request completed" access logs. The UI polls
  // several endpoints on short timers (version/health every 5s, metrics + cache-stats every ~4s,
  // /v1/models, conversion progress), which otherwise floods the log with responseTime~0 200s.
  // Real events are logged explicitly via console.log / fastify.log.error, so nothing useful is lost.
  disableRequestLogging: true,
  trustProxy: trustProxyCfg,
});

// Secure-by-default proxy gate: when NO proxy is trusted (setting empty / false),
// reject any request that arrives carrying proxy forwarding headers. A forwarded
// request means something upstream is proxying us that we were never told to trust;
// rather than silently fall back to the (spoofable) socket IP, refuse it until an
// admin sets Trusted Proxy. Running behind a reverse proxy is thus an explicit
// opt-in. Read once at startup (like trustProxy itself) — changing the setting
// needs a restart.
//
// NOTE: this is a policy gate, not a hard security boundary. Forwarding headers are
// client-settable, so this cannot truly distinguish a real proxy from a crafted
// header (a direct client can omit them, or forge them). The real boundary for
// "reachable only via the proxy" is the network layer (bind address / firewall).
if (!trustProxyCfg) {
  const FORWARD_HEADERS = [
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
    'x-forwarded-port', 'forwarded',
  ];
  fastify.addHook('onRequest', async (req, reply) => {
    if (FORWARD_HEADERS.some(h => req.headers[h] !== undefined)) {
      return reply.code(403).send({
        error: 'Proxy forwarding headers present but no trusted proxy is configured. '
             + 'Set Trusted Proxy in Site Settings (or the ORKLLM_TRUSTED_PROXY env var) '
             + 'to run oRKLLM behind a reverse proxy.',
      });
    }
  });
}

// Resilience: a single unguarded throw in an async/event context (e.g. a worker
// swap race in the pool) must never crash the whole server — that drops every
// in-flight SSE stream at once and forces a systemd restart. Log loudly and keep
// serving; the error is still visible in the logs for diagnosis.
process.on('uncaughtException', (err) => {
  try { fastify.log.error({ err }, '[uncaughtException] kept process alive'); }
  catch { console.error('[uncaughtException]', err); }
});
process.on('unhandledRejection', (reason) => {
  try { fastify.log.error({ err: reason }, '[unhandledRejection] kept process alive'); }
  catch { console.error('[unhandledRejection]', reason); }
});

// Register plugins
await fastify.register(fastifyCookie);
await fastify.register(fastifyWebsocket);

// App version (from package.json) — exposed publicly so the PWA can detect a
// stale cached client on load and force a service-worker update.
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch { return null; }
})();
fastify.get('/api/version', async () => ({ version: APP_VERSION }));

// Mount API & Admin Routes
await fastify.register(apiRoutes, { prefix: '/v1' });
await fastify.register(adminRoutes, { prefix: '/api/admin' });
await fastify.register(authRoutes, { prefix: '/auth' });

// Setup WebSockets
// 1. Metrics WebSocket — ONE shared 1s telemetry gather broadcast to all connected dashboard
// clients. Previously each client ran its own setInterval(getSystemMetrics), so CPU scaled with
// the number of open tabs (~50% of a core each → multiple tabs pegged the event loop and dragged
// the whole UI). Now getSystemMetrics() runs once per tick regardless of client count.
const metricsClients = new Set();
let metricsTimer = null;
function startMetricsPump() {
  if (metricsTimer) return;
  metricsTimer = setInterval(async () => {
    if (metricsClients.size === 0) return;
    let payload;
    try {
      const m = await getSystemMetrics();
      m.stats = getStats();
      payload = JSON.stringify(m);
    } catch (err) {
      return;   // skip this tick on error
    }
    for (const s of metricsClients) {
      if (s.readyState === 1) { try { s.send(payload); } catch {} }
    }
  }, 1000);
}
fastify.get('/ws/metrics', { websocket: true }, async (connection, req) => {
  fastify.log.info('[WebSocket] Client connected to /ws/metrics');
  const socket = connection.socket || connection;
  metricsClients.add(socket);
  startMetricsPump();

  // Initial fetch for this client so it doesn't wait up to 1s for the first frame.
  getSystemMetrics().then(m => {
    m.stats = getStats();
    if (socket.readyState === 1) socket.send(JSON.stringify(m));
  }).catch(() => {});

  await new Promise((resolve) => {
    socket.on('close', () => {
      fastify.log.info('[WebSocket] Client disconnected from /ws/metrics');
      metricsClients.delete(socket);
      if (metricsClients.size === 0 && metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
      resolve();
    });
  });
});

// 2. Logs WebSocket
fastify.get('/ws/logs', { websocket: true }, async (connection, req) => {
  fastify.log.info('[WebSocket] Client connected to /ws/logs');
  const socket = connection.socket || connection;
  logClients.add(socket);
  
  // Emit historical logs instantly
  for (const log of logBuffer) {
    socket.send(log);
  }

  await new Promise((resolve) => {
    socket.on('close', () => {
      fastify.log.info('[WebSocket] Client disconnected from /ws/logs');
      logClients.delete(socket);
      resolve();
    });
  });
});

// Setup Static Files (serving Vue SPA)
const distPath = path.join(process.cwd(), 'frontend', 'dist');

// Mount static if build folder exists
if (fs.existsSync(distPath)) {
  fastify.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    cacheControl: false, // set Cache-Control ourselves below (the default `public, max-age=0` would override)
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'sw.js' || base === 'registerSW.js' || base.endsWith('.webmanifest') || base === 'index.html') {
        // PWA control files + SPA shell must revalidate so updates are detected.
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Vite content-hashed bundles — safe to cache forever.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    }
  });
  
  // Fallback for single-page application routing (Vue Router HTML5 mode)
  fastify.setNotFoundHandler(async (request, reply) => {
    const distIndex = path.join(distPath, 'index.html');
    if (fs.existsSync(distIndex)) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'Not Found' });
  });
} else {
  // If not built yet (local dev mode before build)
  fastify.get('/', async (req, res) => {
    return { 
      message: "oRKLLM Server is running. Frontend static assets folder not found. Please build frontend with 'npm run build:frontend'." 
    };
  });
}

// Auto-load pinned model on startup.
// If a different model is already occupying the NPU, evict it first so its
// RAM is returned to the OS before we check whether the pinned model fits.
async function autoLoadPinnedModel() {
  const pinnedName = pool.constructor.getPinnedModel();
  if (!pinnedName) return;

  // Resolve model path — check flat dir first, then subdirectories
  let modelPath = path.join(MODELS_DIR, pinnedName);
  if (!fs.existsSync(modelPath)) {
    const subPath = (() => {
      try {
        for (const entry of fs.readdirSync(MODELS_DIR)) {
          const candidate = path.join(MODELS_DIR, entry, pinnedName);
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {}
      return null;
    })();
    if (!subPath) {
      fastify.log.warn(`[Autoload] Pinned model not found on disk: ${pinnedName}`);
      return;
    }
    modelPath = subPath;
  }

  // Evict any model that is already loaded but is not the pinned one,
  // freeing its NPU/RAM allocation before checking available memory.
  if (pool.isLoaded && pool.activeModel?.name !== pinnedName) {
    fastify.log.info(`[Autoload] Evicting ${pool.activeModel.name} to make room for pinned model`);
    await pool.unload();
    // Give the OS a moment to reclaim the freed pages
    await new Promise(r => setTimeout(r, 500));
  }

  const modelSizeMB = Math.round(fs.statSync(modelPath).size / 1024 / 1024);
  const freeMB      = Math.round(os.freemem() / 1024 / 1024);

  // Require at least 1.2× the model file size free before attempting load
  if (os.freemem() < fs.statSync(modelPath).size * 1.2) {
    fastify.log.warn(`[Autoload] Insufficient RAM for pinned model ${pinnedName} ` +
      `(${freeMB} MB free, ${modelSizeMB} MB needed × 1.2 = ${Math.round(modelSizeMB * 1.2)} MB)`);
    return;
  }

  fastify.log.info(`[Autoload] Loading pinned model: ${pinnedName} (${modelSizeMB} MB, ${freeMB} MB free)`);
  try {
    await pool.load(pinnedName);
    pool.setPin(true);
    fastify.log.info(`[Autoload] Pinned model loaded: ${pinnedName}`);
  } catch (e) {
    fastify.log.error(`[Autoload] Failed to load pinned model ${pinnedName}: ${e.message}`);
  }
}

// One-time migration: if cache files landed in the package CWD (due to an
// empty cache_dir setting) move them to the correct default location.
function migrateMisplacedCache() {
  const DEFAULT_CACHE = path.join(os.homedir(), '.config', 'orkllm', 'cache');
  const CWD_COLD = path.join(process.cwd(), 'cold');
  const CWD_LRU  = path.join(process.cwd(), 'lru.json');
  if (!fs.existsSync(CWD_COLD)) return;
  try {
    const destCold = path.join(DEFAULT_CACHE, 'cold');
    fs.mkdirSync(destCold, { recursive: true });
    for (const f of fs.readdirSync(CWD_COLD)) {
      const src = path.join(CWD_COLD, f);
      const dst = path.join(destCold, f);
      if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    }
    fs.rmdirSync(CWD_COLD, { recursive: false });
    if (fs.existsSync(CWD_LRU)) {
      fs.renameSync(CWD_LRU, path.join(DEFAULT_CACHE, 'lru.json'));
    }
    fastify.log.info('[Cache] Migrated misplaced cache files to default location');
  } catch (e) {
    fastify.log.warn(`[Cache] Migration failed (non-fatal): ${e.message}`);
  }
}

// Bootstrap Server
const start = async () => {
  const host = process.env.ORKLLM_HOST || '127.0.0.1';
  const port = parseInt(process.env.ORKLLM_PORT || '8000');

  try {
    await fastify.listen({ port, host });
    fastify.log.info(`oRKLLM server started at http://${host}:${port}`);
    // Inference appliance: pin CPU+DDR governors to performance at startup when
    // manage_performance is on, so the box is performance-ready immediately after
    // a reboot (not only once a model loads). Self-gates on the setting/platform.
    applyPerformance();
    // Keep this orchestration process (event loop + dashboard metrics polling) OFF the
    // big cores — inference runs in forked workers (pinned big at fork). Prevents our
    // frequent metrics wakes from preempting a co-resident NPU runtime's submit thread.
    pinOrchestrationToLittle();
    migrateMisplacedCache();  // fix empty cache_dir path bug from earlier versions
    // One-time: centralize any per-draft embeddings.safetensors that predate the
    // common store into <MODELS_DIR>/.embeddings/<sha256>.safetensors, register
    // them in the DB, and replace each draft's real file with a symlink.
    // Idempotent — already-linked drafts are skipped.
    try {
      const s = migrateExistingEmbeddings(MODELS_DIR);
      if (s.scanned > 0)
        fastify.log.info(`[Embeddings] store migration: scanned=${s.scanned} migrated=${s.migrated} deduped=${s.deduped} alreadyLinked=${s.alreadyLinked} errors=${s.errors} storeFiles=${s.storeFiles}`);
    } catch (e) { fastify.log.warn(`[Embeddings] store migration failed (non-fatal): ${e.message}`); }
    await autoLoadPinnedModel();
    // .orkpack conversion scheduler: enqueue every unconverted .gguf and convert serially during idle
    // (so models load fast from a pre-tiled cache). Default on; disable with ork_autoconvert=0.
    if (dbGetSetting('ork_autoconvert') !== '0') {
      const sched = initConversionScheduler(pool);
      sched.scanAndEnqueue();
      fastify.log.info(`[conversion] scheduler started — ${JSON.stringify(sched.status())}`);
    }
    // Background runtime sync (non-blocking)
    if (dbGetSetting('auto_download_runtimes') === '1') {
      syncRuntimes().catch(e => fastify.log.error(`[RuntimeSync] ${e.message}`));
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
