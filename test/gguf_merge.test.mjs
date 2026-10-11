import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  shardPathsFor, consolidatedPathFor, readGgufLayout, consolidateSplitGguf,
  splitGroupReady, planMerge, readGgufHeaderFromBuffer,
} from '../src/gguf_merge.js';

// ── a minimal GGUF v3 writer, enough to build real split shards ────────────────────────────────────
const T = { UINT32: 4, STRING: 8, ARRAY: 9, UINT16: 2 };
const ALIGN = 32;
const alignUp = (n, a) => Math.ceil(n / a) * a;

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const gstr = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); };

const kvU32 = (k, v) => Buffer.concat([gstr(k), u32(T.UINT32), u32(v)]);
const kvU16 = (k, v) => Buffer.concat([gstr(k), u32(T.UINT16), u16(v)]);
const kvStr = (k, v) => Buffer.concat([gstr(k), u32(T.STRING), gstr(v)]);
// A string ARRAY — the shape that makes a naive re-serializer fall over, and the shape a real
// tokenizer vocab takes. Present so the splice path is exercised against a variable-length value.
const kvStrArr = (k, vs) => Buffer.concat([gstr(k), u32(T.ARRAY), u32(T.STRING), u64(vs.length), ...vs.map(gstr)]);

// tensors: [{ name, dims, type, bytes }]
function writeGguf(file, kvs, tensors) {
  let off = 0;
  const infos = [], datas = [];
  for (const t of tensors) {
    infos.push(Buffer.concat([gstr(t.name), u32(t.dims.length), ...t.dims.map(u64), u32(t.type), u64(off)]));
    datas.push({ at: off, buf: t.bytes });
    off = alignUp(off + t.bytes.length, ALIGN);
  }
  const header = Buffer.concat([
    u32(0x46554747), u32(3), u64(tensors.length), u64(kvs.length), ...kvs, ...infos,
  ]);
  const dataStart = alignUp(header.length, ALIGN);
  const out = Buffer.alloc(dataStart + off);
  header.copy(out, 0);
  for (const d of datas) d.buf.copy(out, dataStart + d.at);
  fs.writeFileSync(file, out);
  return { dataStart, dataLen: off };
}

const filler = (seed, n) => Buffer.from(Array.from({ length: n }, (_, i) => (seed * 31 + i * 7) & 0xff));

function makeSplit(dir, base, { total = 2 } = {}) {
  const vocab = ['<pad>', 'hello', 'world', 'ø', '▁the'];
  const common = [
    kvStr('general.architecture', 'llama'),
    kvStr('general.name', base),
    kvU32('llama.block_count', 4),
    kvStrArr('tokenizer.ggml.tokens', vocab),
    kvU16('some.u16', 9),
  ];
  const p = (i) => path.join(dir, `${base}-${String(i).padStart(5, '0')}-of-${String(total).padStart(5, '0')}.gguf`);

  writeGguf(p(1), [
    ...common,
    kvU16('split.no', 0), kvU32('split.count', total), kvU32('split.tensors.count', 5),
  ], [
    { name: 'blk.0.w', dims: [4, 3], type: 0, bytes: filler(1, 97) },   // deliberately unaligned sizes
    { name: 'blk.1.w', dims: [8],    type: 0, bytes: filler(2, 33) },
    { name: 'blk.2.w', dims: [2, 2], type: 0, bytes: filler(3, 64) },
  ]);
  writeGguf(p(2), [
    kvU16('split.no', 1), kvU32('split.count', total), kvU32('split.tensors.count', 5),
  ], [
    { name: 'blk.3.w',  dims: [5], type: 0, bytes: filler(4, 101) },
    { name: 'output.w', dims: [7], type: 0, bytes: filler(5, 15) },
  ]);
  return { first: p(1), all: Array.from({ length: total }, (_, i) => p(i + 1)) };
}

// Read a tensor's bytes back out of a merged file, via its recorded offset.
function tensorBytes(file, name, len) {
  const L = readGgufLayout(file);
  const t = L.tensors.find(x => x.name === name);
  assert.ok(t, `tensor ${name} present`);
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, L.dataStart + t.offset);
    return b;
  } finally { fs.closeSync(fd); }
}

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orkmerge-'));
const quiet = { log: () => {} };

describe('split-shard naming', () => {
  test('shardPathsFor enumerates every shard, in order', () => {
    assert.deepEqual(shardPathsFor('/m/a/foo-00001-of-00003.gguf'), [
      '/m/a/foo-00001-of-00003.gguf', '/m/a/foo-00002-of-00003.gguf', '/m/a/foo-00003-of-00003.gguf',
    ]);
  });

  test('a single-file model is not a split', () => {
    assert.equal(shardPathsFor('/m/a/foo.gguf'), null);
    assert.equal(shardPathsFor('/m/a/foo.orkpack'), null);
    assert.equal(shardPathsFor('/m/a/foo-00001-of-00001.gguf'), null);  // "1 of 1" is not split
  });

  test('consolidatedPathFor drops the suffix and is idempotent', () => {
    assert.equal(consolidatedPathFor('/m/a/foo-00001-of-00002.gguf'), '/m/a/foo.gguf');
    assert.equal(consolidatedPathFor('/m/a/foo.gguf'), '/m/a/foo.gguf');
  });
});

