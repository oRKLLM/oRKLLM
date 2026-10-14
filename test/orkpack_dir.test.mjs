// Directory-based .orkpack layout — resolution, enumeration, removal, migration.
//
// Spec: docs/ORKPACK_DIRECTORY_LAYOUT.md. The governing property under test throughout is that the
// SOURCE is the identity and the variant is an attribute: a re-quantize moves the FILE and must not
// move any key. The last two describes pin that directly.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  orkpackPathFor, orkpackDirFor, isPackDir, readPackDirMarker, writePackDirMarker,
  isBuildingPack, PACK_DIR_MARKER,
} from '../src/orkpack.js';
import {
  listOrkpackVariants, resolveOrkpack, supersededByPack, orkpackFileFor,
  orkpackBuildTarget, finalizeOrkpackBuild, discardOrkpackBuild, removeOrkpack,
  orkpackMigrateToDir, orkpackUnmigrateFromDir, clearOrkpackDirState, defaultPackBudgetMB,
} from '../src/orkpack_dir.js';
import { packQuantLabel } from '../src/quant_plan.js';

// ── a real .orkpack: blobs, {u64 meta_off, u64 meta_size} + entries, then the v7 footer ──
// Same shape as test/quant_plan.test.mjs's writer, so `measureFromPack` walks it and the bpw these
// tests resolve on is a MEASURED number off a real index — not a filename parsed back.
function orkpack(file, entries, { carried = 4096, version = 7, orkFmt = 0, quantSig = 0 } = {}) {
  const blobs = []; let off = 0;
  const recs = entries.map(e => {
    const blobSize = e.bpw === 8 ? e.K * e.N : e.K * e.N / 2;
    const r = { ...e, blobOff: off, blobSize, bfSize: 0 };
    blobs.push(Buffer.alloc(blobSize)); off += blobSize; return r;
  });
  const meta = Buffer.alloc(carried); const metaOff = off; off += carried;
  const idx = [Buffer.alloc(16)];
  idx[0].writeBigUInt64LE(BigInt(metaOff), 0);
  idx[0].writeBigUInt64LE(BigInt(carried), 8);
  for (const r of recs) {
    const nm = Buffer.from(r.name, 'utf8');
    const nl = Buffer.alloc(4); nl.writeUInt32LE(nm.length);
    const e = Buffer.alloc(56);
    e.writeUInt32LE(r.K, 0); e.writeUInt32LE(r.N, 4);
    e.writeUInt32LE(r.bpw === 8 ? 1 : 5, 8); e.writeUInt32LE(0, 12);
    e.writeBigUInt64LE(BigInt(r.blobOff), 16);
    e.writeBigUInt64LE(BigInt(r.blobSize), 24);
    e.writeBigUInt64LE(0n, 32); e.writeBigUInt64LE(0n, 40);
    e.writeFloatLE(r.qerr ?? 0, 48); e.writeUInt32LE(0, 52);
    idx.push(nl, nm, e);
  }
  const index = Buffer.concat(idx);
  const f = Buffer.alloc(64);
  f.writeBigUInt64LE(BigInt(off), 0);
  f.writeUInt32LE(recs.length, 8);
  f.writeUInt32LE(version, 12);
  f.writeUInt32LE(orkFmt, 16);
  f.writeUInt32LE(quantSig, 20);
  f.write('ORKPK01\0', 56, 'latin1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...blobs, meta, index, f]));
  return file;
}

const SIG4 = 0x34, SIG8 = 0x38;                       // ork_build_sig's forced-precision char
// A uniform pack at `bpw` over one weight of K*N — so currentBpw measures to exactly `bpw`.
const packAt = (file, bpw, { K = 1024, N = 512, quantSig = bpw === 8 ? SIG8 : SIG4, ...rest } = {}) =>
  orkpack(file, [{ name: 'blk.0.attn_q.weight', K, N, bpw }], { quantSig, ...rest });

let tmp;
const mk = () => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkdir-')));
const src = (d, name = 'Qwen3.8-27B-BF16.gguf') => {
  const p = path.join(d, name);
  fs.writeFileSync(p, Buffer.alloc(64));              // a stand-in source; nothing reads its contents
  return p;
};
// resolveOrkpack now ALWAYS reports which artifact it selected and why (so a benchmark log records
// the artifact it measured). Capture it rather than letting it spam the run, and let the tests that
// care assert on it.
const LOG = { log: [], warn: [] };
let _real;
beforeEach(() => {
  clearOrkpackDirState();
  LOG.log = []; LOG.warn = [];
  _real = { log: console.log, warn: console.warn };
  console.log  = (...a) => LOG.log.push(a.join(' '));
  console.warn = (...a) => LOG.warn.push(a.join(' '));
});
afterEach(() => { console.log = _real.log; console.warn = _real.warn; });

// ─────────────────────────────────────────────────────────────────────────────
describe('the handle and the directory are different paths', () => {
  // ★ THE safety property of the handle design. `<base>.orkpack` and `<base>/` are distinct strings,
  // so a call site that forgets to resolve gets ENOENT — it can never succeed on the DIRECTORY and
  // report a directory's size as a pack's. If this ever stops holding, every unresolved stat becomes
  // a silent-wrongness bug of exactly the family this layout was built to remove.
  test('a handle never stats as the directory', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), { source: path.basename(g) });
    packAt(path.join(orkpackDirFor(g), '4bpw.orkpack'), 4);

    assert.notEqual(orkpackPathFor(g), orkpackDirFor(g));
    assert.ok(fs.statSync(orkpackDirFor(g)).isDirectory());
    assert.throws(() => fs.statSync(orkpackPathFor(g)), { code: 'ENOENT' },
      'the handle must NOT resolve to the directory — a forgotten resolve has to fail loudly');
    // ...and the resolver turns it into a real file.
    assert.ok(fs.statSync(orkpackFileFor(g)).isFile());
  });

  test('a handle with a shard-suffixed source is still not its directory', () => {
    const g = '/m/X-00001-of-00002.gguf';
    assert.equal(orkpackPathFor(g), '/m/X-00001-of-00002.orkpack');
    assert.equal(orkpackDirFor(g), '/m/X-00001-of-00002');
    assert.notEqual(orkpackPathFor(g), orkpackDirFor(g));
  });
});

