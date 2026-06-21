import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';

const tempDbPath = path.join(os.tmpdir(), `orkllm-cache-db-test-${Date.now()}.db`);
process.env.ORKLLM_DB_PATH = tempDbPath;

const tempCacheDir = path.join(os.tmpdir(), `orkllm-cache-dir-test-${Date.now()}`);

const { dbSetSetting } = await import('../src/db.js');
const { putCachePath, getCachePath, getCacheStats, clearAllCache } = await import('../src/cache.js');

describe('KV Prefix Cache Mirroring', () => {
  before(() => {
    fs.mkdirSync(tempCacheDir, { recursive: true });
    dbSetSetting('cache_enabled', '1');
    dbSetSetting('cache_dir', tempCacheDir);
    dbSetSetting('cache_hot_limit_mb', '50');
    dbSetSetting('cache_cold_limit_mb', '100'); // 100 MB cold limit
  });

  after(() => {
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(tempCacheDir)) fs.rmSync(tempCacheDir, { recursive: true, force: true });
    } catch (e) {}
  });

  test('successfully mirrors newly written hot cache file to cold cache SSD', async () => {
    clearAllCache();
    const key = 'testkey123';
    
    // Create a mock temp cache file
    const tmpFile = path.join(tempCacheDir, 'tmp_test_file.rkllmcache');
    fs.writeFileSync(tmpFile, 'mock cache content');

    // Put cache with useHot=true (hotLimitMB is 50)
    putCachePath(key, tmpFile, 'rkllm', 'off');

    // Verify file exists in both hot and cold directories (mirroring)
    const hotFile = path.join(tempCacheDir, 'hot', `${key}.rkllmcache`);
    const coldFile = path.join(tempCacheDir, 'cold', `${key}.rkllmcache`);

    assert.ok(fs.existsSync(hotFile), 'File should exist in hot cache');
    assert.ok(fs.existsSync(coldFile), 'File should be mirrored to cold cache');
    assert.equal(fs.readFileSync(hotFile, 'utf8'), 'mock cache content');
    assert.equal(fs.readFileSync(coldFile, 'utf8'), 'mock cache content');

    const stats = getCacheStats();
    assert.equal(stats.hot.entries, 1);
    assert.equal(stats.cold.entries, 1);
  });

  test('skips mirroring if space in cold cache is insufficient', async () => {
    clearAllCache();
    // Temporarily set cold limit to a tiny value (almost 0, but above 0 so cold caching is not disabled)
    // Actually we can set limit to 0.00001 MB (10 bytes)
    dbSetSetting('cache_cold_limit_mb', '0.0001'); // 100 bytes

    const key = 'testkey456';
    const tmpFile = path.join(tempCacheDir, 'tmp_test_file_large.rkllmcache');
    // Create a 1 KB file, which exceeds the 0.0001 MB (100 bytes) limit
    const buffer = Buffer.alloc(1024, 'a');
    fs.writeFileSync(tmpFile, buffer);

    putCachePath(key, tmpFile, 'rkllm', 'off');

    const hotFile = path.join(tempCacheDir, 'hot', `${key}.rkllmcache`);
    const coldFile = path.join(tempCacheDir, 'cold', `${key}.rkllmcache`);

    assert.ok(fs.existsSync(hotFile), 'File should exist in hot cache');
    assert.ok(!fs.existsSync(coldFile), 'Mirroring should be skipped due to insufficient space');

    const stats = getCacheStats();
    assert.equal(stats.hot.entries, 1);
    assert.equal(stats.cold.entries, 0);

    // Restore cold limit
    dbSetSetting('cache_cold_limit_mb', '100');
  });

  test('mirrors cold cache entry back to cold when promoted to hot', async () => {
    clearAllCache();
    const key = 'testkeypromote';
    
    // We can simulate having a file ONLY in cold cache (not in hot)
    // To do this, we disable hot cache (limit = 0) and write to cold, then enable hot cache
    dbSetSetting('cache_hot_limit_mb', '0');
    const tmpFile = path.join(tempCacheDir, 'tmp_test_file_promote.rkllmcache');
    fs.writeFileSync(tmpFile, 'promote content');

    putCachePath(key, tmpFile, 'rkllm', 'off');

    const initialHotFile = path.join(tempCacheDir, 'hot', `${key}.rkllmcache`);
    const initialColdFile = path.join(tempCacheDir, 'cold', `${key}.rkllmcache`);
    assert.ok(!fs.existsSync(initialHotFile), 'Should not exist in hot cache initially');
    assert.ok(fs.existsSync(initialColdFile), 'Should exist in cold cache initially');

    // Re-enable hot cache
    dbSetSetting('cache_hot_limit_mb', '50');

    // Retrieve via getCachePath (promotes cold -> hot)
    const foundPath = await getCachePath(key);
    assert.ok(foundPath, 'Should find cache path');

    const hotFile = path.join(tempCacheDir, 'hot', `${key}.rkllmcache`);
    const coldFile = path.join(tempCacheDir, 'cold', `${key}.rkllmcache`);

    assert.ok(fs.existsSync(hotFile), 'Should exist in hot cache after promotion');
    assert.ok(fs.existsSync(coldFile), 'Should remain/be mirrored in cold cache after promotion');
    assert.equal(fs.readFileSync(hotFile, 'utf8'), 'promote content');
    assert.equal(fs.readFileSync(coldFile, 'utf8'), 'promote content');

    const stats = getCacheStats();
    assert.equal(stats.hot.entries, 1);
    assert.equal(stats.cold.entries, 1);
  });
});
