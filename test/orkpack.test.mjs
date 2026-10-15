import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readOrkpackFooter, sigQbits, sigCompatible, orkEnvFrom, isOrkpackUsable,
  orkpackPathFor, MAGIC, FOOTER_SIZES, footerSize,
  resolveOrkpackVersion, ORKPACK_VERSION_FALLBACK, ORKPACK_VERSION_NEWEST_KNOWN,
  isOrkpackPath, stubPathFor, sourceGgufFor, orkQuantForSource, sigPrecision, packBuildRecord } from '../src/orkpack.js';
import { ggufQuantBits } from '../src/gguf.js';

// ── Minimal .orkpack writer (mirrors the reader's understanding of the footer) ────
// struct orkpack_footer { u64 index_off; u32 n_entries; u32 version; u32 ork_fmt; u32 quant_sig;
//                         /* v7 */ u64 calib_off; u32 calib_n; u32 calib_pad;
//                                  u32 prov_flags; u32 prov_pad; u64 prov_imhash;
//                         char magic[8]; }
// The first five fields are at 0/8/12/16/20 in every version and magic is always the last 8 bytes;
// what changes between versions is the distance between them. Verified against the C struct.
// The version these fixtures are written at. Named here rather than imported as "the current
// version", because there no longer IS one in the module: the version in force is a property of the
// INSTALLED RUNTIME (manifest.json `orkpackVersion`), so a test that leaned on a module constant would
// be asserting against whichever runtime bundle happens to sit on the machine running the tests.
const CUR = ORKPACK_VERSION_NEWEST_KNOWN;
const CUR_SIZE = footerSize(CUR);
// What isOrkpackUsable is told to expect. PASSED, not configured — the value is an argument precisely
// so neither the tests nor anything else needs an env knob to steer it.
const EXPECT_CUR = { version: CUR, layoutKnown: true, fromManifest: true, source: 'test' };
const usable = (p, precision = null, expected = EXPECT_CUR) => isOrkpackUsable(p, precision, expected);

function footer({ indexOff = 64, nEntries = 12, version = CUR, orkFmt = 0, quantSig = 0,
                  magic = MAGIC, calibOff = 0, calibN = 0, provImhash = 0n } = {}) {
  const size = FOOTER_SIZES[version] ?? CUR_SIZE;
  const b = Buffer.alloc(size);
  b.writeBigUInt64LE(BigInt(indexOff), 0);
  b.writeUInt32LE(nEntries, 8);
  b.writeUInt32LE(version, 12);
  b.writeUInt32LE(orkFmt, 16);
  b.writeUInt32LE(quantSig, 20);
  if (size >= 64) {
    b.writeBigUInt64LE(BigInt(calibOff), 24);
    b.writeUInt32LE(calibN, 32);
    b.writeBigUInt64LE(BigInt(provImhash), 48);
  }
  b.write(magic, size - 8, 'latin1');
  return b;
}

// A whole pack file: `body` bytes of blobs+index, then the footer at EOF.
function writePack(dir, name, opts = {}, bodyLen = 128) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.concat([Buffer.alloc(bodyLen, 0xab), footer(opts)]));
  return p;
}

// Signature bits, as ggml-ork's ork_build_sig composes them.
const sig = ({ q = 0, hy = 0, hd = 0 } = {}) =>
  (q ? q.charCodeAt(0) : 0) | (hy << 8) | (hd << 9);

let tmp;
const mktmp = () => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkpack-')));