describe('isPackDir — the marker, and only the marker', () => {
  test('a marked directory is a pack directory', () => {
    const d = mk();
    const rec = writePackDirMarker(path.join(d, 'X'), { source: 'X.gguf' });
    assert.equal(rec.source, 'X.gguf');
    assert.equal(isPackDir(path.join(d, 'X')), true);
    assert.equal(readPackDirMarker(path.join(d, 'X')).schema, 1);
  });

  test('an ordinary model directory holding a pack is NOT one', () => {
    // The real shape on disk today: a HuggingFace repo dir with the source gguf and its legacy pack
    // side by side. A content heuristic would call this a pack directory, hide the source via
    // supersededByPack, and the model would vanish from the UI. The marker cannot make that mistake.
    const d = mk();
    fs.mkdirSync(path.join(d, 'Qwen3-1.7B-GGUF'));
    fs.writeFileSync(path.join(d, 'Qwen3-1.7B-GGUF', 'Qwen3-1.7B-UD-Q4_K_XL.gguf'), 'x');
    packAt(path.join(d, 'Qwen3-1.7B-GGUF', 'Qwen3-1.7B-UD-Q4_K_XL.orkpack'), 4);
    assert.equal(isPackDir(path.join(d, 'Qwen3-1.7B-GGUF')), false);
  });

  test('an unmarked directory of packs is ignored, and says so once', () => {
    const d = mk(); const g = src(d);
    fs.mkdirSync(orkpackDirFor(g));
    packAt(path.join(orkpackDirFor(g), '4bpw.orkpack'), 4);
    assert.equal(listOrkpackVariants(g).layout, 'none');
    listOrkpackVariants(g);                             // second look: still silent
    assert.equal(LOG.warn.length, 1, 'warned exactly once');
    assert.match(LOG.warn[0], /\.orkpack-dir/);
    assert.match(LOG.warn[0], /orkpackMigrateToDir/);
  });

  test('a malformed or future-schema marker is not a marker', () => {
    const d = mk();
    fs.mkdirSync(path.join(d, 'X'));
    fs.writeFileSync(path.join(d, 'X', PACK_DIR_MARKER), 'not json');
    assert.equal(isPackDir(path.join(d, 'X')), false);
    fs.writeFileSync(path.join(d, 'X', PACK_DIR_MARKER), JSON.stringify({ schema: 99 }));
    assert.equal(isPackDir(path.join(d, 'X')), false);
  });
});

