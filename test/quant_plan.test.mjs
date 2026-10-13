// Unit tests for the bits-per-weight pack-size arithmetic behind the Quantization tab.
//
// They build GGUF and .orkpack files byte by byte, so the readers are tested against the real
// layouts rather than a mock, and the projection is checked against the measured 27B anchors
// (24.4 B packed params ~ 11.34 GiB at 4.0 bpw, ~22.69 GiB at 8.0, plus ~5.6 GiB carried).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeGguf, f16 } from './fixtures/gguf.mjs';
import { readGgufTensors } from '../src/gguf.js';
import {
  projectFromGguf, bytesAtBpw, readOrkpackIndex, measureFromPack, budgetMbForBpw, packMaxN,
  bpwDelivery, bpwDeliveryMessage, packQuantLabel, modelDisplayName, clearPackLabelCache,
} from '../src/quant_plan.js';

const GiB = 1073741824;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkllm-quantplan-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const gguf = writeGguf;

test('readGgufTensors sizes tensors from their offsets, no type table', () => {
  const f = path.join(tmp, 'shapes.gguf');
  gguf(f, [
    { name: 'blk.0.attn_q.weight', ...f16([256, 256]) },
    { name: 'blk.0.ffn_down.weight', ...f16([512, 256]) },
    { name: 'output_norm.weight', ...f16([256]) },
  ]);
  const g = readGgufTensors(f);
  assert.equal(g.tensors.length, 3);
  const q = g.tensors.find(t => t.name.endsWith('attn_q.weight'));
  assert.equal(q.elements, 65536);
  assert.equal(q.bytes, 131072);
  assert.equal(q.bits, 16);
  assert.equal(readGgufTensors(path.join(tmp, 'nope.gguf')), null);
});

test('a non-GGUF file yields no plan rather than throwing', () => {
  const f = path.join(tmp, 'fake.gguf');
  fs.writeFileSync(f, 'fake-gguf-data');
  assert.equal(projectFromGguf(f), null);
});

test('the packed set is derived from shape and width, not from a tensor-name list', () => {
  const f = path.join(tmp, 'derive.gguf');
  const maxN = packMaxN();
  gguf(f, [
    { name: 'token_embd.weight',      ...f16([512, 1024]) },   // gather, never a matmul
    { name: 'output.weight',          ...f16([512, maxN * 2]) }, // excluded by the N-cap ALONE
    { name: 'blk.0.attn_q.weight',    ...f16([512, 512]) },
    { name: 'blk.0.ffn_down.weight',  ...f16([1024, 512]) },
    { name: 'blk.0.attn_norm.weight', ...f16([512]) },
    { name: 'blk.0.attn_q.bias',      ...f16([512]) },
  ]);
  const p = projectFromGguf(f);
  assert.equal(p.nSlider, 2);
  assert.equal(p.sliderParams, 512 * 512 + 1024 * 512);
  // token_embd + output + norm + bias are all carried, at their own source bytes.
  assert.equal(p.carriedBytes, (512 * 1024 + 512 * maxN * 2 + 512 + 512) * 2);

  // THE N-CAP IS A POLICY, NOT A NAME LIST. Raise it and output.weight joins the packed set with no
  // code change here — which is the whole point of deriving membership.
  const prev = process.env.ORK_MAXN;
  process.env.ORK_MAXN = String(maxN * 4);
  const raised = projectFromGguf(f);
  delete process.env.ORK_MAXN;
  if (prev !== undefined) process.env.ORK_MAXN = prev;
  assert.equal(raised.nSlider, 3);
  assert.equal(raised.sliderParams, p.sliderParams + 512 * maxN * 2);
});