describe('readOrkpackFooter', () => {
  test('round-trips every footer field', () => {
    const d = mktmp();
    const p = writePack(d, 'm.orkpack', { indexOff: 4096, nEntries: 733, orkFmt: 0, quantSig: sig({ q: '4', hy: 1, hd: 1 }) });
    const f = readOrkpackFooter(p);
    assert.equal(f.magic, MAGIC);
    assert.equal(f.version, CUR);
    assert.equal(f.indexOff, 4096);
    assert.equal(f.nEntries, 733);
    assert.equal(f.orkFmt, 0);
    assert.equal(f.quantSig, 0x334);          // '4' | HY | HD
    assert.equal(f.size, 128 + CUR_SIZE);
  });

  test('reads the v7 calibration + provenance tail', () => {
    const p = writePack(mktmp(), 'v7.orkpack', { version: 7, calibOff: 2048, calibN: 3, provImhash: 0xdeadbeefn });
    const f = readOrkpackFooter(p);
    assert.equal(f.version, 7);
    assert.equal(f.calibOff, 2048);
    assert.equal(f.calibN, 3);
    assert.equal(f.provImhash, 'deadbeef');
  });

  // The regression this guards: a v7 footer read at the v6 offsets still finds `magic` (always the last
  // 8 bytes) but takes its five fields 32 bytes too early — all zeros — so a healthy pack reports
  // version 0 / 0 entries and is rebuilt on every scan. The layout must follow the version field.
  test('picks the layout by version, not by a fixed offset', () => {
    const d = mktmp();
    const v6 = readOrkpackFooter(writePack(d, 'old.orkpack', { version: 6, nEntries: 112, indexOff: 1024 }));
    assert.equal(v6.version, 6);
    assert.equal(v6.nEntries, 112);
    assert.equal(v6.indexOff, 1024);
    assert.equal(v6.calibOff, undefined, 'v6 has no calibration block');
    const v7 = readOrkpackFooter(writePack(d, 'new.orkpack', { version: 7, nEntries: 150, indexOff: 2048 }));
    assert.equal(v7.version, 7);
    assert.equal(v7.nEntries, 150);
    assert.equal(v7.indexOff, 2048);
  });

  test('reports an unrecognised version as a pack, not as garbage', () => {
    const f = readOrkpackFooter(writePack(mktmp(), 'future.orkpack', { version: 99 }));
    assert.equal(f.magic, MAGIC);
    assert.equal(f.version, 0, 'no layout matched → version 0, which is stale');
  });

  test('null for a missing file', () => {
    assert.equal(readOrkpackFooter(path.join(mktmp(), 'nope.orkpack')), null);
  });

  test('null for a file too short to hold a footer', () => {
    const d = mktmp(), p = path.join(d, 'short.orkpack');
    fs.writeFileSync(p, Buffer.alloc(CUR_SIZE));     // == footer size, so no room for content
    assert.equal(readOrkpackFooter(p), null);
  });
});

describe('sigQbits', () => {
  test("'4' → 4, everything else → 8", () => {
    assert.equal(sigQbits(sig({ q: '4' })), 4);
    assert.equal(sigQbits(sig({ q: '8' })), 8);
    assert.equal(sigQbits(sig({})), 8);            // source-driven default reads as the int8 tier
    assert.equal(sigQbits(sig({ q: '4', hy: 1 })), 4);   // the HY bit must not bleed into the tier
  });
});

// ROTATION — and why the signature bit is no longer part of the answer.
//
// This block used to assert the opposite of what it asserts now, on the reasoning that "a SET HD bit
// can only have been stamped by a build that rotated, so refusing it from a NOROT run is always
// right". That reasoning was wrong: the runtime DERIVES the bit as `forced_qbits == 4 && !NOROT` and
// never looks at the weights, so it is set on an unrotated NF4 i4a8 pack too — which is the tier the
// 4-bit rule picks whenever the machine can afford int8 residency, i.e. the common case, not a corner.
// MEASURED on a pack built from qwen3-1.7b-f16 on 2026-10-15: 196 DT_I4 (unrotated) entries, recorded
// ROTATED = 0, SIG_HD_BIT = 1.
//
// The answer now comes from the footer's RECORDED build flags, and from nothing at all when the pack
// predates them.
describe('rotation', () => {
  const BUILDREC = 0x10, ROTATED = 0x20;

  test('the derived signature bit decides nothing, in either direction', () => {
    // Set, with no recorded flags: UNKNOWN, so the pack is not refused.
    assert.equal(sigCompatible(sig({ q: '4', hd: 1 }), { orkQuant: '4', orkNoRot: '1' }), true);
    // Clear, likewise: a clear bit was never evidence of an unrotated build.
    assert.equal(sigCompatible(sig({ q: '4', hd: 0 }), { orkQuant: '4', orkNoRot: '1' }), true);
  });

  test('a RECORDED rotated pack is refused by an ORK_I4_NOROT run', () => {
    assert.equal(sigCompatible(sig({ q: '4', hd: 1 }), { orkQuant: '4', orkNoRot: '1' },
                               BUILDREC | ROTATED), false);
  });

  test('a RECORDED unrotated pack is accepted, even with the derived bit set', () => {
    // Exactly the case the old rule got wrong: HD=1 but the entries are unrotated NF4.
    assert.equal(sigCompatible(sig({ q: '4', hd: 1 }), { orkQuant: '4', orkNoRot: '1' },
                               BUILDREC), true);
  });

  test('an int8 pack is never judged on rotation', () => {
    assert.equal(sigCompatible(sig({ q: '8' }), { orkQuant: '8', orkNoRot: '1' }), true);
  });
});