// Downloads are one job per FILE with no server-side "this variant is complete" event, and the queue
// does not survive a restart — so readiness has to be read off the disk.
describe('splitGroupReady', () => {
  test('false until every shard has landed', () => {
    const dir = mkdir();
    const { first, all } = makeSplit(dir, 'partial');
    assert.equal(splitGroupReady(first), true);
    fs.unlinkSync(all[1]);
    assert.equal(splitGroupReady(first), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('false while a shard is still transferring (<shard>.tmp present)', () => {
    const dir = mkdir();
    const { first, all } = makeSplit(dir, 'inflight');
    fs.writeFileSync(`${all[1]}.tmp`, 'partial');       // both transports write through .tmp
    assert.equal(splitGroupReady(first), false, 'an in-flight shard blocks the merge');
    fs.unlinkSync(`${all[1]}.tmp`);
    assert.equal(splitGroupReady(first), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('false for a zero-byte placeholder shard', () => {
    const dir = mkdir();
    const { first, all } = makeSplit(dir, 'empty');
    fs.writeFileSync(all[1], '');
    assert.equal(splitGroupReady(first), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('false for a model that is not split at all', () => {
    assert.equal(splitGroupReady('/m/a/solo.gguf'), false);
  });
});

describe('planMerge', () => {
  test('the synthesized header parses back as a well-formed GGUF before anything is written', async () => {
    const dir = mkdir();
    const { first } = makeSplit(dir, 'planned');
    const layouts = shardPathsFor(first).map(readGgufLayout);
    const plan = await planMerge(layouts);

    const h = readGgufHeaderFromBuffer(plan.header, plan.expectedSize);
    assert.equal(h.nTensors, 5);
    assert.equal(h.nKv, layouts[0].nKv - 3);
    assert.equal(h.dataStart, plan.headerPadded, 'declared data start matches the planned padding');
    assert.equal(h.kv.some(e => e.key.startsWith('split.')), false);
    // the trailing shard's tensors are rebased past shard 1's data, and nothing lands out of range
    assert.equal(plan.dataBases[0], 0);
    assert.ok(plan.dataBases[1] > 0);
    for (const t of h.tensors) assert.ok(t.offset < plan.dataLen);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('consolidateSplitGguf', () => {
  test('merges shards byte-faithfully and drops the split metadata', async () => {
    const dir = mkdir();
    const { first, all } = makeSplit(dir, 'model');
    const before = all.map(f => readGgufLayout(f));

    const res = await consolidateSplitGguf(first, quiet);
    assert.equal(res.status, 'consolidated');
    assert.equal(res.path, path.join(dir, 'model.gguf'));

    const L = readGgufLayout(res.path);
    assert.equal(L.nTensors, before[0].nTensors + before[1].nTensors);   // 3 + 2
    assert.deepEqual(L.tensors.map(t => t.name),
      ['blk.0.w', 'blk.1.w', 'blk.2.w', 'blk.3.w', 'output.w']);

    // the split keys are gone, and nothing else is
    assert.equal(L.kv.some(e => e.key.startsWith('split.')), false);
    assert.equal(L.nKv, before[0].nKv - 3);
    for (const k of ['general.architecture', 'general.name', 'llama.block_count',
                     'tokenizer.ggml.tokens', 'some.u16']) {
      assert.ok(L.kv.some(e => e.key === k), `${k} survived`);
    }

    // every tensor's BYTES survive, including the ones that moved shard
    assert.deepEqual(tensorBytes(res.path, 'blk.0.w', 97),  filler(1, 97));
    assert.deepEqual(tensorBytes(res.path, 'blk.2.w', 64),  filler(3, 64));
    assert.deepEqual(tensorBytes(res.path, 'blk.3.w', 101), filler(4, 101));
    assert.deepEqual(tensorBytes(res.path, 'output.w', 15), filler(5, 15));

    // every tensor lands inside the file and on the alignment the header declares
    for (const t of L.tensors) {
      assert.equal(t.offset % L.alignment, 0, `${t.name} aligned`);
      assert.ok(L.dataStart + t.offset < L.size, `${t.name} inside the file`);
    }

    // the sources are gone, and no temp survives
    for (const f of all) assert.equal(fs.existsSync(f), false, `${path.basename(f)} removed`);
    assert.deepEqual(fs.readdirSync(dir), ['model.gguf']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a 3-way split merges just as well', async () => {
    const dir = mkdir();
    const base = path.join(dir, 'tri');
    const mk = (i, tensors, kvs) => writeGguf(`${base}-0000${i}-of-00003.gguf`, kvs, tensors);
    mk(1, [{ name: 'a', dims: [3], type: 0, bytes: filler(7, 50) }],
          [kvStr('general.architecture', 'llama'), kvU16('split.no', 0), kvU32('split.count', 3)]);
    mk(2, [{ name: 'b', dims: [3], type: 0, bytes: filler(8, 51) }],
          [kvU16('split.no', 1), kvU32('split.count', 3)]);
    mk(3, [{ name: 'c', dims: [3], type: 0, bytes: filler(9, 52) }],
          [kvU16('split.no', 2), kvU32('split.count', 3)]);

    const res = await consolidateSplitGguf(`${base}-00001-of-00003.gguf`, quiet);
    assert.equal(res.status, 'consolidated');
    const L = readGgufLayout(res.path);
    assert.deepEqual(L.tensors.map(t => t.name), ['a', 'b', 'c']);
    assert.deepEqual(tensorBytes(res.path, 'c', 52), filler(9, 52));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a single-file model is a no-op, not an error', async () => {
    const dir = mkdir();
    const f = path.join(dir, 'solo.gguf');
    writeGguf(f, [kvStr('general.architecture', 'llama')], [{ name: 'x', dims: [1], type: 0, bytes: filler(1, 8) }]);
    const res = await consolidateSplitGguf(f, quiet);
    assert.equal(res.status, 'not-split');
    assert.equal(fs.existsSync(f), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('repeating the merge is idempotent — second call reports already-consolidated', async () => {
    const dir = mkdir();
    const { first } = makeSplit(dir, 'twice');
    const a = await consolidateSplitGguf(first, quiet);
    assert.equal(a.status, 'consolidated');
    const b = await consolidateSplitGguf(first, quiet);      // shards are gone; target is there
    assert.equal(b.status, 'already-consolidated');
    assert.equal(b.nTensors, 5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('concurrent triggers share one merge rather than racing the same output', async () => {
    const dir = mkdir();
    const { first } = makeSplit(dir, 'race');
    const [a, b, c] = await Promise.all([
      consolidateSplitGguf(first, quiet), consolidateSplitGguf(first, quiet), consolidateSplitGguf(first, quiet),
    ]);
    // all three resolve to the same outcome object — one merge actually ran
    assert.equal(a.status, 'consolidated');
    assert.equal(b, a);
    assert.equal(c, a);
    assert.equal(readGgufLayout(a.path).nTensors, 5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing shard refuses by name and touches nothing', async () => {
    const dir = mkdir();
    const { first, all } = makeSplit(dir, 'gappy');
    fs.unlinkSync(all[1]);
    await assert.rejects(() => consolidateSplitGguf(first, quiet),
      /shard gappy-00002-of-00002\.gguf is missing/);
    assert.equal(fs.existsSync(first), true, 'shard 1 untouched');
    assert.equal(fs.existsSync(path.join(dir, 'gappy.gguf')), false, 'no partial output');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a stale .merging.tmp from a killed run is discarded, not resumed', async () => {
    const dir = mkdir();
    const { first } = makeSplit(dir, 'stale');
    const tmp = path.join(dir, 'stale.gguf.merging.tmp');
    fs.writeFileSync(tmp, Buffer.alloc(4096, 0xab));          // junk from an interrupted run
    const res = await consolidateSplitGguf(first, quiet);
    assert.equal(res.status, 'consolidated');
    assert.equal(fs.existsSync(tmp), false);
    assert.deepEqual(readGgufLayout(res.path).tensors.map(t => t.name),
      ['blk.0.w', 'blk.1.w', 'blk.2.w', 'blk.3.w', 'output.w']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an unreadable file at the target name refuses rather than overwriting it', async () => {
    const dir = mkdir();
    const { first } = makeSplit(dir, 'occupied');
    fs.writeFileSync(path.join(dir, 'occupied.gguf'), Buffer.from('not a gguf'));
    await assert.rejects(() => consolidateSplitGguf(first, quiet), /is not a readable GGUF/);
    assert.equal(fs.existsSync(first), true, 'shards untouched');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('progress is reported against the real data total', async () => {
    const dir = mkdir();
    const { first } = makeSplit(dir, 'prog');
    const seen = [];
    const res = await consolidateSplitGguf(first, { ...quiet, onProgress: (p) => seen.push(p) });
    assert.ok(seen.length > 0, 'progress fired');
    const last = seen[seen.length - 1];
    assert.equal(last.copied, last.total, 'ends at 100%');
    assert.ok(last.total > 0);
    assert.equal(res.status, 'consolidated');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