describe('legacy layout keeps working', () => {
  test('resolves the legacy file, unchanged', () => {
    const d = mk(); const g = src(d);
    const p = packAt(orkpackPathFor(g), 4);
    const r = resolveOrkpack(g);
    assert.equal(r.path, p);
    assert.equal(r.layout, 'legacy');
    assert.equal(r.reason, 'legacy');
    assert.equal(r.label, '');
    assert.equal(supersededByPack(g), true);
  });

  test('no pack at all resolves to nothing', () => {
    const d = mk(); const g = src(d);
    assert.equal(resolveOrkpack(g), null);
    assert.equal(supersededByPack(g), false);
    assert.deepEqual(listOrkpackVariants(g), { layout: 'none', dir: null, variants: [] });
  });

  test('supersededByPack is size-only on the legacy arm, exactly as before', () => {
    // An empty file is not a pack; a non-empty one counts even if its footer is junk. Pinned because
    // the DIRECTORY arm deliberately tightened to require usability and this arm deliberately did not.
    const d = mk(); const g = src(d);
    fs.writeFileSync(orkpackPathFor(g), '');
    assert.equal(supersededByPack(g), false);
    fs.writeFileSync(orkpackPathFor(g), 'junk-but-not-empty');
    assert.equal(supersededByPack(g), true);
  });
});

describe('directory layout', () => {
  const build = (d, variants, name) => {
    const g = src(d, name);
    writePackDirMarker(orkpackDirFor(g), { source: path.basename(g) });
    for (const [label, bpw, opts] of variants) packAt(path.join(orkpackDirFor(g), `${label}.orkpack`), bpw, opts);
    return g;
  };

  test('one variant resolves as the sole one', () => {
    const d = mk(); const g = build(d, [['4bpw', 4]]);
    const r = resolveOrkpack(g);
    assert.equal(r.reason, 'sole');
    assert.equal(r.label, '4bpw');
    assert.equal(r.layout, 'dir');
    assert.equal(path.basename(r.path), '4bpw.orkpack');
    assert.equal(supersededByPack(g), true);
  });

  test('variants are measured, not parsed out of their names', () => {
    const d = mk(); const g = build(d, [['8bpw', 8], ['4bpw', 4]]);
    const { variants } = listOrkpackVariants(g);
    assert.equal(variants.length, 2);
    for (const v of variants) {
      assert.equal(v.bpw, v.label === '8bpw' ? 8 : 4, 'bpw comes from the index');
      assert.equal(v.qbits, v.label === '8bpw' ? 8 : 4, 'tier comes from the footer');
      assert.equal(v.layout, 'dir');
      assert.ok(v.sizeBytes > 0);
    }
  });

  test('a build in flight is never a variant', () => {
    const d = mk(); const g = build(d, [['4bpw', 4]]);
    packAt(path.join(orkpackDirFor(g), '.building-999-123.orkpack'), 8);
    assert.deepEqual(listOrkpackVariants(g).variants.map(v => v.label), ['4bpw']);
    assert.equal(isBuildingPack('.building-999-123.orkpack'), true);
    assert.equal(isBuildingPack('/a/b/4bpw.orkpack'), false);
  });

  test('the tier rule picks, and an explicit pin beats it', () => {
    const d = mk(); const g = build(d, [['4bpw', 4], ['8bpw', 8]], 'M-Q8_0.gguf');
    // A Q8_0 source is an already-quantized >=5-bit one, so orkQuantForSource says int8.
    assert.equal(resolveOrkpack(g).label, '8bpw');
    assert.equal(resolveOrkpack(g, { settings: { npu_quant: 'int4' } }).label, '4bpw');
    assert.equal(resolveOrkpack(g, { settings: { pack_variant: '4bpw' } }).reason, 'explicit');
    assert.equal(resolveOrkpack(g, { settings: { pack_variant: '4bpw' } }).label, '4bpw');
  });

  test('an explicit pin is returned even when the variant is UNUSABLE', () => {
    // So the load fails loudly through ORKPACK_UNUSABLE instead of silently serving another variant.
    const d = mk(); const g = build(d, [['4bpw', 4]]);
    packAt(path.join(orkpackDirFor(g), 'stale.orkpack'), 8, { version: 6 });
    const r = resolveOrkpack(g, { settings: { pack_variant: 'stale' } });
    assert.equal(r.label, 'stale');
    assert.equal(r.reason, 'explicit');
    assert.equal(r.variant.usable, false);
  });

  test('a pin that no longer exists falls through, loudly, once', () => {
    const d = mk(); const g = build(d, [['4.9bpw', 4]]);
    const r = resolveOrkpack(g, { settings: { pack_variant: '4bpw' } });
    resolveOrkpack(g, { settings: { pack_variant: '4bpw' } });
    assert.equal(r.label, '4.9bpw', 'a load, not a failure');
    assert.notEqual(r.reason, 'explicit');
    assert.equal(LOG.warn.length, 1);
    assert.match(LOG.warn[0], /no longer exists/);
    assert.match(LOG.warn[0], /re-quantize/);
  });

  test('unusable variants are skipped; all-unusable resolves to nothing', () => {
    const d = mk(); const g = build(d, [['4bpw', 4]]);
    packAt(path.join(orkpackDirFor(g), 'old.orkpack'), 8, { version: 6 });
    assert.equal(resolveOrkpack(g).label, '4bpw');

    const d2 = mk(); const g2 = src(d2);
    writePackDirMarker(orkpackDirFor(g2), {});
    packAt(path.join(orkpackDirFor(g2), 'old.orkpack'), 4, { version: 6 });
    assert.equal(resolveOrkpack(g2), null);
    assert.equal(supersededByPack(g2), false, 'a stale-only directory must not hide the source gguf');
    assert.equal(listOrkpackVariants(g2).variants.length, 1, '...but the file is still SEEN');
  });

  test('the directory wins outright and never deletes the legacy file', () => {
    const d = mk(); const g = build(d, [['4bpw', 4]]);
    const legacy = packAt(orkpackPathFor(g), 8);
    const r = resolveOrkpack(g);
    assert.equal(r.layout, 'dir');
    assert.equal(r.label, '4bpw');
    assert.ok(fs.existsSync(legacy), 'the legacy pack is IGNORED, not removed');
  });
});