describe('packBuildRecord', () => {
  const B = 0x10, R = 0x20, S = 0x40, P = 0x80, G = 0x01;

  test('a pack with no record answers UNKNOWN, never "no"', () => {
    // The distinction is the whole point: "not applied" invites leaving the pack alone, "unknown"
    // invites rebuilding it. Collapsing them is how a stale pack survives.
    for (const f of [{}, { provFlags: 0 }]) {
      const r = packBuildRecord(f);
      assert.equal(r.recorded, false);
      assert.equal(r.rotated, null);
      assert.equal(r.smooth, null);
      assert.equal(r.gptq, null);
      assert.equal(r.promoted, null);
    }
  });

  test('a recorded pack answers true/false per rung', () => {
    const r = packBuildRecord({ provFlags: B | R | S | G });
    assert.equal(r.recorded, true);
    assert.equal(r.rotated, true);
    assert.equal(r.smooth, true);
    assert.equal(r.gptq, true);
    assert.equal(r.promoted, false);   // recorded AND absent — a real "no", not an unknown
  });

  test('BUILDREC alone means every rung is recorded as NOT applied', () => {
    const r = packBuildRecord({ provFlags: B });
    assert.equal(r.recorded, true);
    assert.deepEqual([r.rotated, r.smooth, r.gptq, r.promoted], [false, false, false, false]);
  });
});

describe('sigPrecision', () => {
  test('reports the precision the pack was built at', () => {
    assert.deepEqual(sigPrecision(sig({ q: '4' })),         { orkQuant: '4', orkHybrid: null });
    assert.deepEqual(sigPrecision(sig({ q: '8' })),         { orkQuant: '8', orkHybrid: null });
    assert.deepEqual(sigPrecision(sig({ q: '8', hy: 1 })),  { orkQuant: '8', orkHybrid: '1' });
  });

  test('a pack always adopts its own precision', () => {
    // The property the load path depends on: resolving a pack under 'auto' can never produce an env
    // the runtime would then reject as stale.
    for (const q of ['4', '8']) for (const hy of [0, 1]) {
      const v = sig({ q, hy });
      assert.equal(sigCompatible(v, sigPrecision(v)), true, `q${q} hy${hy}`);
    }
  });
});

