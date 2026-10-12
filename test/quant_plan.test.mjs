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
