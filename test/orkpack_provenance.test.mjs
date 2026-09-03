// .orkpack provenance sidecar — the pg_dump-header equivalent for a packed-weight cache.
// A pack is a hardware-specific artifact whose footer says nothing about the machine that built it,
// so we stamp that beside it at generation time. These tests pin down that the record is written, is
// readable, and that the mismatch check stays ADVISORY — it must never turn "no record" into "wrong".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeOrkpackProvenance, readOrkpackProvenance, provenanceChipsetMismatch, provPathFor } from '../src/orkpack.js';
import { getPlatform } from '../src/config.js';

function tmpPack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkprov-'));
  const pack = path.join(dir, 'model.orkpack');
  fs.writeFileSync(pack, Buffer.alloc(64));   // not a valid pack; provenance must not depend on that
  return pack;
}

test('records the machine, the OS, the runtime and the source at generation time', () => {
  const pack = tmpPack();
  const rec = writeOrkpackProvenance(pack, {
    source: { rel: 'Qwen3-1.7B-GGUF/Qwen3-1.7B-UD-Q4_K_XL.gguf', bytes: 1234, mtimeMs: 5678 },
    build: { orkQuant: '4', orkHybrid: null, packArgs: ['--pack-bits', '4'], label: 'pass 1 of 2' },
    orkDriver: '1.0.99 (W4A4)',
  });
  assert.ok(rec, 'a record is returned');
  const back = readOrkpackProvenance(pack);
  assert.deepEqual(back, rec, 'what was written reads back identically');

  assert.equal(back.producer, 'oRKLLM');
  assert.equal(back.hardware.chipset, getPlatform() ?? null, 'chipset comes from the kernel, not the caller');
  assert.equal(back.system.kernel, os.release());
  assert.equal(back.runtime.orkDriver, '1.0.99 (W4A4)', 'the driver version the build itself printed');
  assert.equal(back.build.orkQuant, '4');
  assert.equal(back.source.rel, 'Qwen3-1.7B-GGUF/Qwen3-1.7B-UD-Q4_K_XL.gguf');
  assert.ok(Date.parse(back.createdAt) > 0, 'createdAt is a real timestamp');
});

test('a pack with no sidecar reads as null, not as an error', () => {
  const pack = tmpPack();
  assert.equal(readOrkpackProvenance(pack), null);
});

test('an unknown schema is ignored rather than half-trusted', () => {
  const pack = tmpPack();
  writeOrkpackProvenance(pack, {});
  const rec = JSON.parse(fs.readFileSync(provPathFor(pack), 'utf8'));
  fs.writeFileSync(provPathFor(pack), JSON.stringify({ ...rec, schema: 99 }));
  assert.equal(readOrkpackProvenance(pack), null);
});

test('mismatch is UNKNOWN when there is no record — absence is never evidence of wrongness', () => {
  // The load path must not reject a pack built by a bare llama-completion run outside oRKLLM.
  assert.equal(provenanceChipsetMismatch(tmpPack()), null);
});

test('mismatch is UNKNOWN when the local chipset is undetectable', () => {
  const pack = tmpPack();
  const rec = writeOrkpackProvenance(pack, {});
  fs.writeFileSync(provPathFor(pack), JSON.stringify({ ...rec, hardware: { ...rec.hardware, chipset: 'rk3576' } }));
  const got = provenanceChipsetMismatch(pack);
  if (getPlatform() === null) assert.equal(got, null, 'no local chipset → no verdict');
  else if (getPlatform() === 'rk3576') assert.equal(got, false);
  else assert.deepEqual(got, { builtFor: 'rk3576', running: getPlatform() });
});

test('a recorded chipset that differs from this board is reported with both sides', () => {
  const pack = tmpPack();
  const rec = writeOrkpackProvenance(pack, {});
  // Force both sides so the assertion holds on a board and on a dev machine alike.
  fs.writeFileSync(provPathFor(pack), JSON.stringify({ ...rec, hardware: { ...rec.hardware, chipset: 'rk3576' } }));
  const here = getPlatform();
  const got = provenanceChipsetMismatch(pack);
  if (here === null) {
    assert.equal(got, null);
  } else if (here === 'rk3576') {
    assert.equal(got, false, 'same chip is an explicit match, not a mismatch');
  } else {
    assert.deepEqual(got, { builtFor: 'rk3576', running: here });
  }
});

test('provenance survives a pack too short to carry a footer', () => {
  // The sidecar is written after a build; if the footer read fails the record must still exist,
  // because the machine/OS/runtime facts are exactly what a later reader needs in order to diagnose
  // a truncated or half-written pack.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkprov-'));
  const pack = path.join(dir, 'truncated.orkpack');
  fs.writeFileSync(pack, Buffer.alloc(8));            // < FOOTER_SIZE (32) — unparseable
  const rec = writeOrkpackProvenance(pack, {});
  assert.equal(rec.footer, null, 'no footer to report');
  assert.ok(readOrkpackProvenance(pack), 'record is present regardless');
});