describe('sigCompatible', () => {
  // ORK_HYBRID is PRESCRIPTIVE: it changes which tensors are packed at all.
  test('hybrid must match exactly, in both directions', () => {
    assert.equal(sigCompatible(sig({ q: '4', hy: 1 }), { orkQuant: '4', orkHybrid: '1' }), true);
    assert.equal(sigCompatible(sig({ q: '4', hy: 1 }), { orkQuant: '4', orkHybrid: null }), false);
    assert.equal(sigCompatible(sig({ q: '4' }),        { orkQuant: '4', orkHybrid: '1' }),  false);
  });

  // ORK_QUANT is DESCRIPTIVE: a run that forces no precision adopts whatever tier the pack holds.
  test('quant gates only when the run forces a precision', () => {
    assert.equal(sigCompatible(sig({ q: '4' }), { orkQuant: null }), true, 'unset adopts an int4 pack');
    assert.equal(sigCompatible(sig({ q: '8' }), { orkQuant: null }), true, 'unset adopts an int8 pack');
    assert.equal(sigCompatible(sig({ q: '4' }), { orkQuant: '4' }),  true);
    assert.equal(sigCompatible(sig({ q: '4' }), { orkQuant: '8' }),  false);
    assert.equal(sigCompatible(sig({ q: '8' }), { orkQuant: '4' }),  false);
  });

  // This is the case the old tag-based check missed: an idle build with no precision produced a
  // signature of 0, which an int4 serve then refuses.
  test('a default-built pack is refused by an int4 serve', () => {
    assert.equal(sigCompatible(sig({}), { orkQuant: '4' }), false);
    assert.equal(sigCompatible(sig({}), { orkQuant: '8' }), true);
  });

  // ggml-ork deliberately leaves the rotation bit out of this predicate.
  test('the rotation bit is not part of the check', () => {
    assert.equal(sigCompatible(sig({ q: '4', hd: 1 }), { orkQuant: '4' }), true);
    assert.equal(sigCompatible(sig({ q: '4', hd: 0 }), { orkQuant: '4' }), true);
  });
});

describe('orkEnvFrom', () => {
  test('emits only the knobs that are set', () => {
    assert.deepEqual(orkEnvFrom({ orkQuant: '4', orkHybrid: '1' }), { ORK_QUANT: '4', ORK_HYBRID: '1' });
    assert.deepEqual(orkEnvFrom({ orkQuant: '8', orkHybrid: null }), { ORK_QUANT: '8' });
    assert.deepEqual(orkEnvFrom({}), {});
    assert.deepEqual(orkEnvFrom(), {});
  });
});

describe('isOrkpackUsable', () => {
  test('accepts a well-formed pack at the version in force', () => {
    assert.equal(usable(writePack(mktmp(), 'ok.orkpack')), true);
  });

  test('rejects a foreign magic', () => {
    assert.equal(usable(writePack(mktmp(), 'bad.orkpack', { magic: 'NOTAPACK' })), false);
  });

  // The runtime adopts exactly one layout (ork_pack_version_ok is `v == ORKPACK_VERSION`) and
  // regenerates everything else, so every other number — including the v6 we used to accept — is stale.
  // Expressed relative to the version in force rather than as a literal list: this test once named 8
  // as a version that must be refused, which silently became wrong the moment the format bumped to v8.
  test('rejects any version but the one in force', () => {
    const d = mktmp();
    for (const v of [1, 5, CUR - 1, CUR + 1]) {
      assert.equal(usable(writePack(d, `v${v}.orkpack`, { version: v })), false, `v${v} must be refused`);
    }
    assert.equal(usable(writePack(d, 'vcur.orkpack', { version: CUR })), true,
                 `v${CUR} (in force) must be accepted`);
  });

  // THE POINT OF THE WHOLE EXERCISE. The version in force follows the installed runtime, so a board
  // running an older bundle accepts that bundle's packs and asks for no rebuild. Hardcoding the
  // reader's number is what produces the loop: stale → rebuild → old builder → stale → …
  test('follows the runtime: an older declared version accepts older packs and refuses newer ones', () => {
    const d = mktmp();
    const old = resolveOrkpackVersion({ tag: 'b11000-ork', orkpackVersion: 7 });
    assert.deepEqual(old, { version: 7, layoutKnown: true, fromManifest: true, source: 'installed runtime manifest' });
    assert.equal(usable(writePack(d, 'v7.orkpack', { version: 7 }), null, old), true,
                 'a v7 pack is exactly what a v7 builder produces — never stale');
    assert.equal(usable(writePack(d, 'v8.orkpack', { version: 8 }), null, old), false,
                 'a v8 pack is not loadable by a v7 runtime');
  });

  test('a runtime declaring a version we cannot parse stops gating, rather than looping', () => {
    const d = mktmp();
    const future = resolveOrkpackVersion({ orkpackVersion: ORKPACK_VERSION_NEWEST_KNOWN + 5 });
    assert.equal(future.layoutKnown, false);
    // We could not read the rebuild's footer either, so condemning these would only spin the
    // scheduler. Leave the verdict to the runtime, which can actually act on it.
    assert.equal(usable(writePack(d, 'cur.orkpack', { version: CUR }), null, future), true);
    // Structural checks still apply — this is not a blanket pass.
    assert.equal(usable(writePack(d, 'bad.orkpack', { magic: 'NOTAPACK' }), null, future), false);
    assert.equal(usable(writePack(d, 'trunc.orkpack', { indexOff: 1 << 20 }), null, future), false);
  });

  test('rejects an index offset past EOF (truncated pack)', () => {
    assert.equal(usable(writePack(mktmp(), 'trunc.orkpack', { indexOff: 1 << 20 })), false);
  });

  test('applies the precision signature when one is supplied', () => {
    const p = writePack(mktmp(), 'i4.orkpack', { quantSig: sig({ q: '4', hd: 1 }) });
    assert.equal(usable(p, { orkQuant: '4' }), true);
    assert.equal(usable(p, { orkQuant: '8' }), false);
    assert.equal(usable(p, { orkQuant: '4', orkHybrid: '1' }), false);
    assert.equal(usable(p), true, 'no precision → structural check only');
  });

  test('rejects a missing pack', () => {
    assert.equal(isOrkpackUsable(path.join(mktmp(), 'absent.orkpack')), false);
  });
});