test('a tied-embedding model has no separate head, so token_embd is NPU-eligible', () => {
  const maxN = packMaxN();
  const untied = path.join(tmp, 'untied.gguf');
  const tied = path.join(tmp, 'tied.gguf');
  // Same names, same shapes; the one difference is whether a separate output.weight exists. That is
  // the test llama.cpp itself applies to decide tying, so the projection applies it too rather than
  // keying on the name alone — in a tied model token_embd IS the LM-head matmul.
  const embd = { name: 'token_embd.weight', ...f16([512, 1024]) };
  const blk  = { name: 'blk.0.attn_q.weight', ...f16([512, 512]) };
  gguf(untied, [embd, blk, { name: 'output.weight', ...f16([512, 1024]) }]);
  gguf(tied,   [embd, blk]);

  const prev = process.env.ORK_MAXN;
  process.env.ORK_MAXN = String(maxN * 4);          // a cap that admits a 1024-wide head
  const u = projectFromGguf(untied);
  const t = projectFromGguf(tied);
  if (prev === undefined) delete process.env.ORK_MAXN; else process.env.ORK_MAXN = prev;

  assert.equal(u.tied, false);
  assert.equal(u.nSlider, 2);                        // attn_q + output.weight; token_embd carried
  assert.equal(t.tied, true);
  assert.equal(t.nSlider, 2);                        // attn_q + token_embd serving as the head
  assert.equal(t.sliderParams, 512 * 512 + 512 * 1024);
});

test('a sub-5-bit source tensor is carried, not packed (ggml-ork refuses it)', () => {
  const f = path.join(tmp, 'q4.gguf');
  gguf(f, [
    // 4.5 bits/elem — a Q4_K-shaped weight. supports_op routes it to CPU and never packs it.
    { name: 'blk.0.ffn_up.weight', dims: [512, 512], bytes: Math.ceil(512 * 512 * 4.5 / 8) },
    { name: 'blk.0.attn_q.weight', ...f16([512, 512]) },
  ]);
  const p = projectFromGguf(f);
  assert.equal(p.nSlider, 1);
  assert.equal(p.sliderParams, 512 * 512);
});

test('MoE expert stacks are packed but not slider-governed', () => {
  const f = path.join(tmp, 'moe.gguf');
  gguf(f, [
    { name: 'blk.0.ffn_gate_exps.weight', ...f16([512, 512, 8]) },
    { name: 'blk.0.attn_q.weight',        ...f16([512, 512]) },
  ]);
  const p = projectFromGguf(f);
  assert.equal(p.moe, true);
  assert.equal(p.nMoe, 1);
  assert.equal(p.moeParams, 512 * 512 * 8);
  assert.equal(p.sliderParams, 512 * 512);
  // The expert stack stays at the auto profile's NF4 tier whatever the slider says.
  assert.equal(bytesAtBpw(p, 4).moeBytes, bytesAtBpw(p, 8).moeBytes);
});

test('bytesAtBpw reproduces the measured 27B anchors', () => {
  // Measured on the 27B: 24.4 B packed params, ~11.34 GiB of blobs at 4.0 bpw and ~22.69 GiB at
  // 8.0, plus ~5.6 GiB of carried (unpacked) content.
  const plan = { sliderParams: 24.4e9, moeParams: 0, carriedBytes: 5.6 * GiB, headerBytes: 0 };
  assert.ok(Math.abs(bytesAtBpw(plan, 4).weightBytes / GiB - 11.34) < 0.05);
  assert.ok(Math.abs(bytesAtBpw(plan, 8).weightBytes / GiB - 22.69) < 0.05);
  assert.ok(Math.abs(bytesAtBpw(plan, 4).totalBytes / GiB - 16.94) < 0.05);
  // The slider moves exactly the weight term and nothing else.
  assert.equal(bytesAtBpw(plan, 4).carriedBytes, bytesAtBpw(plan, 8).carriedBytes);
  assert.equal(bytesAtBpw(plan, 8).weightBytes - bytesAtBpw(plan, 4).weightBytes,
               24.4e9 * 4 / 8);
});

