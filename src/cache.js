import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { dbGetSetting } from './db.js';

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.config', 'orkllm', 'cache');
const DEFAULT_HOT_LIMIT_MB = 512;
const DEFAULT_COLD_LIMIT_MB = 10 * 1024; // 10 GB

function settings() {
  return {
    enabled:       dbGetSetting('cache_enabled') === '1',
    hotLimitMB:    parseInt(dbGetSetting('cache_hot_limit_mb')  ?? DEFAULT_HOT_LIMIT_MB),
    coldLimitMB:   parseInt(dbGetSetting('cache_cold_limit_mb') ?? DEFAULT_COLD_LIMIT_MB),
    cacheDir:      dbGetSetting('cache_dir') ?? DEFAULT_CACHE_DIR,
    maxContextTokens: parseInt(dbGetSetting('cache_max_context_tokens') ?? '8192'),
  };
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function lruPath(cacheDir) {
  return path.join(cacheDir, 'lru.json');
}

function readLru(cacheDir) {
  try {
    return JSON.parse(fs.readFileSync(lruPath(cacheDir), 'utf8'));
  } catch {
    return { hot: {}, cold: {} };
  }
}

function writeLru(cacheDir, lru) {
  fs.writeFileSync(lruPath(cacheDir), JSON.stringify(lru), 'utf8');
}

function dirSizeMB(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, f)).size; } catch {}
  }
  return total / (1024 * 1024);
}

function evictLru(tier, tierDir, limitMB, lru) {
  while (dirSizeMB(tierDir) > limitMB) {
    const entries = Object.entries(lru[tier]);
    if (!entries.length) break;
    entries.sort((a, b) => a[1] - b[1]); // oldest first
    const [oldestKey] = entries[0];
    const oldestFile = path.join(tierDir, oldestKey + '.rkllmcache');
    try { fs.unlinkSync(oldestFile); } catch {}
    delete lru[tier][oldestKey];
  }
}

export function cacheKey(modelId, messages) {
  const payload = modelId + '\0' + JSON.stringify(messages.map(m => ({ r: m.role, c: m.content })));
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function getCachePath(key) {
  const cfg = settings();
  if (!cfg.enabled) return null;

  const hotDir  = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  const lru = readLru(cfg.cacheDir);

  const hotFile  = path.join(hotDir,  key + '.rkllmcache');
  const coldFile = path.join(coldDir, key + '.rkllmcache');

  if (fs.existsSync(hotFile)) {
    lru.hot[key] = Date.now();
    writeLru(cfg.cacheDir, lru);
    return hotFile;
  }

  if (fs.existsSync(coldFile)) {
    // Promote cold → hot
    ensureDir(hotDir);
    try { fs.renameSync(coldFile, hotFile); } catch { return coldFile; }
    delete lru.cold[key];
    lru.hot[key] = Date.now();
    evictLru('hot', hotDir, cfg.hotLimitMB, lru);
    writeLru(cfg.cacheDir, lru);
    return hotFile;
  }

  return null;
}

export function putCachePath(key, tmpFile) {
  const cfg = settings();
  if (!cfg.enabled) return;
  if (!fs.existsSync(tmpFile)) return;

  const hotDir  = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  ensureDir(hotDir);
  ensureDir(coldDir);

  const dest = path.join(hotDir, key + '.rkllmcache');
  try { fs.renameSync(tmpFile, dest); } catch (e) {
    try { fs.copyFileSync(tmpFile, dest); fs.unlinkSync(tmpFile); } catch { return; }
  }

  const lru = readLru(cfg.cacheDir);
  lru.hot[key] = Date.now();
  evictLru('hot', hotDir, cfg.hotLimitMB, lru);

  // Overflow hot → cold
  const overflowKeys = Object.keys(lru.hot).filter(k => !fs.existsSync(path.join(hotDir, k + '.rkllmcache')));
  for (const k of overflowKeys) delete lru.hot[k];

  evictLru('cold', coldDir, cfg.coldLimitMB, lru);
  writeLru(cfg.cacheDir, lru);
}

export function tmpCachePath(key) {
  const cfg = settings();
  const tmpDir = path.join(cfg.cacheDir, 'tmp');
  ensureDir(tmpDir);
  return path.join(tmpDir, key + '_' + process.pid + '.rkllmcache');
}

export function clearAllCache() {
  const cfg = settings();
  for (const sub of ['hot', 'cold', 'tmp']) {
    const d = path.join(cfg.cacheDir, sub);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
  const lp = lruPath(cfg.cacheDir);
  if (fs.existsSync(lp)) fs.unlinkSync(lp);
}

export function getCacheStats() {
  const cfg = settings();
  if (!cfg.enabled) return { enabled: false };
  const hotDir  = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  const lru = readLru(cfg.cacheDir);
  return {
    enabled: true,
    hot:  { entries: Object.keys(lru.hot).length,  sizeMB: Math.round(dirSizeMB(hotDir)  * 10) / 10, limitMB: cfg.hotLimitMB },
    cold: { entries: Object.keys(lru.cold).length, sizeMB: Math.round(dirSizeMB(coldDir) * 10) / 10, limitMB: cfg.coldLimitMB },
    cacheDir: cfg.cacheDir,
  };
}

export function isCacheEnabled() {
  return settings().enabled;
}

export function getMaxContextTokens() {
  return settings().maxContextTokens;
}