describe('orkpackPathFor', () => {
  test('swaps the .gguf extension, case-insensitively, leaving the directory intact', () => {
    assert.equal(orkpackPathFor('/m/a/b.gguf'), '/m/a/b.orkpack');
    assert.equal(orkpackPathFor('/m/a/b.GGUF'), '/m/a/b.orkpack');
    assert.equal(orkpackPathFor('/m/gguf-repo/x-00001-of-00003.gguf'), '/m/gguf-repo/x-00001-of-00003.orkpack');
  });
});

describe('pack identity', () => {
  test('recognises a pack and derives its companions', () => {
    assert.equal(isOrkpackPath('a/b.orkpack'), true);
    assert.equal(isOrkpackPath('a/b.gguf'), false);
    // The extracted sparse gguf reuses the runtime's own stub name, so only ever one file exists.
    assert.equal(stubPathFor('/m/x.orkpack'), '/m/x.orkpack.gguf');
    // Provenance only — the source may well have been deleted after packing, which is the point.
    assert.equal(sourceGgufFor('/m/x.orkpack'), '/m/x.gguf');
  });
});

describe('orkQuantForSource', () => {
  // The pack decides what the weights are; the gguf is only the material it is built from.
  test('an UNQUANTIZED source builds an int4 (NF4) pack — the recommended setup', () => {
    for (const b of [16, 32]) assert.equal(orkQuantForSource(b, 'auto'), '4', `${b}-bit source`);
  });

  test('an already-quantized >=5-bit source builds int8, because int4 would be uniform not NF4', () => {
    for (const b of [5, 6, 8]) assert.equal(orkQuantForSource(b, 'auto'), '8', `${b}-bit source`);
  });

  test('a <5-bit source is left to the runtime mixed dispatch', () => {
    for (const b of [2, 3, 4]) assert.equal(orkQuantForSource(b, 'auto'), null, `${b}-bit source`);
  });

  test('an explicit setting always wins over the source', () => {
    assert.equal(orkQuantForSource(16, 'int8'), '8');
    assert.equal(orkQuantForSource(4,  'int4'), '4');
    assert.equal(orkQuantForSource(8,  'int4'), '4');
  });

  test('a missing/garbage width is left to the runtime', () => {
    assert.equal(orkQuantForSource(NaN, 'auto'), null);
    assert.equal(orkQuantForSource(undefined, 'auto'), null);
  });

  // End to end over real filenames: this is the pairing that actually decides a build.
  test('real filenames map to the intended tier', () => {
    const t = (f, exp) => assert.equal(orkQuantForSource(ggufQuantBits(f), 'auto'), exp, f);
    t('Qwen3-1.7B-F16.gguf',        '4');   // the recommended input
    t('Qwen3-1.7B-BF16.gguf',       '4');
    t('Qwen3-1.7B-UD-Q8_K_XL.gguf', '8');
    t('Qwen3-1.7B-UD-Q4_K_XL.gguf', null);
    t('Qwen3-27B-IQ4_XS.gguf',      null);
  });
});