// ── .orkpack writer: blobs, then {u64 meta_off, u64 meta_size} + entries, then the v7 footer ──
function orkpack(file, entries, { carried = 4096 } = {}) {
  const blobs = [];
  let off = 0;
  const recs = entries.map(e => {
    const blobSize = e.bpw === 8 ? e.K * e.N : e.K * e.N / 2;
    const bfSize = e.bf ? e.K * e.N : 0;
    const r = { ...e, blobOff: off, blobSize, bfSize };
    blobs.push(Buffer.alloc(blobSize + bfSize));
    off += blobSize + bfSize;
    return r;
  });
  const meta = Buffer.alloc(carried);                 // stands in for the embedded GGUF content
  const metaOff = off; off += carried;
  const idx = [Buffer.alloc(16)];
  idx[0].writeBigUInt64LE(BigInt(metaOff), 0);
  idx[0].writeBigUInt64LE(BigInt(carried), 8);
  for (const r of recs) {
    const nm = Buffer.from(r.name, 'utf8');
    const nl = Buffer.alloc(4); nl.writeUInt32LE(nm.length);
    const e = Buffer.alloc(56);
    e.writeUInt32LE(r.K, 0); e.writeUInt32LE(r.N, 4);
    e.writeUInt32LE(r.bpw === 8 ? 1 : 5, 8); e.writeUInt32LE(0, 12);   // dtype, bscale_n
    e.writeBigUInt64LE(BigInt(r.blobOff), 16);
    e.writeBigUInt64LE(BigInt(r.blobSize), 24);
    e.writeBigUInt64LE(0n, 32);
    e.writeBigUInt64LE(BigInt(r.bfSize), 40);
    e.writeFloatLE(r.qerr ?? 0, 48); e.writeUInt32LE(0, 52);
    idx.push(nl, nm, e);
  }
  const index = Buffer.concat(idx);
  const indexOff = off;
  const footer = Buffer.alloc(64);
  footer.writeBigUInt64LE(BigInt(indexOff), 0);
  footer.writeUInt32LE(recs.length, 8);
  footer.writeUInt32LE(7, 12);                        // version — readOrkpackFooter keys on this
  footer.write('ORKPK01\0', 56, 'latin1');
  fs.writeFileSync(file, Buffer.concat([...blobs, meta, index, footer]));
  return { indexOff, metaOff };
}

test('readOrkpackIndex / measureFromPack read a real pack layout', () => {
  const f = path.join(tmp, 'uniform.orkpack');
  orkpack(f, [
    { name: 'blk.0.attn_q.weight',   K: 512,  N: 512, bpw: 4, qerr: 0.20 },
    { name: 'blk.0.ffn_down.weight', K: 1024, N: 512, bpw: 4, qerr: 0.18 },
  ], { carried: 8192 });
  const ix = readOrkpackIndex(f);
  assert.equal(ix.entries.length, 2);
  assert.equal(ix.entries[1].K, 1024);
  assert.ok(Math.abs(ix.entries[0].qerr - 0.20) < 1e-4);

  const m = measureFromPack(f);
  assert.equal(m.source, 'pack');
  assert.equal(m.sliderParams, 512 * 512 + 1024 * 512);
  assert.equal(m.currentBpw, 4);                      // a uniform int4 pack IS 4.0 bpw
  assert.ok(m.carriedBytes >= 8192);                  // meta + index + footer
});

test('a promoted pack measures above 4 bpw, from the file alone', () => {
  const f = path.join(tmp, 'mixed.orkpack');
  orkpack(f, [
    { name: 'a', K: 1024, N: 512, bpw: 8, qerr: 0.3 },   // promoted
    { name: 'b', K: 1024, N: 512, bpw: 4, qerr: 0.1 },
    { name: 'c', K: 1024, N: 512, bpw: 4, qerr: 0.1 },
    { name: 'd', K: 1024, N: 512, bpw: 4, qerr: 0.1 },
  ]);
  assert.equal(measureFromPack(f).currentBpw, 5);        // one of four at 8, three at 4
});