describe('the tiebreak', () => {
  const twoInTier = (d) => {
    const g = src(d, 'M-BF16.gguf');
    writePackDirMarker(orkpackDirFor(g), {});
    // Same int4 tier, different measured bpw: 4.0 (one int4 weight) and 8.0 (one int8-sized blob
    // carrying the int4 signature), so the budget rule has a real choice to make.
    packAt(path.join(orkpackDirFor(g), 'small.orkpack'), 4, { quantSig: 0x34, K: 1024, N: 512 });
    packAt(path.join(orkpackDirFor(g), 'big.orkpack'), 8, { quantSig: 0x34, K: 1024, N: 512 });
    return g;
  };

  test('highest bpw that FITS the budget', () => {
    const d = mk(); const g = twoInTier(d);
    const all = resolveOrkpack(g, { budgetMB: 4096 });
    assert.equal(all.label, 'big');
    assert.equal(all.reason, 'budget');
  });

  test('when none fits, the LOWEST bpw — never a refusal', () => {
    const d = mk(); const g = twoInTier(d);
    const r = resolveOrkpack(g, { budgetMB: 0 });
    assert.ok(r, 'a model that will not load is a worse failure than a defensible default');
    assert.equal(r.label, 'small');
  });

  test('it is independent of mtime — a touch must not change the answer', () => {
    const d = mk(); const g = twoInTier(d);
    const before = resolveOrkpack(g, { budgetMB: 4096 }).label;
    const loser = path.join(orkpackDirFor(g), 'small.orkpack');
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(loser, t, t);
    clearOrkpackDirState();
    assert.equal(resolveOrkpack(g, { budgetMB: 4096 }).label, before);
  });

  test('an ambiguous pick is a WARNING, naming the winner and the override', () => {
    const d = mk(); const g = twoInTier(d);
    resolveOrkpack(g, { budgetMB: 4096 });
    assert.equal(LOG.warn.length, 1, 'more than one eligible variant is a real choice made for you');
    assert.deepEqual(LOG.log, [], '...and it is not ALSO logged');
    assert.match(LOG.warn[0], /of 2 variant\(s\)/);
    assert.match(LOG.warn[0], /chose 'big'/);
    assert.match(LOG.warn[0], /pack_variant/);
  });

  test('one eligible variant is logged, not warned', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), {});
    packAt(path.join(orkpackDirFor(g), '4bpw.orkpack'), 4);
    resolveOrkpack(g);
    assert.deepEqual(LOG.warn, []);
    assert.equal(LOG.log.length, 1);
  });

  test('defaultPackBudgetMB is a real number, floored', () => {
    assert.ok(defaultPackBudgetMB() >= 1024);
  });
});

