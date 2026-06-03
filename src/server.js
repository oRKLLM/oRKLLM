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
import { MODELS_DIR } from './config.js';
import { syncRuntimes } from './runtime_sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logging interception for WebSocket streaming
const logBuffer = [];
const logClients = new Set();

const originalStdoutWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
  const msg = chunk.toString();
  logBuffer.push(msg);
  if (logBuffer.length > 200) logBuffer.shift();
  for (const client of logClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch (err) {}
  }
  return originalStdoutWrite.apply(process.stdout, arguments);
};

const originalStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, callback) {
  const msg = chunk.toString();
  logBuffer.push(msg);
  if (logBuffer.length > 200) logBuffer.shift();
  for (const client of logClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch (err) {}
  }
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
const fastify = Fastify({
  logger: { level: 'info' },
  trustProxy: getTrustedProxy(),
});

// Register plugins
await fastify.register(fastifyCookie);
await fastify.register(fastifyWebsocket);

// Mount API & Admin Routes
await fastify.register(apiRoutes, { prefix: '/v1' });
await fastify.register(adminRoutes, { prefix: '/api/admin' });
await fastify.register(authRoutes, { prefix: '/auth' });

// Setup WebSockets
// 1. Metrics WebSocket
fastify.get('/ws/metrics', { websocket: true }, async (connection, req) => {
  fastify.log.info('[WebSocket] Client connected to /ws/metrics');
  const socket = connection.socket || connection;
  
  // Initial fetch
  getSystemMetrics().then(m => {
    m.stats = getStats();
    socket.send(JSON.stringify(m));
  }).catch(() => {});

  // Polling every 1 second
  const interval = setInterval(async () => {
    try {
      const m = await getSystemMetrics();
      m.stats = getStats();
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(m));
      }
    } catch (err) {
      // ignore
    }
  }, 1000);

  await new Promise((resolve) => {
    socket.on('close', () => {
      fastify.log.info('[WebSocket] Client disconnected from /ws/metrics');
      clearInterval(interval);
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
    prefix: '/'
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
// The RKLLM runtime manages its own memory allocation — we let it
// attempt the load and fail gracefully rather than blocking on a
// conservative pre-check that uses unreliable free-memory estimates.
async function autoLoadPinnedModel() {
  const pinnedName = pool.constructor.getPinnedModel();
  if (!pinnedName) return;

  // Resolve: check flat models dir first, then subdirectories
  let modelPath = path.join(MODELS_DIR, pinnedName);
  if (!fs.existsSync(modelPath)) {
    // Try scanning subdirectories (models stored as repo/file.rkllm)
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

  const modelSizeMB = Math.round(fs.statSync(modelPath).size / 1024 / 1024);
  const freeMB      = Math.round(os.freemem() / 1024 / 1024);
  fastify.log.info(`[Autoload] Loading pinned model: ${pinnedName} ` +
    `(${modelSizeMB} MB, ${freeMB} MB free)`);
  try {
    await pool.load(pinnedName);
    pool.setPin(true);
    fastify.log.info(`[Autoload] Pinned model loaded successfully: ${pinnedName}`);
  } catch (e) {
    fastify.log.error(`[Autoload] Failed to load pinned model ${pinnedName}: ${e.message}`);
  }
}

// Bootstrap Server
const start = async () => {
  const host = process.env.ORKLLM_HOST || '127.0.0.1';
  const port = parseInt(process.env.ORKLLM_PORT || '8000');

  try {
    await fastify.listen({ port, host });
    fastify.log.info(`oRKLLM server started at http://${host}:${port}`);
    await autoLoadPinnedModel();
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
