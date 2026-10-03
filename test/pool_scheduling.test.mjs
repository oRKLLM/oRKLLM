import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolated DB so importing the pool never touches a real install.
process.env.ORKLLM_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orkllm-pool-')), 'orkllm.db');
const { pool } = await import('../src/pool.js');

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
});