// ★ A run that does not record WHICH artifact it used is not a usable record — and the CLI tools
// that derive their own pack path (llama-bench / ork_bench / ork_ppl) are exactly the ones whose
// numbers end up on the wiki. The same line is printed by ggml-ork's [ORK PACK].
describe('the selection is always reported', () => {
  // `tier` pins every variant to the SAME footer tier, so the budget rule is what decides between
  // them — otherwise orkQuantForSource narrows a BF16 source to int4 and the pool is a single pack.
  const dirWith = (d, variants, { name = 'M-BF16.gguf', tier = null } = {}) => {
    const g = src(d, name);
    writePackDirMarker(orkpackDirFor(g), {});
    for (const [label, bpw] of variants) {
      packAt(path.join(orkpackDirFor(g), `${label}.orkpack`), bpw, tier ? { quantSig: tier } : {});
    }
    return g;
  };
  const only = () => { const all = [...LOG.log, ...LOG.warn]; assert.equal(all.length, 1, all.join('\n')); return all[0]; };

  test('every resolution says which pack and by what rule', () => {
    const d = mk();
    resolveOrkpack(dirWith(d, [['4bpw', 4]]));
    const line = only();
    assert.match(line, /4bpw\.orkpack/, 'names the artifact');
    assert.match(line, /only candidate/, 'names the rule');
  });

  test('the legacy layout reports too', () => {
    const d = mk(); const g = src(d);
    packAt(orkpackPathFor(g), 4);
    resolveOrkpack(g);
    assert.match(only(), /legacy layout/);
  });

  test('an explicit pin reports as explicit, and says when it is unusable', () => {
    const d = mk(); const g = dirWith(d, [['4bpw', 4]]);
    packAt(path.join(orkpackDirFor(g), 'stale.orkpack'), 8, { version: 6 });
    resolveOrkpack(g, { settings: { pack_variant: 'stale' } });
    const line = only();
    assert.match(line, /pack_variant='stale'/);
    assert.match(line, /NOT usable/);
  });

  test('the budget line carries the inputs, and calls the footprint a FILE size', () => {
    const d = mk(); const g = dirWith(d, [['4bpw', 4], ['8bpw', 8]], { tier: SIG4 });
    resolveOrkpack(g, { budgetMB: 4096 });
    const line = only();
    assert.match(line, /pack FILE/, 'so nobody reads it as a residency measurement');
    assert.match(line, /not a residency measurement/);
    assert.match(line, /budget .* from the configured weight-residency limit/);
    assert.match(line, /bpw .* measured from the index/);
  });

  test('the unmeasured fallback budget is named as such', () => {
    const d = mk(); const g = dirWith(d, [['4bpw', 4], ['8bpw', 8]], { tier: SIG4 });
    resolveOrkpack(g);                                   // no budgetMB -> defaultPackBudgetMB()
    assert.match(only(), /budget .* from totalmem - 1 GiB/);
  });

  test('it is deduplicated per answer, and a CHANGED answer always prints', () => {
    const d = mk(); const g = dirWith(d, [['4bpw', 4], ['8bpw', 8]], { tier: SIG4 });
    resolveOrkpack(g, { budgetMB: 4096 });
    resolveOrkpack(g, { budgetMB: 4096 });
    resolveOrkpack(g, { budgetMB: 4096 });
    assert.equal([...LOG.log, ...LOG.warn].length, 1, 'the server resolves constantly; repeating is noise');
    resolveOrkpack(g, { settings: { pack_variant: '4bpw' } });
    assert.equal([...LOG.log, ...LOG.warn].length, 2, 'a different answer is always reported');
  });

  test('a resolution to NOTHING prints nothing — there is no artifact to report', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), {});
    packAt(path.join(orkpackDirFor(g), 'old.orkpack'), 4, { version: 6 });
    assert.equal(resolveOrkpack(g), null);
    assert.deepEqual([...LOG.log, ...LOG.warn], []);
  });
});

