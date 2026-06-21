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

function mirrorToColdIfSpace(key, cfg) {
  if (cfg.coldLimitMB <= 0) return;
  const hotDir = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  const hotFile = findCacheFile(hotDir, key);
  if (!hotFile) return;

  try {
    const stat = fs.statSync(hotFile);
    const sizeMB = stat.size / (1024 * 1024);
    const coldSize = dirSizeMB(coldDir);

    // Check if the file is already in coldDir
    const coldFile = findCacheFile(coldDir, key);
    if (coldFile) {
      // It is already mirrored! Just make sure LRU is updated.
      const lru = readLru(cfg.cacheDir);
      lru.cold = lru.cold || {};
      lru.cold[key] = Date.now();
      writeLru(cfg.cacheDir, lru);
      return;
    }

    if (coldSize + sizeMB <= cfg.coldLimitMB) {
      ensureDir(coldDir);
      const dest = path.join(coldDir, path.basename(hotFile));
      fs.copyFileSync(hotFile, dest);

      const lru = readLru(cfg.cacheDir);
      lru.cold = lru.cold || {};
      lru.cold[key] = Date.now();
      writeLru(cfg.cacheDir, lru);
      console.log(`[Cache] Mirrored hot cache ${key} to cold cache SSD (${sizeMB.toFixed(2)} MB)`);
    } else {
      console.log(`[Cache] Mirroring skipped for ${key}: insufficient space in cold cache (needed ${sizeMB.toFixed(2)} MB, cold size ${coldSize.toFixed(2)} MB, limit ${cfg.coldLimitMB} MB)`);
    }
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
    const path = await getCachePath(keys[i]);
    if (path) {
      hitIndex = i;
      loadCachePath = path;
      break;
    }
  }

  const missedSegments = segments.slice(hitIndex + 1);
  return { keys, hitIndex, loadCachePath, missedSegments };
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
      if (cfg.hotLimitMB <= 0) {
        // Hot cache is disabled. Read directly from SSD/cold cache.
        found = coldFound;
        lru.cold = lru.cold || {};
        lru.cold[key] = Date.now();
        writeLru(cfg.cacheDir, lru);
        console.log(`[Cache] Using SSD cold cache directly for "${key}" (hot cache disabled)`);
      } else {
        // Promote cold → hot (keep same extension)
        ensureDir(hotDir);
        const hotDest = path.join(hotDir, path.basename(coldFound));
        try {
          // Optimization: copy instead of rename+copy-back to avoid redundant SSD writes
          fs.copyFileSync(coldFound, hotDest);
          found = hotDest;
        } catch {
          found = coldFound;
        }
        delete lru.cold[key];
        lru.hot[key] = Date.now();
        evictLru('hot', hotDir, cfg.hotLimitMB, lru);
        
        // Ensure the cold entry is tracked since it remains on SSD
        if (fs.existsSync(coldFound)) {
          lru.cold[key] = Date.now();
        }
        writeLru(cfg.cacheDir, lru);
      }
    }
  } else {
    lru.hot[key] = Date.now();
    writeLru(cfg.cacheDir, lru);
  }

  if (!found) return null;

  // Quantised variants (rkllm PolarQuant only) dequantize to a tmp FP16 file for
  // RKLLM to load. Native blobs (.rkllmcache / .llamacache) load directly.
  if (QUANTIZED_EXTS.some(e => found.endsWith(e))) {
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

export function putCachePath(key, tmpFile, runtime, modelQuantOverride) {
  const cfg = settings();
  if (!cfg.enabled) return;
  if (!fs.existsSync(tmpFile)) return;

  // Native blob extension is backend-specific: the rkllm addon writes a
  // reverse-engineered .rkllmcache; the llama backend writes a llama_state_seq
  // file (.llamacache) whose compression is the in-context KV type. PolarQuant
  // (below) understands only the rkllm layout and is skipped for llama.
  const nativeExt = runtime === 'llama' ? '.llamacache' : '.rkllmcache';

  const hotDir  = path.join(cfg.cacheDir, 'hot');
  const coldDir = path.join(cfg.cacheDir, 'cold');
  ensureDir(coldDir);

  // When hot limit is 0 (disabled), write directly to cold
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

  // Background quantisation — rkllm only. The llama prefix cache compresses via the
  // in-context KV type (serialized natively into the .llamacache by the runtime);
  // running kvcache_quant_napi on a llama state_seq blob would be wrong (different
  // layout) and, for turbo, a redundant second GPU pass. Only start after the file
  // is safely in place (eviction already ran above).
  const scheme = runtime === 'llama' ? 'off' : kvCacheQuant(modelQuantOverride);
  if (scheme !== 'off' && hasNativeAddon) {
    const actualFile = findCacheFile(destDir, key) || findCacheFile(coldDir, key);
    if (actualFile && actualFile.endsWith(nativeExt)) {
      const { fn, ext } = QUANT_SCHEMES[scheme];
      const quantDest = actualFile.replace('.rkllmcache', ext);
      fn(actualFile, quantDest)
        .then(() => {
          try { fs.unlinkSync(actualFile); } catch {}
          console.log(`[Cache] Quantised ${key} → ${ext} (${scheme})`);
          if (useHot) {
            mirrorToColdIfSpace(key, cfg);
          }
        })
        .catch(e => {
          console.warn(`[Cache] Quantise failed for ${key}:`, e.message);
          if (useHot) {
            mirrorToColdIfSpace(key, cfg);
          }
        });
    } else {
      if (useHot) {
        mirrorToColdIfSpace(key, cfg);
      }
    }
  } else {
    if (useHot) {
      mirrorToColdIfSpace(key, cfg);
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