test('budgetMbForBpw replays the packer greedy loop, Bf included', () => {
  const f = path.join(tmp, 'rank.orkpack');
  // K=1024 is inside the Bf envelope (K%512==0 && K<=4096): promoting one costs 3x its blob delta.
  // K=6144 is outside it: cost is the blob delta alone.
  orkpack(f, [
    { name: 'inside',  K: 1024, N: 1024, bpw: 4, qerr: 0.30 },
    { name: 'outside', K: 6144, N: 1024, bpw: 4, qerr: 0.20 },
    { name: 'low',     K: 1024, N: 1024, bpw: 4, qerr: 0.01 },
  ]);
  const MiB = 1048576;
  assert.equal(budgetMbForBpw(f, 4.0), 0);

  // Worst qerr first: 'inside' alone. Its blob delta is 0.5 MiB and its Bf another 1 MiB, so a
  // budget derived from the bpw delta alone (0.5 MiB) would buy NOTHING — the 3x is the point.
  const total = 1024 * 1024 + 6144 * 1024 + 1024 * 1024;
  const wantOne = 4 + (4 * (1024 * 1024)) / total;      // bpw once 'inside' is promoted
  const b1 = budgetMbForBpw(f, wantOne);
  assert.ok(Math.abs(b1 - (1024 * 1024 / 2 + 1024 * 1024) / MiB) < 1e-4);

  // Reaching 'outside' too adds only its blob delta.
  const wantTwo = 4 + (4 * (1024 * 1024 + 6144 * 1024)) / total;
  const b2 = budgetMbForBpw(f, wantTwo);
  assert.ok(Math.abs(b2 - (1024 * 1024 * 1.5 + 6144 * 1024 / 2) / MiB) < 1e-4);

  // 'low' sits under --pack-qerr-min, so full 8.0 bpw is unreachable and the budget stops where the
  // ranking does rather than inventing headroom.
  assert.ok(Math.abs(budgetMbForBpw(f, 8.0) - b2) < 1e-4);
  assert.equal(budgetMbForBpw(path.join(tmp, 'nope.orkpack'), 6), null);
});

// The insurance check. The bpw -> --pack-budget translation replays the packer's CURRENT promotion
// loop, and the packer may change it. One way it can change is silent, so the finished pack is
// measured and compared against what was asked for.
test('bpwDelivery separates a wrong number from a CONFIDENT wrong number', () => {
  // Granularity: promotion moves whole weights, so a small gap is the arithmetic working.
  assert.equal(bpwDelivery(4.75, 4.75).status, 'ok');
  assert.equal(bpwDelivery(4.75, 4.70).status, 'ok');
  assert.equal(bpwDelivery(4.75, 4.82).status, 'ok');

  // IGNORED — the pack sits exactly at the base tier though more was asked for. That is the
  // signature of the budget being read by nothing (ggml-ork's exclusive explicit-list clause), and
  // it is the case that is otherwise silent, so it gets its own status and its own diagnosis.
  const ignored = bpwDelivery(4.75, 4.0);
  assert.equal(ignored.status, 'ignored');
  assert.match(bpwDeliveryMessage('m.gguf', ignored), /nothing was promoted/);
  assert.match(bpwDeliveryMessage('m.gguf', ignored), /pack-promote/);

  // DRIFTED — promotion happened, just not the amount the budget was computed to buy.
  const drifted = bpwDelivery(4.75, 5.60);
  assert.equal(drifted.status, 'drifted');
  assert.match(bpwDeliveryMessage('m.gguf', drifted), /promotion ran but stopped somewhere else/);
  // Overshoot reads as plainly as undershoot — the error is not one-directional.
  assert.match(bpwDeliveryMessage('m.gguf', drifted), /\+0\.85/);

  // Both numbers and the model name are always in the line, so a conversion log reads as-is.
  for (const d of [bpwDelivery(4.75, 4.75), ignored, drifted]) {
    const line = bpwDeliveryMessage('qwen3-1.7b.gguf', d);
    assert.match(line, /qwen3-1\.7b\.gguf/);
    assert.match(line, /4\.75/);
  }

  // Degrades quietly: an unmeasurable pack and a build with no bpw asked for are both non-events.
  assert.equal(bpwDelivery(4.75, 0).status, 'unknown');
  assert.equal(bpwDelivery(NaN, 4.0).status, 'unrequested');
  assert.match(bpwDeliveryMessage('m.gguf', bpwDelivery(NaN, 4.0)), /pack is 4\.00 bpw/);
});