describe('build target and finalize', () => {
  test('a build target lives in the directory, creates its marker, and is not a variant', () => {
    const d = mk(); const g = src(d);
    const t = orkpackBuildTarget(g);
    assert.equal(path.dirname(t), orkpackDirFor(g));
    assert.ok(isPackDir(orkpackDirFor(g)));
    assert.ok(isBuildingPack(t));
    packAt(t, 4);
    assert.deepEqual(listOrkpackVariants(g).variants, []);
  });

  test('finalize names the pack for what it MEASURES as', () => {
    const d = mk(); const g = src(d);
    const t = orkpackBuildTarget(g);
    packAt(t, 4);
    fs.writeFileSync(t + '.gguf', 'stub');
    const measured = packQuantLabel(t);
    const final = finalizeOrkpackBuild(t);
    assert.equal(path.basename(final), `${measured}.orkpack`);
    assert.equal(path.basename(final), '4bpw.orkpack');
    assert.ok(fs.existsSync(final + '.gguf'), 'sidecars follow the rename');
    assert.ok(!fs.existsSync(t));
    assert.equal(resolveOrkpack(g).label, '4bpw');
  });

  test('a same-label rebuild REPLACES, and never unlinks before the new bytes are in place', () => {
    const d = mk(); const g = src(d);
    finalizeOrkpackBuild(packAt(orkpackBuildTarget(g, 'a'), 4));
    const first = path.join(orkpackDirFor(g), '4bpw.orkpack');
    const firstSize = fs.statSync(first).size;
    const t2 = orkpackBuildTarget(g, 'b');
    packAt(t2, 4, { carried: 65536 });                 // same measured bpw, different file
    const final = finalizeOrkpackBuild(t2);
    assert.equal(final, first, 'one variant, replaced in place');
    assert.notEqual(fs.statSync(final).size, firstSize);
    assert.equal(listOrkpackVariants(g).variants.length, 1);
  });

  test('an unmeasurable pack gets an honest name, never a fabricated number', () => {
    const d = mk(); const g = src(d);
    const t = orkpackBuildTarget(g);
    fs.writeFileSync(t, Buffer.alloc(4096));           // no index to walk, no footer
    const final = finalizeOrkpackBuild(t);
    assert.match(path.basename(final), /^unlabelled-\d+\.orkpack$/);
  });

  test('discarding a build takes its sidecars and leaves finished variants alone', () => {
    const d = mk(); const g = src(d);
    const keep = finalizeOrkpackBuild(packAt(orkpackBuildTarget(g, 'a'), 4));
    const t = orkpackBuildTarget(g, 'b');
    packAt(t, 8); fs.writeFileSync(t + '.tmp', 'x'); fs.writeFileSync(t + '.gguf', 'x');
    discardOrkpackBuild(t);
    assert.ok(!fs.existsSync(t) && !fs.existsSync(t + '.tmp') && !fs.existsSync(t + '.gguf'));
    discardOrkpackBuild(keep);                          // a finished variant is refused
    assert.ok(fs.existsSync(keep));
  });
});