// ── the pack version in force comes from the RUNTIME, not from this source file ──────────────────
//
// The service (apt) and the llama runtime (tarball) are adopted independently, so a board routinely
// runs a current service against a months-old runtime. Both sides compare pack versions for exact
// equality, so a reader that assumes a version its builder does not produce marks every pack stale,
// rebuilds them WITH THAT SAME OLD BUILDER, and gets the same answer — a rebuild loop that cannot
// terminate, each turn GGUF-load-bound (hours for a 27B).
describe('resolveOrkpackVersion', () => {
  test('takes the number the installed runtime publishes', () => {
    assert.deepEqual(resolveOrkpackVersion({ tag: 'b11552-ork', orkpackVersion: 8 }),
      { version: 8, layoutKnown: true, fromManifest: true, source: 'installed runtime manifest' });
  });

  // Every bundle in the wild predates the field. This is the ordinary case, not an error case.
  test('falls back to the OLD version when the manifest does not say', () => {
    for (const m of [{ tag: 'b11000-ork' }, { tag: 'b11000-ork', orkpackVersion: null }]) {
      const r = resolveOrkpackVersion(m);
      assert.equal(r.version, ORKPACK_VERSION_FALLBACK);
      assert.equal(r.version, 7, 'the fallback must be the last version that shipped, not the newest known');
      assert.equal(r.fromManifest, false);
      assert.equal(r.layoutKnown, true);
      assert.match(r.source, /predates/);
    }
  });

  test('falls back when there is no manifest at all', () => {
    for (const m of [null, undefined, 'not-an-object', 42]) {
      const r = resolveOrkpackVersion(m);
      assert.equal(r.version, ORKPACK_VERSION_FALLBACK);
      assert.equal(r.fromManifest, false);
    }
  });

  // The asymmetry is the whole design. Assuming OLD and being wrong costs ONE rebuild, which the
  // runtime performs itself at load. Assuming NEW and being wrong costs a loop with no exit.
  test('the fallback is never the newest version this reader knows', () => {
    assert.ok(ORKPACK_VERSION_FALLBACK < ORKPACK_VERSION_NEWEST_KNOWN,
      'a fallback equal to the newest known number reintroduces the rebuild loop on every older runtime');
  });

  test('a garbage orkpackVersion falls back rather than being believed', () => {
    for (const v of ['8', 8.5, 0, -1, true, {}]) {
      const r = resolveOrkpackVersion({ orkpackVersion: v });
      assert.equal(r.version, ORKPACK_VERSION_FALLBACK, `orkpackVersion=${JSON.stringify(v)} must not be adopted`);
      assert.equal(r.fromManifest, false);
    }
  });

  test('a version newer than any layout we parse is reported, not swallowed', () => {
    const v = ORKPACK_VERSION_NEWEST_KNOWN + 1;
    const r = resolveOrkpackVersion({ orkpackVersion: v });
    assert.equal(r.version, v);
    assert.equal(r.fromManifest, true);
    assert.equal(r.layoutKnown, false, 'no footer layout → freshness cannot be adjudicated here');
  });

  // Every number the reader can parse must also be nameable by a runtime, or a runtime that builds it
  // would land on the unparseable path.
  test('every layout in FOOTER_SIZES resolves cleanly', () => {
    for (const v of Object.keys(FOOTER_SIZES).map(Number)) {
      const r = resolveOrkpackVersion({ orkpackVersion: v });
      assert.deepEqual(r, { version: v, layoutKnown: true, fromManifest: true, source: 'installed runtime manifest' });
      assert.equal(footerSize(v), FOOTER_SIZES[v]);
    }
  });
});
