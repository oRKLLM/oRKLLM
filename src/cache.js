import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { dbGetSetting } from './db.js';
import { quantize, quantizePolar8, quantizePolar4, dequantize, hasNativeAddon }
  from './kvcache_quant.js';

// Map scheme name → quantize function and file extension
const QUANT_SCHEMES = {
  q8:  { fn: quantize,       ext: '.q8cache'  },
  pq8: { fn: quantizePolar8, ext: '.pq8cache' },
  pq4: { fn: quantizePolar4, ext: '.pq4cache' },
};

function kvCacheQuant(modelOverride) {
  const s = modelOverride ?? dbGetSetting('kv_cache_quant') ?? 'off';
  return QUANT_SCHEMES[s] ? s : 'off';
}

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
    kvCacheQuant:  dbGetSetting('kv_cache_quant') ?? 'off',
  };
}

// All possible extensions a cached file might use
const CACHE_EXTS = ['.rkllmcache', '.q8cache', '.pq8cache', '.pq4cache'];

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

// Evict oldest entries from tier.  When overflowDir is provided (hot→cold),
// move the file there instead of deleting it.
function evictLru(tier, tierDir, limitMB, lru, overflowDir, overflowTier, overflowLimitMB) {
  while (limitMB >= 0 && dirSizeMB(tierDir) > limitMB) {
    const entries = Object.entries(lru[tier]);
    if (!entries.length) break;
    entries.sort((a, b) => a[1] - b[1]); // oldest first
    const [oldestKey] = entries[0];

    if (overflowDir) {
      // Move to overflow tier (hot → cold) instead of deleting
      ensureDir(overflowDir);
      let moved = false;
      for (const ext of CACHE_EXTS) {
        const src = path.join(tierDir, oldestKey + ext);
        if (fs.existsSync(src)) {
          const dst = path.join(overflowDir, oldestKey + ext);
          try { fs.renameSync(src, dst); moved = true; } catch {
            try { fs.copyFileSync(src, dst); fs.unlinkSync(src); moved = true; } catch {}
          }
          break;
        }
      }
      if (moved) {
        lru[overflowTier] = lru[overflowTier] || {};
        lru[overflowTier][oldestKey] = lru[tier][oldestKey];
        // Evict from cold if it's also over limit
        if (overflowLimitMB != null) evictLru(overflowTier, overflowDir, overflowLimitMB, lru);
      }
    } else {
      for (const ext of CACHE_EXTS) {
        try { fs.unlinkSync(path.join(tierDir, oldestKey + ext)); } catch {}
      }
    }
    delete lru[tier][oldestKey];
  }
}

function findCacheFile(dir, key) {
  for (const ext of CACHE_EXTS) {
    const f = path.join(dir, key + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function cacheKey(modelId, messages) {
  const payload = modelId + '\0' + JSON.stringify(messages.map(m => ({ r: m.role, c: m.content })));
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export async function getCachePath(key) {
  const cfg = settings();
  if (!cfg.enabled) return null;

  const hotDir  = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  const lru = readLru(cfg.cacheDir);

  let found = findCacheFile(hotDir, key);
  if (!found) {
    const coldFound = findCacheFile(coldDir, key);
    if (coldFound) {
      // Promote cold → hot (keep same extension)
      ensureDir(hotDir);
      const hotDest = path.join(hotDir, path.basename(coldFound));
      try { fs.renameSync(coldFound, hotDest); found = hotDest; }
      catch { found = coldFound; }
      delete lru.cold[key];
      lru.hot[key] = Date.now();
      evictLru('hot', hotDir, cfg.hotLimitMB, lru);
      writeLru(cfg.cacheDir, lru);
    }
  } else {
    lru.hot[key] = Date.now();
    writeLru(cfg.cacheDir, lru);
  }

  if (!found) return null;

  // If quantised, dequantize to a tmp FP16 file for RKLLM to load
  if (!found.endsWith('.rkllmcache')) {
    const tmpDir = path.join(cfg.cacheDir, 'tmp');
    ensureDir(tmpDir);
    const tmpFile = path.join(tmpDir, key + '_deq.rkllmcache');
    // Reuse existing deq file if it's newer than the quantised file
    if (fs.existsSync(tmpFile) &&
        fs.statSync(tmpFile).mtimeMs >= fs.statSync(found).mtimeMs) {
      return tmpFile;
    }
    try {
      await dequantize(found, tmpFile);
      return tmpFile;
    } catch (e) {
      console.warn('[Cache] Dequantize failed:', e.message);
      return null;
    }
  }

  return found;
}

export function putCachePath(key, tmpFile, modelQuantOverride) {
  const cfg = settings();
  if (!cfg.enabled) return;
  if (!fs.existsSync(tmpFile)) return;

  const hotDir  = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  ensureDir(coldDir);

  // When hot limit is 0 (disabled), write directly to cold
  const useHot = cfg.hotLimitMB > 0;
  const destDir = useHot ? hotDir : coldDir;
  const destTier = useHot ? 'hot' : 'cold';
  if (useHot) ensureDir(hotDir);

  const fp16Dest = path.join(destDir, key + '.rkllmcache');
  try { fs.renameSync(tmpFile, fp16Dest); }
  catch (e) {
    try { fs.copyFileSync(tmpFile, fp16Dest); fs.unlinkSync(tmpFile); } catch { return; }
  }

  const lru = readLru(cfg.cacheDir);
  lru[destTier][key] = Date.now();

  if (useHot) {
    // Evict oldest hot → overflow to cold, then evict cold if needed
    evictLru('hot', hotDir, cfg.hotLimitMB, lru, coldDir, 'cold', cfg.coldLimitMB);
    // Remove stale hot keys (files that were evicted/moved and no longer in hot)
    for (const k of Object.keys(lru.hot)) {
      if (!findCacheFile(hotDir, k)) delete lru.hot[k];
    }
  } else {
    evictLru('cold', coldDir, cfg.coldLimitMB, lru);
  }

  writeLru(cfg.cacheDir, lru);

  // Background quantisation — only start after the file is safely in place
  // (eviction already ran above, so fp16Dest is either still there or was moved)
  const scheme = kvCacheQuant(modelQuantOverride);
  if (scheme !== 'off' && hasNativeAddon) {
    const actualFile = findCacheFile(destDir, key) || findCacheFile(coldDir, key);
    if (actualFile && actualFile.endsWith('.rkllmcache')) {
      const { fn, ext } = QUANT_SCHEMES[scheme];
      const quantDest = actualFile.replace('.rkllmcache', ext);
      fn(actualFile, quantDest)
        .then(() => {
          try { fs.unlinkSync(actualFile); } catch {}
          console.log(`[Cache] Quantised ${key} → ${ext} (${scheme})`);
        })
        .catch(e => console.warn(`[Cache] Quantise failed for ${key}:`, e.message));
    }
  }
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

export function getKvCacheQuant(modelOverride) {
  return kvCacheQuant(modelOverride);
}