describe('removal', () => {
  test('directory: everything goes, sidecars and stub siblings included', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), {});
    const p = packAt(path.join(orkpackDirFor(g), '4bpw.orkpack'), 4);
    for (const s of ['.gguf', '.gmax', '.prov.json', '-00002-of-00002.gguf']) fs.writeFileSync(p + s, 'x');
    removeOrkpack(g);
    assert.ok(!fs.existsSync(orkpackDirFor(g)));
  });

  test('directory: one variant can be removed on its own', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), {});
    const a = packAt(path.join(orkpackDirFor(g), '4bpw.orkpack'), 4);
    packAt(path.join(orkpackDirFor(g), '8bpw.orkpack'), 8);
    fs.writeFileSync(a + '.gmax', 'x');
    removeOrkpack(g, { variant: '4bpw' });
    assert.ok(!fs.existsSync(a) && !fs.existsSync(a + '.gmax'));
    assert.deepEqual(listOrkpackVariants(g).variants.map(v => v.label), ['8bpw']);
  });

  test('directory: removing the last variant takes the empty directory with it', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), {});
    packAt(path.join(orkpackDirFor(g), '4bpw.orkpack'), 4);
    removeOrkpack(g, { variant: '4bpw' });
    assert.ok(!fs.existsSync(orkpackDirFor(g)));
  });

  test('legacy: the old suffix list PLUS the split-stub siblings it used to miss', () => {
    // The sibling symlinks stubSiblingShards() creates were not in the hardcoded sweep, so a removal
    // left them pointing at a pack that no longer existed. The anchored sweep catches them.
    const d = mk();
    const g = path.join(d, 'X-00001-of-00002.gguf');
    fs.writeFileSync(g, 'x');
    const p = packAt(orkpackPathFor(g), 4);
    for (const s of ['.tmp', '.json', '.meta.json', '.prov.json', '.gmax', '.gguf',
                     '-00002-of-00002.gguf']) fs.writeFileSync(p + s, 'x');
    removeOrkpack(g);
    const left = fs.readdirSync(d).filter(n => n.includes('.orkpack'));
    assert.deepEqual(left, [], `these should all be gone: ${left.join(', ')}`);
  });

  test('legacy: removal never reaches a different model with a shared prefix', () => {
    const d = mk();
    const a = path.join(d, 'Qwen3-1.7B.gguf');
    const b = path.join(d, 'Qwen3-1.7B-extra.gguf');
    fs.writeFileSync(a, 'x'); fs.writeFileSync(b, 'x');
    packAt(orkpackPathFor(a), 4); const keep = packAt(orkpackPathFor(b), 4);
    removeOrkpack(a);
    assert.ok(!fs.existsSync(orkpackPathFor(a)));
    assert.ok(fs.existsSync(keep), 'Qwen3-1.7B-extra.orkpack does not begin with Qwen3-1.7B.orkpack');
  });
});

