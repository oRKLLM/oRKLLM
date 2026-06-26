import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the DB at a throwaway file BEFORE importing db.js / embeddings_store.js
// (db.js opens the DB at import time and runs migrations, including v7).
const tempDbPath = path.join(os.tmpdir(), `orkllm-embstore-db-${Date.now()}.db`);
process.env.ORKLLM_DB_PATH = tempDbPath;

const {
  hashEmbeddingsFile,
  ingestToStore,
  storePathForHash,
  storeDir,
  linkDraftToStore,
  registerDraftEmbeddings,
  releaseDraftEmbeddings,
  migrateExistingEmbeddings,
} = await import('../src/embeddings_store.js');
const {
  dbGetEmbedding,
  dbGetDraftEmbedding,
  dbEmbeddingRefcount,
  dbListEmbeddings,
  dbResetForTesting,
} = await import('../src/db.js');

// ── Minimal single-tensor embed_tokens.weight safetensors writer ──────────────
// 8-byte LE header length + JSON header (8-aligned) + raw data. `fill` seeds the
// data bytes so two files with the same fill have identical tensor DATA (→ same
// content hash) regardless of any header cosmetics.
function writeEmbeddings(file, { shape, dtype, nbytes, fill = 0 }) {
  const out = { 'model.embed_tokens.weight': { dtype, shape, data_offsets: [0, nbytes] } };
  let json = JSON.stringify(out);
  json += ' '.repeat((8 - ((8 + Buffer.byteLength(json)) % 8)) % 8);
  const hdr = Buffer.from(json);
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(hdr.length));
  const data = Buffer.alloc(nbytes);
  for (let i = 0; i < nbytes; i++) data[i] = (i + fill) & 0xff;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, hdr, data]));
}

function tmpModels() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orkllm-embstore-'));
}

const META = { shape: [248320, 2048], dtype: 'BF16', nbytes: 512 };

