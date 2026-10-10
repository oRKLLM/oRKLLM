import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// MODELS_DIR is read from the environment when src/config.js is first imported, so the fixture dir has
// to exist and be exported before conversion.js is pulled in — hence the dynamic import below.
const MODELS = fs.mkdtempSync(path.join(os.tmpdir(), 'orkllm-conv-'));
process.env.ORKLLM_MODELS_DIR = MODELS;

const { ConversionScheduler } = await import('../src/conversion.js');

// ── Minimal GGUF writer: a header carrying only general.architecture is enough for the arch gate ──
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function gstr(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u64(b.length), b]);
}
function writeArchGguf(name, arch) {
  const kv = Buffer.concat([gstr('general.architecture'), u32(8 /* STRING */), gstr(arch)]);
  const p = path.join(MODELS, name);
  fs.writeFileSync(p, Buffer.concat([u32(0x46554747), u32(3), u64(0), u64(1), kv]));
  return name;
}

// enqueue() ends in _pump(); with no model loaded and no binary it is a no-op, but a loaded pool arms a
// retry timer that would keep the test runner alive. Disarm it after each call.
function enqueue(sched, rel) {
  sched.enqueue(rel);
  clearTimeout(sched._timer);
  sched._timer = null;
}

let sched;
before(() => { sched = new ConversionScheduler({ anyLoaded: false, queue: [] }); sched.binPath = null; });
after(() => { fs.rmSync(MODELS, { recursive: true, force: true }); });

describe('conversion arch gate', () => {
  // A Gated-Delta-Net hybrid is only PARTLY recurrent: its attention and FFN projections are ordinary
  // MUL_MATs and ggml-ork packs them (measured on RK3588 — Qwen3.5-0.8B packs 150 weights). Gating the
  // arch out made every user Quantize of a Qwen3.5/3.6/3.8 model fail with "cannot be packed".
  test('packs gated-delta-net hybrids (qwen35 and friends)', () => {
    for (const arch of ['qwen35', 'qwen35moe', 'qwen3next', 'granitehybrid']) {
      const rel = writeArchGguf(`${arch}.gguf`, arch);
      enqueue(sched, rel);
      assert.ok(sched.queued.has(rel), `${arch} should be queued for conversion`);
    }
  });

  // A DFlash draft head is the one arch with genuinely no pack of its own: it runs co-resident with its
  // target via run_dflash and is never loaded standalone.
  test('skips a DFlash draft head', () => {
    const rel = writeArchGguf('dflash.gguf', 'dflash');
    enqueue(sched, rel);
    assert.ok(!sched.queued.has(rel), 'dflash must not be queued');
  });

  test('quantize() refuses only the arch that has no pack', async () => {
    const dflash = writeArchGguf('q-dflash.gguf', 'dflash');
    const hybrid = writeArchGguf('q-qwen35.gguf', 'qwen35');
    sched.binPath = path.join(MODELS, 'no-such-llama-completion');   // past the binary check, nothing to spawn
    try {
      assert.match((await sched.quantize(dflash)).error, /no standalone \.orkpack/);
      // The hybrid gets all the way to the spawn and fails there for want of a binary — the point is
      // that it is NOT rejected on its architecture.
      assert.match((await sched.quantize(hybrid)).error, /produced no \.orkpack/);
    } finally { sched.binPath = null; }
  });
});