test('bpwDelivery reads the rate off a real pack, whatever selected it', () => {
  // measureFromPack is blob bits over packed params — it knows nothing about ordering or tiers,
  // which is the property that makes it survive a change of promotion scheme.
  const f = path.join(tmp, 'delivered.orkpack');
  orkpack(f, [
    { name: 'a', K: 1024, N: 512, bpw: 8 },
    { name: 'b', K: 1024, N: 512, bpw: 4 },
    { name: 'c', K: 1024, N: 512, bpw: 4 },
    { name: 'd', K: 1024, N: 512, bpw: 4 },
  ]);
  const delivered = measureFromPack(f).currentBpw;
  assert.equal(delivered, 5);
  assert.equal(bpwDelivery(5.0, delivered).status, 'ok');
  assert.equal(bpwDelivery(4.0, delivered).status, 'drifted');   // asked for none, got a promotion

  // A uniform pack against a raised request is the IGNORED signature, end to end from a real file.
  const uniform = path.join(tmp, 'delivered-uniform.orkpack');
  orkpack(uniform, [{ name: 'a', K: 1024, N: 512, bpw: 4 }, { name: 'b', K: 1024, N: 512, bpw: 4 }]);
  assert.equal(bpwDelivery(4.75, measureFromPack(uniform).currentBpw).status, 'ignored');
});

// ── the label a pack wears in the UI ─────────────────────────────────────────
// The complaint these answer: a pack built from a bf16 source is called `…-BF16.orkpack` and the
// Models page echoed that, naming the artifact after the material. The file keeps its name (it is a
// lookup key); the LABEL is measured off the pack itself.

// 40 equal weights, 9 of them promoted to int8: 4 + 4*(9/40) = 4.9 bpw — the owner's example.
function pack49(file) {
  const entries = [];
  for (let i = 0; i < 40; i++) {
    entries.push({ name: `blk.${i}.ffn_down.weight`, K: 1024, N: 512, bpw: i < 9 ? 8 : 4 });
  }
  orkpack(file, entries);
  return file;
}

test('a pack is labelled for the quantization it IS, not the source it came from', () => {
  const dir = path.join(tmp, 'unsloth', 'Qwen3.8-27B-GGUF');
  fs.mkdirSync(dir, { recursive: true });
  const f = pack49(path.join(dir, 'Qwen3.8-27B-BF16.orkpack'));

  assert.ok(Math.abs(measureFromPack(f).currentBpw - 4.9) < 1e-9);
  assert.equal(packQuantLabel(f), '4.9bpw');
  assert.equal(modelDisplayName('unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-BF16.orkpack', f),
               'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-4.9bpw.orkpack');
});

test('a uniform pack reads as a round rate, with no spurious decimal', () => {
  const f4 = path.join(tmp, 'u4.orkpack');
  orkpack(f4, [{ name: 'a', K: 1024, N: 512, bpw: 4 }, { name: 'b', K: 1024, N: 512, bpw: 4 }]);
  assert.equal(packQuantLabel(f4), '4bpw');
  const f8 = path.join(tmp, 'u8.orkpack');
  orkpack(f8, [{ name: 'a', K: 1024, N: 512, bpw: 8 }]);
  assert.equal(packQuantLabel(f8), '8bpw');
});

test('a split model still keeps ONE label once its pack lands', () => {
  // The shard suffix goes first (ggufDisplayName), so the base identity survives BOTH the shard
  // strip and the relabel — the regression 411b416 fixed must not come back through this door.
  const dir = path.join(tmp, 'split');
  fs.mkdirSync(dir, { recursive: true });
  const f = pack49(path.join(dir, 'Qwen3.8-27B-BF16-00001-of-00002.orkpack'));
  assert.equal(modelDisplayName('split/Qwen3.8-27B-BF16-00001-of-00002.orkpack', f),
               'split/Qwen3.8-27B-4.9bpw.orkpack');
});

test('a name we cannot parse is added to, never cut', () => {
  const f = pack49(path.join(tmp, 'mystery-model.orkpack'));
  assert.equal(modelDisplayName('mystery-model.orkpack', f), 'mystery-model-4.9bpw.orkpack');
});