describe('embeddings content-addressed store', () => {
  before(() => dbResetForTesting());
  after(() => { try { fs.unlinkSync(tempDbPath); } catch {} });

  test('hash dedup: two identical tables → one store file, distinct data → two', () => {
    dbResetForTesting();
    const models = tmpModels();
    const a = path.join(models, 'A', 'embeddings.safetensors');
    const b = path.join(models, 'B', 'embeddings.safetensors');
    const c = path.join(models, 'C', 'embeddings.safetensors');
    writeEmbeddings(a, { ...META, fill: 0 });
    writeEmbeddings(b, { ...META, fill: 0 });   // byte-identical DATA to A
    writeEmbeddings(c, { ...META, fill: 7 });   // different DATA

    // Identical DATA → identical hash even though they are separate files.
    assert.equal(hashEmbeddingsFile(a), hashEmbeddingsFile(b));
    assert.notEqual(hashEmbeddingsFile(a), hashEmbeddingsFile(c));

    const ra = ingestToStore(models, a);
    const rb = ingestToStore(models, b);   // should dedup onto A's store file
    const rc = ingestToStore(models, c);
    assert.equal(ra.hash, rb.hash);
    assert.equal(rb.deduped, true);
    assert.equal(rc.deduped, false);

    const files = fs.readdirSync(storeDir(models)).filter(n => /\.safetensors$/.test(n));
    assert.equal(files.length, 2);   // A/B collapsed to one, C is the second
    fs.rmSync(models, { recursive: true, force: true });
  });

  test('registry insert + refcount + symlink read-through', () => {
    dbResetForTesting();
    const models = tmpModels();
    // Two drafts of the SAME target → identical table.
    writeEmbeddings(path.join(models, 'Qwen', 'eagle3-A', 'embeddings.safetensors'), { ...META, fill: 1 });
    writeEmbeddings(path.join(models, 'Qwen', 'dflash-B', 'embeddings.safetensors'), { ...META, fill: 1 });

    const ra = registerDraftEmbeddings(models, 'Qwen/eagle3-A', path.join(models, 'Qwen', 'eagle3-A', 'embeddings.safetensors'), { source: 'extract' });
    const rb = registerDraftEmbeddings(models, 'Qwen/dflash-B', path.join(models, 'Qwen', 'dflash-B', 'embeddings.safetensors'), { source: 'reuse' });

    assert.equal(ra.hash, rb.hash);                       // same content → same store file
    assert.equal(rb.deduped, true);
    assert.equal(dbEmbeddingRefcount(ra.hash), 2);        // both drafts reference it
    assert.equal(dbGetDraftEmbedding('Qwen/eagle3-A'), ra.hash);

    const reg = dbGetEmbedding(ra.hash);
    assert.deepEqual(reg.shape, META.shape);
    assert.equal(reg.dtype, 'BF16');
    assert.equal(reg.nbytes, META.nbytes);

    // Each draft now holds a SYMLINK that opens transparently as the table.
    for (const d of ['Qwen/eagle3-A', 'Qwen/dflash-B']) {
      const link = path.join(models, d, 'embeddings.safetensors');
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.existsSync(link), true);            // existsSync follows the link → reads as present
      assert.deepEqual(fs.readFileSync(link), fs.readFileSync(storePathForHash(models, ra.hash)));
    }
    assert.equal(dbListEmbeddings().length, 1);
    fs.rmSync(models, { recursive: true, force: true });
  });

  test('GC: 0-ref deletion frees the store file; shared table is protected', () => {
    dbResetForTesting();
    const models = tmpModels();
    writeEmbeddings(path.join(models, 'Qwen', 'A', 'embeddings.safetensors'), { ...META, fill: 2 });
    writeEmbeddings(path.join(models, 'Qwen', 'B', 'embeddings.safetensors'), { ...META, fill: 2 });
    const ra = registerDraftEmbeddings(models, 'Qwen/A', path.join(models, 'Qwen', 'A', 'embeddings.safetensors'));
    registerDraftEmbeddings(models, 'Qwen/B', path.join(models, 'Qwen', 'B', 'embeddings.safetensors'));
    const hash = ra.hash;
    const storeFile = storePathForHash(models, hash);
    assert.equal(dbEmbeddingRefcount(hash), 2);

    // Delete draft A → still referenced by B → store file PROTECTED.
    const r1 = releaseDraftEmbeddings(models, 'Qwen/A');
    assert.equal(r1.freedHash, null);
    assert.equal(fs.existsSync(storeFile), true);
    assert.equal(dbEmbeddingRefcount(hash), 1);
    assert.equal(dbGetEmbedding(hash) !== null, true);

    // Delete draft B → 0 refs → store file + registry row removed.
    const r2 = releaseDraftEmbeddings(models, 'Qwen/B');
    assert.equal(r2.freedHash, hash);
    assert.equal(fs.existsSync(storeFile), false);
    assert.equal(dbGetEmbedding(hash), null);

    // Releasing a draft with no registered embeddings is a no-op.
    assert.deepEqual(releaseDraftEmbeddings(models, 'Qwen/none'), { freedHash: null });
    fs.rmSync(models, { recursive: true, force: true });
  });

  test('migration: existing per-draft files → store + symlink, idempotent + dedup', () => {
    dbResetForTesting();
    const models = tmpModels();
    // Pre-store layout: two drafts of one target (identical table) + the DFlash
    // file the prompt describes, plus a distinct table.
    writeEmbeddings(path.join(models, 'Qwen', 'eagle3-A', 'embeddings.safetensors'), { ...META, fill: 3 });
    writeEmbeddings(path.join(models, 'Qwen', 'dflash-B', 'embeddings.safetensors'), { ...META, fill: 3 });
    writeEmbeddings(path.join(models, 'z-lab', 'Qwen3.6-35B-A3B-DFlash', 'embeddings.safetensors'), { shape: [151936, 2048], dtype: 'BF16', nbytes: 256, fill: 9 });

    const s1 = migrateExistingEmbeddings(models);
    assert.equal(s1.scanned, 3);
    assert.equal(s1.migrated, 3);
    assert.equal(s1.deduped, 1);          // dflash-B collapses onto eagle3-A
    assert.equal(s1.storeFiles, 2);       // two distinct tables in the store

    // Every former real file is now a symlink that still reads as present.
    for (const d of ['Qwen/eagle3-A', 'Qwen/dflash-B', 'z-lab/Qwen3.6-35B-A3B-DFlash']) {
      const f = path.join(models, d, 'embeddings.safetensors');
      assert.equal(fs.lstatSync(f).isSymbolicLink(), true);
      assert.equal(fs.existsSync(f), true);
      assert.notEqual(dbGetDraftEmbedding(d), null);
    }
    // The two same-target drafts share one store hash; refcount = 2.
    const shared = dbGetDraftEmbedding('Qwen/eagle3-A');
    assert.equal(dbGetDraftEmbedding('Qwen/dflash-B'), shared);
    assert.equal(dbEmbeddingRefcount(shared), 2);

    // Re-running is idempotent: nothing re-migrated, store unchanged.
    const s2 = migrateExistingEmbeddings(models);
    assert.equal(s2.migrated, 0);
    assert.equal(s2.alreadyLinked, 3);
    assert.equal(s2.storeFiles, 2);
    fs.rmSync(models, { recursive: true, force: true });
  });

  test('linkDraftToStore replaces a pre-existing real file atomically', () => {
    dbResetForTesting();
    const models = tmpModels();
    const draft = path.join(models, 'D');
    const src = path.join(draft, 'embeddings.safetensors');
    writeEmbeddings(src, { ...META, fill: 5 });
    const { hash } = ingestToStore(models, src, { keepSource: true });
    // src is still a real file here; linkDraftToStore must replace it with a link.
    const link = linkDraftToStore(models, draft, hash);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(fs.readFileSync(link), fs.readFileSync(storePathForHash(models, hash)));
    fs.rmSync(models, { recursive: true, force: true });
  });
});
