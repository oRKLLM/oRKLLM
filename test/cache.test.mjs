import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';

const tempDbPath = path.join(os.tmpdir(), `orkllm-cache-db-test-${Date.now()}.db`);
process.env.ORKLLM_DB_PATH = tempDbPath;

const tempCacheDir = path.join(os.tmpdir(), `orkllm-cache-dir-test-${Date.now()}`);

const { dbSetSetting } = await import('../src/db.js');
const { putCachePath, getCachePath, getCacheStats, clearAllCache, resolveSegmentsCache } = await import('../src/cache.js');

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

  test('returns cold cache path directly without promotion when hot cache is disabled (limit <= 0)', async () => {
    clearAllCache();
    const key = 'testkeypurecold';

    // Disable hot cache (limit = 0)
    dbSetSetting('cache_hot_limit_mb', '0');
    const tmpFile = path.join(tempCacheDir, 'tmp_test_file_purecold.rkllmcache');
    fs.writeFileSync(tmpFile, 'pure cold content');

    putCachePath(key, tmpFile, 'rkllm', 'off');

    const hotFile = path.join(tempCacheDir, 'hot', `${key}.rkllmcache`);
    const coldFile = path.join(tempCacheDir, 'cold', `${key}.rkllmcache`);
    assert.ok(!fs.existsSync(hotFile), 'Should not exist in hot cache');
    assert.ok(fs.existsSync(coldFile), 'Should exist in cold cache');

    // Retrieve via getCachePath
    const foundPath = await getCachePath(key);
    assert.equal(foundPath, coldFile, 'Should return cold cache path directly');
    assert.ok(!fs.existsSync(hotFile), 'Should still not exist in hot cache');
    assert.ok(fs.existsSync(coldFile), 'Should still exist in cold cache');

    const stats = getCacheStats();
    assert.equal(stats.hot.entries, 0);
    assert.equal(stats.cold.entries, 1);
  });

  test('evicts oldest cold cache entries dynamically during mirroring when cold cache is full', async () => {
    clearAllCache();

    // Set limits: hot = 50MB, cold = 1MB (extremely small to trigger eviction)
    dbSetSetting('cache_hot_limit_mb', '50');
    dbSetSetting('cache_cold_limit_mb', '1');

    // Write first file (0.6 MB)
    const key1 = 'coldkey1';
    const tmpFile1 = path.join(tempCacheDir, 'tmp_file1.rkllmcache');
    fs.writeFileSync(tmpFile1, 'a'.repeat(600 * 1024)); // 600 KB
    putCachePath(key1, tmpFile1, 'rkllm', 'off');

    // Wait a bit to ensure distinct timestamps
    await new Promise(r => setTimeout(r, 10));

    // Write second file (0.6 MB) - total will be 1.2MB, exceeding 1MB cold limit
    const key2 = 'coldkey2';
    const tmpFile2 = path.join(tempCacheDir, 'tmp_file2.rkllmcache');
    fs.writeFileSync(tmpFile2, 'b'.repeat(600 * 1024)); // 600 KB
    putCachePath(key2, tmpFile2, 'rkllm', 'off');

    const stats = getCacheStats();
    // Cold cache entries should have evicted coldkey1 and kept coldkey2
    assert.equal(stats.cold.entries, 1);
    
    const coldFile1 = path.join(tempCacheDir, 'cold', `${key1}.rkllmcache`);
    const coldFile2 = path.join(tempCacheDir, 'cold', `${key2}.rkllmcache`);
    assert.ok(!fs.existsSync(coldFile1), 'coldkey1 should be evicted');
    assert.ok(fs.existsSync(coldFile2), 'coldkey2 should remain');
  });

  test('seamlessly falls back to cold cache path when promoted hot file is immediately evicted due to hotLimitMB', async () => {
    clearAllCache();

    // Set hot limit extremely small (e.g. 0.1 MB) and cold limit larger
    dbSetSetting('cache_hot_limit_mb', '1');
    dbSetSetting('cache_cold_limit_mb', '50');

    // Write a file that exceeds the hot limit (1.5 MB) directly to cold when hot is disabled
    dbSetSetting('cache_hot_limit_mb', '0');
    const key = 'hugepromotekey';
    const tmpFile = path.join(tempCacheDir, 'tmp_huge.rkllmcache');
    fs.writeFileSync(tmpFile, 'h'.repeat(1500 * 1024)); // 1.5 MB
    putCachePath(key, tmpFile, 'rkllm', 'off');

    const hotFile = path.join(tempCacheDir, 'hot', `${key}.rkllmcache`);
    const coldFile = path.join(tempCacheDir, 'cold', `${key}.rkllmcache`);
    assert.ok(!fs.existsSync(hotFile));
    assert.ok(fs.existsSync(coldFile));

    // Enable hot cache with small limit (1 MB)
    dbSetSetting('cache_hot_limit_mb', '1');

    // Retrieve via getCachePath (it will attempt to promote, but file is 1.5MB which is > 1MB, so it immediately evicts from hot)
    const foundPath = await getCachePath(key);
    
    // It should seamlessly return the coldFile path and not crash or return a non-existent hotFile path
    assert.equal(foundPath, coldFile, 'Should fall back to cold cache path');
    assert.ok(!fs.existsSync(hotFile), 'Should not exist in hot cache because it was evicted');
    assert.ok(fs.existsSync(coldFile), 'Should still exist in cold cache');
  });
});