describe('migration — explicit, reversible, never destructive', () => {
  test('hardlinks, verifies, then unlinks — and the inode is preserved', () => {
    const d = mk(); const g = src(d);
    const legacy = packAt(orkpackPathFor(g), 4);
    fs.writeFileSync(legacy + '.gmax', 'tuning');
    const ino = fs.statSync(legacy).ino;

    const r = orkpackMigrateToDir(g);
    assert.equal(r.ok, true);
    assert.equal(r.layout, 'dir');
    assert.ok(!fs.existsSync(legacy), 'the legacy file is gone only after the link verified');
    assert.equal(path.basename(r.to), '4bpw.orkpack');
    assert.equal(fs.statSync(r.to).ino, ino, 'same inode: no bytes were copied');
    assert.ok(fs.existsSync(r.to + '.gmax'));
    assert.equal(resolveOrkpack(g).label, '4bpw');
  });

  test('dryRun touches nothing', () => {
    const d = mk(); const g = src(d);
    const legacy = packAt(orkpackPathFor(g), 4);
    const r = orkpackMigrateToDir(g, { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(fs.existsSync(legacy));
    assert.ok(!fs.existsSync(orkpackDirFor(g)));
  });

  test('round-trips back to the legacy file', () => {
    const d = mk(); const g = src(d);
    const legacy = packAt(orkpackPathFor(g), 4);
    const before = fs.readFileSync(legacy);
    orkpackMigrateToDir(g);
    const back = orkpackUnmigrateFromDir(g);
    assert.equal(back.ok, true);
    assert.equal(back.to, orkpackPathFor(g));
    assert.ok(fs.readFileSync(orkpackPathFor(g)).equals(before), 'byte-identical');
    assert.ok(!fs.existsSync(orkpackDirFor(g)));
  });

  test('unmigrate refuses to collapse several variants into one name', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), {});
    packAt(path.join(orkpackDirFor(g), '4bpw.orkpack'), 4);
    packAt(path.join(orkpackDirFor(g), '8bpw.orkpack'), 8);
    const r = orkpackUnmigrateFromDir(g);
    assert.equal(r.ok, false);
    assert.match(r.reason, /exactly 1 variant/);
  });

  test('a crash between the link and the unlink resolves to the directory, legacy intact', () => {
    // Simulate the interrupted state: directory populated, legacy still present. (b) in the spec.
    const d = mk(); const g = src(d);
    const legacy = packAt(orkpackPathFor(g), 8);
    writePackDirMarker(orkpackDirFor(g), {});
    fs.linkSync(legacy, path.join(orkpackDirFor(g), '8bpw.orkpack'));
    const r = resolveOrkpack(g);
    assert.equal(r.layout, 'dir');
    assert.ok(fs.existsSync(legacy), 'nothing was deleted on the way through');
  });

  test('migrating something that is already a directory is a no-op success', () => {
    const d = mk(); const g = src(d);
    writePackDirMarker(orkpackDirFor(g), {});
    const r = orkpackMigrateToDir(g);
    assert.equal(r.ok, true);
    assert.match(r.reason, /already/);
  });

  test('nothing to migrate is reported, not invented', () => {
    const d = mk(); const g = src(d);
    assert.deepEqual(orkpackMigrateToDir(g), { ok: false, reason: 'no-legacy-pack' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ The property the whole layout exists for.
describe('identity survives a re-quantize', () => {
  // A toy stand-in for modelSettingsFor's chain: the pack HANDLE's row, falling back to the SOURCE's.
  const settingsFor = (db, id) => db[id] ?? db[id.replace(/\.orkpack$/i, '.gguf')] ?? {};

  test('a re-quantize moves the FILE and no key', () => {
    const d = mk(); const g = src(d);
    const rel = path.basename(g);
    const handle = orkpackPathFor(rel);
    const db = { [rel]: { npu_quant: 'int4', pack_mixed: true, ctx_window: 8192 } };

    // Build at 4.0 bpw.
    finalizeOrkpackBuild(packAt(orkpackBuildTarget(g, 'a'), 4));
    assert.equal(resolveOrkpack(g).label, '4bpw');
    const keyBefore = handle;
    const settingsBefore = settingsFor(db, handle);
    assert.equal(settingsBefore.ctx_window, 8192);

    // Re-quantize to a different measured rate: the variant file is renamed.
    removeOrkpack(g, { variant: '4bpw' });
    const t = orkpackBuildTarget(g, 'b');
    orkpack(t, [{ name: 'a', K: 1024, N: 512, bpw: 8 }, { name: 'b', K: 1024, N: 512, bpw: 4 },
                { name: 'c', K: 1024, N: 512, bpw: 4 }, { name: 'd', K: 1024, N: 512, bpw: 4 }],
            { quantSig: SIG4 });
    const after = finalizeOrkpackBuild(t);
    assert.equal(path.basename(after), '5bpw.orkpack', 'the FILE moved');

    // ...and nothing else did.
    assert.equal(orkpackPathFor(rel), keyBefore, 'the handle is unchanged');
    assert.deepEqual(settingsFor(db, handle), settingsBefore, 'the settings row is unchanged');
    assert.equal(resolveOrkpack(g).label, '5bpw', 'and it still resolves');
  });

  test('the rejected scheme — bpw in the handle — would have orphaned that row', () => {
    // The negative control. Naming the PACK for its bpw makes sourceGgufFor point at a file that does
    // not exist, so the settings carry-over chain breaks the moment the rate changes. This is the
    // 1153606 failure shape, and it is why the directory carries the bpw and the handle does not.
    const db = { 'Qwen3.8-27B-BF16.gguf': { ctx_window: 8192 } };
    const sourceGgufOf = (p) => p.replace(/\.orkpack$/i, '.gguf');
    const bad = 'Qwen3.8-27B-BF16-4.9bpw.orkpack';
    assert.equal(sourceGgufOf(bad), 'Qwen3.8-27B-BF16-4.9bpw.gguf');
    assert.equal(db[sourceGgufOf(bad)], undefined, 'orphaned');

    const good = orkpackPathFor('Qwen3.8-27B-BF16.gguf');
    assert.equal(sourceGgufOf(good), 'Qwen3.8-27B-BF16.gguf');
    assert.equal(db[sourceGgufOf(good)].ctx_window, 8192, 'carried, whatever the variant');
  });
});
