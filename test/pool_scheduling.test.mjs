import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolated DB so importing the pool never touches a real install.
process.env.ORKLLM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orkllm-pool-')), 'orkllm.db');
const { pool, workerEnv } = await import('../src/pool.js');

const PACK = 'unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.orkpack';
const RKLLM = 'x/model.rkllm';

class FakeWorker extends EventEmitter {
  constructor() { super(); this.sent = []; this.connected = true; }
  send(m) { this.sent.push(m); }
}
function slot(id, { model = null, backend = 'llama', busy = false } = {}) {
  return { id, worker: model ? new FakeWorker() : null, activeModel: model ? { name: model, backend, options: {} } : null,
           isLoaded: !!model, loadingPromise: null, loadingModel: null, activeGeneration: busy ? new Promise(() => {}) : null, idleTimer: null };
}

describe('pool scheduling: one ggml-ork worker on the NPU', () => {
  before(() => { pool.idleTimeoutMs = 0; });

  test('a llama request never spills onto a second slot while the holder is busy', () => {
    pool._slots = [slot(0, { model: PACK, busy: true }), slot(1)];
    assert.equal(pool._pickIdleSlot(PACK), null);
  });

  test('it takes the holder once idle', () => {
    pool._slots = [slot(0, { model: PACK }), slot(1)];
    assert.equal(pool._pickIdleSlot(PACK).id, 0);
  });

  test('a slot that is still loading is not handed a second request', () => {
    const s0 = slot(0, { model: PACK }); s0.loadingPromise = new Promise(() => {}); s0.loadingModel = PACK;
    pool._slots = [s0, slot(1)];
    assert.equal(pool._pickIdleSlot(PACK), null);
  });

  test('rkllm models keep the multi-slot behaviour', () => {
    pool._slots = [slot(0, { model: RKLLM, backend: 'rkllm', busy: true }), slot(1)];
    assert.equal(pool._pickIdleSlot(RKLLM).id, 1);
  });

  test('aborting a QUEUED request removes it and rejects, without touching the running one', async () => {
    const s0 = slot(0, { model: PACK, busy: true });
    pool._slots = [s0, slot(1)];
    pool.queue = [];
    const ac = new AbortController();
    const p = pool.generate(PACK, 'p', {}, () => {}, {}, { signal: ac.signal });
    assert.equal(pool.queue.length, 1);
    ac.abort();
    await assert.rejects(p, /aborted while queued/);
    assert.equal(pool.queue.length, 0);
    assert.deepEqual(s0.worker.sent, []);
  });

  test('aborting a DISPATCHED request sends abort to its own worker only', async () => {
    const s0 = slot(0, { model: PACK });
    const s1 = slot(1, { model: RKLLM, backend: 'rkllm', busy: true });
    pool._slots = [s0, s1];
    pool.queue = [];
    const origLoad = pool.load; pool.load = async () => ({ status: 0 });
    try {
      const ac = new AbortController();
      const p = pool.generate(PACK, 'p', {}, () => {}, {}, { signal: ac.signal });
      await new Promise(r => setImmediate(r));
      assert.equal(s0.worker.sent[0].type, 'run');
      ac.abort();
      assert.equal(s0.worker.sent.at(-1).type, 'abort');
      assert.deepEqual(s1.worker.sent, []);
      s0.worker.emit('message', { type: 'token', state: 3, text: '' });
      await p;
      assert.equal(s0.activeGeneration, null);
      assert.equal(s0.idleTimer, null);
    } finally { pool.load = origLoad; }
  });
  test('a run that ends in state 3 WITHOUT an abort is a failure, not an empty success', async () => {
    const s0 = slot(0, { model: PACK });
    pool._slots = [s0];
    pool.queue = [];
    const origLoad = pool.load; pool.load = async () => ({ status: 0 });
    try {
      const p = pool.generate(PACK, 'p', {}, () => {}, {});
      await new Promise(r => setImmediate(r));
      assert.equal(s0.worker.sent[0].type, 'run');
      s0.worker.emit('message', { type: 'token', state: 3, text: '' });   // e.g. llama_decode failed
      await assert.rejects(p, /inference backend/);
      assert.equal(s0.activeGeneration, null);
    } finally { pool.load = origLoad; }
  });

  test('state 3 after a pool-wide abort still resolves (aborted, not failed)', async () => {
    const s0 = slot(0, { model: PACK });
    pool._slots = [s0];
    pool.queue = [];
    const origLoad = pool.load; pool.load = async () => ({ status: 0 });
    try {
      const p = pool.generate(PACK, 'p', {}, () => {}, {});
      await new Promise(r => setImmediate(r));
      await pool.abort();
      assert.equal(s0.worker.sent.at(-1).type, 'abort');
      s0.worker.emit('message', { type: 'token', state: 3, text: '' });
      await p;
    } finally { pool.load = origLoad; }
  });
});

describe('worker environment', () => {
  test('ggml-ork group fusion is off by default (its fused/per-tensor wcache key collision leaks NPU IOVA per request)', () => {
    const saved = { nf: process.env.ORK_NO_FUSE, of: process.env.ORKLLM_ORK_FUSE };
    try {
      delete process.env.ORK_NO_FUSE; delete process.env.ORKLLM_ORK_FUSE;
      assert.equal(workerEnv().ORK_NO_FUSE, '1');
      process.env.ORKLLM_ORK_FUSE = '1';
      assert.equal('ORK_NO_FUSE' in workerEnv(), false);
    } finally {
      if (saved.nf === undefined) delete process.env.ORK_NO_FUSE; else process.env.ORK_NO_FUSE = saved.nf;
      if (saved.of === undefined) delete process.env.ORKLLM_ORK_FUSE; else process.env.ORKLLM_ORK_FUSE = saved.of;
    }
  });
});
