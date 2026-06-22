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
    cacheDir:      dbGetSetting('cache_dir') || DEFAULT_CACHE_DIR,
    maxContextTokens: parseInt(dbGetSetting('cache_max_context_tokens') ?? '8192'),
    kvCacheQuant:  dbGetSetting('kv_cache_quant') ?? 'off',
  };
}

// All possible extensions a cached file might use
const CACHE_EXTS = ['.rkllmcache', '.llamacache', '.q8cache', '.pq8cache', '.pq4cache'];
// Native (uncompressed) blobs load directly. The quantised variants are an
// rkllm-only concern: PolarQuant (kvcache_quant_napi) understands the .rkllmcache
// blob layout. The llama backend's .llamacache is a llama_state_seq file whose
// compression is the in-context KV type itself (serialized natively) — it is
// never PolarQuant'd, so it never needs dequant-on-load.
const QUANTIZED_EXTS = ['.q8cache', '.pq8cache', '.pq4cache'];

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
  const items = [dir];
  while (items.length > 0) {
    const current = items.pop();
    try {
      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        const children = fs.readdirSync(current);
        for (const child of children) {
          items.push(path.join(current, child));
        }
      } else if (stat.isFile()) {
        total += stat.size;
      }
    } catch {}
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

function getRuntimeDirs(cfg, runtime) {
  const r = (runtime || 'rkllm').toLowerCase();
  return {
    hotDir: path.join(cfg.cacheDir, 'hot', r),
    coldDir: path.join(cfg.cacheDir, 'cold', r),
  };
}