describe('Segment-Based Prefix Caching', () => {

  before(() => {
    fs.mkdirSync(tempCacheDir, { recursive: true });
    dbSetSetting('cache_enabled', '1');
    dbSetSetting('cache_dir', tempCacheDir);
  });

  after(() => {
    clearAllCache();
  });

  test('returns empty results on empty segments', async () => {
    const res = await resolveSegmentsCache('my-model', []);
    assert.deepEqual(res.keys, []);
    assert.equal(res.hitIndex, -1);
    assert.equal(res.loadCachePath, null);
    assert.deepEqual(res.missedSegments, []);
  });

  test('successfully hashes, chains and resolves segments hits and misses', async () => {
    clearAllCache();
    const model = 'my-model';
    const segments = [
      { id: 'seg1', content: 'system rules' },
      { id: 'seg2', content: 'agent prompt' },
      { id: 'seg3', content: 'task summary' }
    ];

    // First resolve (cold cache, everything missed)
    const res1 = await resolveSegmentsCache(model, segments);
    assert.equal(res1.keys.length, 3);
    assert.equal(res1.hitIndex, -1);
    assert.equal(res1.loadCachePath, null);
    assert.equal(res1.missedSegments.length, 3);
    assert.equal(res1.missedSegments[0].id, 'seg1');

    // Manually cache the first segment key to simulate a hit
    const key1 = res1.keys[0];
    const tmpFile = path.join(tempCacheDir, 'tmp_seg1.rkllmcache');
    fs.writeFileSync(tmpFile, 'seg1 cache content');
    putCachePath(key1, tmpFile, 'rkllm', 'off');

    // Second resolve (first segment hits, others miss)
    const res2 = await resolveSegmentsCache(model, segments);
    assert.equal(res2.hitIndex, 0);
    assert.ok(res2.loadCachePath?.includes(key1), 'loadCachePath should resolve to cached segment 1');
    assert.equal(res2.missedSegments.length, 2);
    assert.equal(res2.missedSegments[0].id, 'seg2');
    assert.equal(res2.missedSegments[1].id, 'seg3');

    // Manually cache the second segment key (chains under first)
    const key2 = res1.keys[1];
    const tmpFile2 = path.join(tempCacheDir, 'tmp_seg2.rkllmcache');
    fs.writeFileSync(tmpFile2, 'seg2 cache content');
    putCachePath(key2, tmpFile2, 'rkllm', 'off');

    // Third resolve (first and second segment hit, third misses)
    const res3 = await resolveSegmentsCache(model, segments);
    assert.equal(res3.hitIndex, 1);
    assert.ok(res3.loadCachePath?.includes(key2), 'loadCachePath should resolve to cached segment 2');
    assert.equal(res3.missedSegments.length, 1);
    assert.equal(res3.missedSegments[0].id, 'seg3');
  });
});