test('an absent, empty or unreadable pack leaves the name exactly as it was', () => {
  // Enumeration runs while packs are being built and deleted; none of these may throw.
  assert.equal(modelDisplayName('a/Qwen3-1.7B-BF16.orkpack', path.join(tmp, 'nope.orkpack')),
               'a/Qwen3-1.7B-BF16.orkpack');
  const empty = path.join(tmp, 'empty.orkpack');
  fs.writeFileSync(empty, '');
  assert.equal(modelDisplayName('a/Qwen3-1.7B-BF16.orkpack', empty), 'a/Qwen3-1.7B-BF16.orkpack');
  const junk = path.join(tmp, 'junk.orkpack');
  fs.writeFileSync(junk, Buffer.alloc(4096, 0x5a));         // not a pack: no magic at EOF
  assert.equal(packQuantLabel(junk), null);
  assert.equal(modelDisplayName('a/Qwen3-1.7B-BF16.orkpack', junk), 'a/Qwen3-1.7B-BF16.orkpack');
});

test('a .gguf is never relabelled — it IS its source precision', () => {
  const g = path.join(tmp, 'Qwen3-1.7B-BF16.gguf');
  gguf(g, [{ name: 'blk.0.attn_q.weight', ...f16([512, 512]) }]);
  assert.equal(modelDisplayName('Qwen3-1.7B-BF16.gguf', g), 'Qwen3-1.7B-BF16.gguf');
  // …including a split one, where the shard strip is still the whole job.
  assert.equal(modelDisplayName('Qwen3-1.7B-BF16-00001-of-00002.gguf', g), 'Qwen3-1.7B-BF16.gguf');
});

test('an unwalkable index falls back to the TIER, never to a guessed number', () => {
  // A footer that parses with an index we cannot walk (index_off=0 here; in the field a truncated
  // or mid-checkpoint tail). The tier is still known — it is in the footer's build signature — and
  // a vague truth beats a fabricated 4.9.
  const f = path.join(tmp, 'opaque.orkpack');
  const footer = Buffer.alloc(64);
  footer.writeBigUInt64LE(0n, 0);        // index_off: nothing to walk
  footer.writeUInt32LE(1, 8);            // n_entries
  footer.writeUInt32LE(7, 12);           // version — readOrkpackFooter keys on this
  footer.writeUInt32LE(0x34, 20);        // quant_sig: '4' => the int4 tier
  footer.write('ORKPK01\0', 56, 'latin1');
  fs.writeFileSync(f, Buffer.concat([Buffer.alloc(4096), footer]));
  assert.equal(packQuantLabel(f), 'int4');
  assert.equal(modelDisplayName('x/Qwen3-1.7B-BF16.orkpack', f), 'x/Qwen3-1.7B-int4.orkpack');

  footer.writeUInt32LE(0x38, 20);        // '8' => the int8 tier
  fs.writeFileSync(f, Buffer.concat([Buffer.alloc(4096), footer]));
  clearPackLabelCache();
  assert.equal(packQuantLabel(f), 'int8');

  // quant_sig 0 is "no precision was forced", NOT int8. The adopt gate has to pick one and picks
  // 8; a LABEL does not have to, so it says nothing rather than asserting a tier over what may be
  // an NF4 int4 pack.
  footer.writeUInt32LE(0, 20);
  fs.writeFileSync(f, Buffer.concat([Buffer.alloc(4096), footer]));
  clearPackLabelCache();
  assert.equal(packQuantLabel(f), null);
  assert.equal(modelDisplayName('x/Qwen3-1.7B-BF16.orkpack', f), 'x/Qwen3-1.7B-BF16.orkpack');
});

test('the label is memoised per file, and a rebuild moves it', () => {
  const f = path.join(tmp, 'rebuilt.orkpack');
  orkpack(f, [{ name: 'a', K: 1024, N: 512, bpw: 4 }, { name: 'b', K: 1024, N: 512, bpw: 4 }]);
  assert.equal(packQuantLabel(f), '4bpw');
  // Unlink the file under the cache: a second call must go back to the filesystem, not answer from
  // a stale entry. (This is also what guarantees enumeration cannot keep a deleted pack alive.)
  fs.unlinkSync(f);
  assert.equal(packQuantLabel(f), null);
  // Rebuilt at a different rate — the (mtime, size) key changes, so the label follows.
  orkpack(f, [{ name: 'a', K: 1024, N: 512, bpw: 8 }, { name: 'b', K: 1024, N: 512, bpw: 8 }]);
  assert.equal(packQuantLabel(f), '8bpw');
});