function findCacheFileInDir(dir, key) {
  if (!fs.existsSync(dir)) return null;
  for (const ext of CACHE_EXTS) {
    const f = path.join(dir, key + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function findInHot(cfg, key) {
  for (const r of ['llama', 'rkllm']) {
    const p = findCacheFileInDir(path.join(cfg.cacheDir, 'hot', r), key);
    if (p) return p;
  }
  return findCacheFileInDir(path.join(cfg.cacheDir, 'hot'), key);
}

function findInCold(cfg, key) {
  for (const r of ['llama', 'rkllm']) {
    const p = findCacheFileInDir(path.join(cfg.cacheDir, 'cold', r), key);
    if (p) return p;
  }
  return findCacheFileInDir(path.join(cfg.cacheDir, 'cold'), key);
}

function findCacheFile(cfg, key, runtime = null) {
  const runtimes = runtime ? [runtime.toLowerCase()] : ['llama', 'rkllm'];
  
  // 1. Search runtime-specific folders
  for (const r of runtimes) {
    // Check hot runtime-specific
    const hotDir = path.join(cfg.cacheDir, 'hot', r);
    for (const ext of CACHE_EXTS) {
      const p = path.join(hotDir, key + ext);
      if (fs.existsSync(p)) {
        return { path: p, runtime: r, tier: 'hot', isLegacy: false };
      }
    }
    // Check cold runtime-specific
    const coldDir = path.join(cfg.cacheDir, 'cold', r);
    for (const ext of CACHE_EXTS) {
      const p = path.join(coldDir, key + ext);
      if (fs.existsSync(p)) {
        return { path: p, runtime: r, tier: 'cold', isLegacy: false };
      }
    }
  }

  // Fallback to checking other runtimes if a specific one was requested but not found
  if (runtime) {
    const otherRuntimes = ['llama', 'rkllm'].filter(r => r !== runtime.toLowerCase());
    for (const r of otherRuntimes) {
      const hotDir = path.join(cfg.cacheDir, 'hot', r);
      for (const ext of CACHE_EXTS) {
        const p = path.join(hotDir, key + ext);
        if (fs.existsSync(p)) {
          return { path: p, runtime: r, tier: 'hot', isLegacy: false };
        }
      }
      const coldDir = path.join(cfg.cacheDir, 'cold', r);
      for (const ext of CACHE_EXTS) {
        const p = path.join(coldDir, key + ext);
        if (fs.existsSync(p)) {
          return { path: p, runtime: r, tier: 'cold', isLegacy: false };
        }
      }
    }
  }

  // 2. Search legacy roots
  const legacyHotDir = path.join(cfg.cacheDir, 'hot');
  for (const ext of CACHE_EXTS) {
    const p = path.join(legacyHotDir, key + ext);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const resolvedRuntime = ext === '.llamacache' ? 'llama' : 'rkllm';
      return { path: p, runtime: resolvedRuntime, tier: 'hot', isLegacy: true };
    }
  }

  const legacyColdDir = path.join(cfg.cacheDir, 'cold');
  for (const ext of CACHE_EXTS) {
    const p = path.join(legacyColdDir, key + ext);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const resolvedRuntime = ext === '.llamacache' ? 'llama' : 'rkllm';
      return { path: p, runtime: resolvedRuntime, tier: 'cold', isLegacy: true };
    }
  }

  return { path: null, runtime: null, tier: null, isLegacy: false };
}

function mirrorToColdIfSpace(key, cfg, runtime = null) {
  if (cfg.coldLimitMB <= 0) return;
  
  const res = findCacheFile(cfg, key, runtime);
  if (!res.path || res.tier !== 'hot') return;

  const activeRuntime = res.runtime;
  const { hotDir, coldDir } = getRuntimeDirs(cfg, activeRuntime);
  const hotFile = res.path;

  try {
    const stat = fs.statSync(hotFile);
    const sizeMB = stat.size / (1024 * 1024);

    // Check if already mirrored
    if (findInCold(cfg, key)) {
      const lru = readLru(cfg.cacheDir);
      lru.cold = lru.cold || {};
      lru.cold[key] = Date.now();
      writeLru(cfg.cacheDir, lru);
      return;
    }

    const lru = readLru(cfg.cacheDir);
    const coldSize = dirSizeMB(coldDir);
    if (coldSize + sizeMB > cfg.coldLimitMB) {
      const targetLimit = cfg.coldLimitMB - sizeMB;
      if (targetLimit >= 0) {
        evictLru('cold', coldDir, targetLimit, lru);
        console.log(`[Cache] Evicted old cold cache files to make room for "${key}" (${sizeMB.toFixed(2)} MB)`);
      } else {
        console.log(`[Cache] Mirroring skipped for ${key}: file size (${sizeMB.toFixed(2)} MB) exceeds cold limit (${cfg.coldLimitMB} MB)`);
        return;
      }
    }

    ensureDir(coldDir);
    const dest = path.join(coldDir, path.basename(hotFile));
    fs.copyFileSync(hotFile, dest);

    lru.cold = lru.cold || {};
    lru.cold[key] = Date.now();
    writeLru(cfg.cacheDir, lru);
    console.log(`[Cache] Mirrored hot cache ${key} to cold cache SSD (${sizeMB.toFixed(2)} MB)`);
  } catch (e) {
    console.error(`[Cache] Mirroring failed for ${key}:`, e.message);
  }
}

export function cacheKey(modelId, messages) {
  const payload = modelId + '\0' + JSON.stringify(messages.map(m => ({ r: m.role, c: m.content })));
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Resolves the longest cached prefix for a given list of segments.
 * Calculates cache keys for each segment using a hash-chain tree path:
 * K_1 = sha256(modelName + '\0' + segment_1_hash)
 * K_2 = sha256(K_1 + '\0' + segment_2_hash)
 * ...
 */
export async function resolveSegmentsCache(modelName, segments) {
  if (!segments || segments.length === 0) {
    return { keys: [], hitIndex: -1, loadCachePath: null, missedSegments: [] };
  }

  const runtime = modelName.toLowerCase().endsWith('.gguf') ? 'llama' : 'rkllm';
  const keys = [];
  let currentKey = modelName;

  for (const s of segments) {
    let sHash = s.hash;
    if (sHash) {
      if (sHash.startsWith('sha256:')) {
        sHash = sHash.slice(7);
      }
    } else {
      sHash = crypto.createHash('sha256').update(s.content).digest('hex');
    }
    const payload = currentKey + '\0' + sHash;
    currentKey = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
    keys.push(currentKey);
  }

  // Walk backwards to find the longest hit
  let hitIndex = -1;
  let loadCachePath = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    const path = await getCachePath(keys[i], runtime);
    if (path) {
      hitIndex = i;
      loadCachePath = path;
      break;
    }
  }

  const missedSegments = segments.slice(hitIndex + 1);
  return { keys, hitIndex, loadCachePath, missedSegments };
}

export async function getCachePath(key, runtime = null) {
  const cfg = settings();
  if (!cfg.enabled) return null;

  const lru = readLru(cfg.cacheDir);
  const res = findCacheFile(cfg, key, runtime);
  if (!res.path) return null;

  const activeRuntime = res.runtime;
  const { hotDir, coldDir } = getRuntimeDirs(cfg, activeRuntime);

  let found = null;

  if (res.isLegacy) {
    // Migrate legacy file to the new runtime-specific folder
    if (res.tier === 'hot') {
      ensureDir(hotDir);
      const dest = path.join(hotDir, path.basename(res.path));
      try {
        fs.renameSync(res.path, dest);
        found = dest;
      } catch {
        try {
          fs.copyFileSync(res.path, dest);
          fs.unlinkSync(res.path);
          found = dest;
        } catch {
          found = res.path;
        }
      }
      lru.hot[key] = Date.now();
      evictLru('hot', hotDir, cfg.hotLimitMB, lru, coldDir, 'cold', cfg.coldLimitMB);
      writeLru(cfg.cacheDir, lru);
      mirrorToColdIfSpace(key, cfg, activeRuntime);
      const updatedLru = readLru(cfg.cacheDir);
      Object.assign(lru, updatedLru);
    } else {
      ensureDir(coldDir);
      const dest = path.join(coldDir, path.basename(res.path));
      try {
        fs.renameSync(res.path, dest);
        found = dest;
      } catch {
        try {
          fs.copyFileSync(res.path, dest);
          fs.unlinkSync(res.path);
          found = dest;
        } catch {
          found = res.path;
        }
      }
      lru.cold = lru.cold || {};
      lru.cold[key] = Date.now();
      evictLru('cold', coldDir, cfg.coldLimitMB, lru);
    }
    writeLru(cfg.cacheDir, lru);
  } else if (res.tier === 'cold') {
    if (cfg.hotLimitMB <= 0) {
      // Hot cache is disabled. Read directly from SSD/cold cache.
      found = res.path;
      lru.cold = lru.cold || {};
      lru.cold[key] = Date.now();
      writeLru(cfg.cacheDir, lru);
      console.log(`[Cache] Using SSD cold cache directly for "${key}" (hot cache disabled)`);
    } else {
      // Promote cold → hot
      ensureDir(hotDir);
      const hotDest = path.join(hotDir, path.basename(res.path));
      try {
        fs.copyFileSync(res.path, hotDest);
        found = hotDest;
      } catch {
        found = res.path;
      }
      delete lru.cold[key];
      lru.hot[key] = Date.now();

      // Evict oldest hot → overflow to cold, then evict cold if needed
      evictLru('hot', hotDir, cfg.hotLimitMB, lru, coldDir, 'cold', cfg.coldLimitMB);

      if (fs.existsSync(res.path)) {
        lru.cold[key] = Date.now();
      }

      // Synchronize LRU
      for (const k of Object.keys(lru.hot)) {
        if (!findInHot(cfg, k)) delete lru.hot[k];
      }
      lru.cold = lru.cold || {};
      for (const k of Object.keys(lru.cold)) {
        if (!findInCold(cfg, k)) delete lru.cold[k];
      }

      writeLru(cfg.cacheDir, lru);
    }
  } else {
    found = res.path;
    lru.hot[key] = Date.now();
    writeLru(cfg.cacheDir, lru);
  }

  if (found && !fs.existsSync(found)) {
    const coldRes = findCacheFile(cfg, key, activeRuntime);
    if (coldRes.path && coldRes.tier === 'cold') {
      found = coldRes.path;
    } else {
      found = null;
    }
  }

  if (!found) return null;

  if (QUANTIZED_EXTS.some(e => found.endsWith(e))) {
    const tmpDir = path.join(cfg.cacheDir, 'tmp');
    ensureDir(tmpDir);
    const tmpFile = path.join(tmpDir, key + '_deq.rkllmcache');
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

export function putCachePath(key, tmpFile, runtime, modelQuantOverride) {
  const cfg = settings();
  if (!cfg.enabled) return;
  if (!fs.existsSync(tmpFile)) return;

  const activeRuntime = runtime || 'rkllm';
  const nativeExt = activeRuntime === 'llama' ? '.llamacache' : '.rkllmcache';

  const { hotDir, coldDir } = getRuntimeDirs(cfg, activeRuntime);
  ensureDir(coldDir);

  const useHot = cfg.hotLimitMB > 0;
  const destDir = useHot ? hotDir : coldDir;
  const destTier = useHot ? 'hot' : 'cold';
  if (useHot) ensureDir(hotDir);

  const fp16Dest = path.join(destDir, key + nativeExt);
  try { fs.renameSync(tmpFile, fp16Dest); }
  catch (e) {
    try { fs.copyFileSync(tmpFile, fp16Dest); fs.unlinkSync(tmpFile); } catch { return; }
  }

  const lru = readLru(cfg.cacheDir);
  lru[destTier] = lru[destTier] || {};
  lru[destTier][key] = Date.now();

  if (useHot) {
    evictLru('hot', hotDir, cfg.hotLimitMB, lru, coldDir, 'cold', cfg.coldLimitMB);
    for (const k of Object.keys(lru.hot)) {
      if (!findInHot(cfg, k)) delete lru.hot[k];
    }
  } else {
    evictLru('cold', coldDir, cfg.coldLimitMB, lru);
  }

  lru.cold = lru.cold || {};
  for (const k of Object.keys(lru.cold)) {
    if (!findInCold(cfg, k)) delete lru.cold[k];
  }

  writeLru(cfg.cacheDir, lru);

  const scheme = activeRuntime === 'llama' ? 'off' : kvCacheQuant(modelQuantOverride);
  if (scheme !== 'off' && hasNativeAddon) {
    const actualFile = findCacheFile(cfg, key, activeRuntime).path;
    if (actualFile && actualFile.endsWith(nativeExt)) {
      const { fn, ext } = QUANT_SCHEMES[scheme];
      const quantDest = actualFile.replace('.rkllmcache', ext);
      fn(actualFile, quantDest)
        .then(() => {
          try { fs.unlinkSync(actualFile); } catch {}
          console.log(`[Cache] Quantised ${key} → ${ext} (${scheme})`);
          if (useHot) {
            mirrorToColdIfSpace(key, cfg, activeRuntime);
          }
        })
        .catch(e => {
          console.warn(`[Cache] Quantise failed for ${key}:`, e.message);
          if (useHot) {
            mirrorToColdIfSpace(key, cfg, activeRuntime);
          }
        });
    } else {
      if (useHot) {
        mirrorToColdIfSpace(key, cfg, activeRuntime);
      }
    }
  } else {
    if (useHot) {
      mirrorToColdIfSpace(key, cfg, activeRuntime);
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
  _statsMemo = null;  // bust the observability snapshot so a Clear shows 0 at once
}

// Short-lived memo of the last computed stats. getCacheStats walks the hot/cold
// trees (dirSizeMB) — cheap normally but seconds-slow with many blobs, and it's
// fetched on every Dashboard load. A 3s TTL serves rapid reloads instantly while
// staying fresh enough for an observability gauge; clearAllCache busts it.
let _statsMemo = null;       // { stats }
let _statsMemoTime = 0;
const STATS_MEMO_TTL_MS = 3000;

export function getCacheStats() {
  if (_statsMemo && Date.now() - _statsMemoTime < STATS_MEMO_TTL_MS) {
    return _statsMemo;
  }
  const cfg = settings();
  if (!cfg.enabled) return { enabled: false };
  const hotDir  = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  const lru = readLru(cfg.cacheDir);
  const stats = {
    enabled: true,
    hot:  { entries: Object.keys(lru.hot).length,  sizeMB: Math.round(dirSizeMB(hotDir)  * 10) / 10, limitMB: cfg.hotLimitMB },
    cold: { entries: Object.keys(lru.cold).length, sizeMB: Math.round(dirSizeMB(coldDir) * 10) / 10, limitMB: cfg.coldLimitMB },
    cacheDir: cfg.cacheDir,
  };
  _statsMemo = stats;
  _statsMemoTime = Date.now();
  return stats;
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
