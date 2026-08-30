import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readOrkpackFooter, sigQbits, sigCompatible, orkEnvFrom, isOrkpackUsable,
  orkpackPathFor, ORKPACK_VERSION, FOOTER_SIZE, MAGIC,
  isOrkpackPath, stubPathFor, sourceGgufFor, orkQuantForSource, sigPrecision,
} from '../src/orkpack.js';
import { ggufQuantBits } from '../src/gguf.js';

// ── Minimal .orkpack writer (mirrors the reader's understanding of the footer) ────
// struct orkpack_footer { u64 index_off; u32 n_entries; u32 version; u32 ork_fmt; u32 quant_sig; char magic[8]; }
// Offsets 0/8/12/16/20/24, sizeof 32 — verified against the C struct on this platform.
function footer({ indexOff = 64, nEntries = 12, version = ORKPACK_VERSION, orkFmt = 0, quantSig = 0, magic = MAGIC } = {}) {
  const b = Buffer.alloc(FOOTER_SIZE);
  b.writeBigUInt64LE(BigInt(indexOff), 0);
  b.writeUInt32LE(nEntries, 8);
  b.writeUInt32LE(version, 12);
  b.writeUInt32LE(orkFmt, 16);
  b.writeUInt32LE(quantSig, 20);
  b.write(magic, 24, 'latin1');
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
    assert.equal(f.version, ORKPACK_VERSION);
    assert.equal(f.indexOff, 4096);
    assert.equal(f.nEntries, 733);
    assert.equal(f.orkFmt, 0);
    assert.equal(f.quantSig, 0x334);          // '4' | HY | HD
    assert.equal(f.size, 128 + FOOTER_SIZE);
  });

  test('null for a missing file', () => {
    assert.equal(readOrkpackFooter(path.join(mktmp(), 'nope.orkpack')), null);
  });

  test('null for a file too short to hold a footer', () => {
    const d = mktmp(), p = path.join(d, 'short.orkpack');
    fs.writeFileSync(p, Buffer.alloc(FOOTER_SIZE));   // == footer size, so no room for content
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

describe('rotation bit (SIG_HD_BIT)', () => {
  test('a rotated pack is refused by an ORK_I4_NOROT run', () => {
    assert.equal(sigCompatible(sig({ q: '4', hd: 1 }), { orkQuant: '4', orkNoRot: '1' }), false);
  });

  test('a clear bit is never treated as proof of an unrotated build', () => {
    // The runtime calls the field vestigial and the only real int4 pack we have carries HD=0 despite
    // being built rotated. Reading clear as "unrotated" would reject every existing int4 pack as stale.
    assert.equal(sigCompatible(sig({ q: '4', hd: 0 }), { orkQuant: '4' }), true);
    assert.equal(sigCompatible(sig({ q: '4', hd: 0 }), { orkQuant: '4', orkNoRot: '1' }), true);
  });

  test('an int8 pack is never judged on rotation', () => {
    assert.equal(sigCompatible(sig({ q: '8' }), { orkQuant: '8', orkNoRot: '1' }), true);
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
  test('accepts a well-formed current-version pack', () => {
    assert.equal(isOrkpackUsable(writePack(mktmp(), 'ok.orkpack')), true);
  });

  test('rejects a foreign magic', () => {
    assert.equal(isOrkpackUsable(writePack(mktmp(), 'bad.orkpack', { magic: 'NOTAPACK' })), false);
  });

  // v7/v8 were collapsed back into v6 upstream, so those numbers now denote a different layout.
  test('rejects any version but the current one', () => {
    const d = mktmp();
    for (const v of [1, 5, 7, 8]) {
      assert.equal(isOrkpackUsable(writePack(d, `v${v}.orkpack`, { version: v })), false, `v${v} must be refused`);
    }
  });

  test('rejects an index offset past EOF (truncated pack)', () => {
    assert.equal(isOrkpackUsable(writePack(mktmp(), 'trunc.orkpack', { indexOff: 1 << 20 })), false);
  });

  test('applies the precision signature when one is supplied', () => {
    const p = writePack(mktmp(), 'i4.orkpack', { quantSig: sig({ q: '4', hd: 1 }) });
    assert.equal(isOrkpackUsable(p, { orkQuant: '4' }), true);
    assert.equal(isOrkpackUsable(p, { orkQuant: '8' }), false);
    assert.equal(isOrkpackUsable(p, { orkQuant: '4', orkHybrid: '1' }), false);
    assert.equal(isOrkpackUsable(p), true, 'no precision → structural check only');
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
