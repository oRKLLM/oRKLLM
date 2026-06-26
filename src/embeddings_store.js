// Content-addressed common store for draft `embed_tokens` tables.
//
// Every draft head (EAGLE-3 / DFlash) of the SAME target carries a byte-identical
// `embed_tokens.weight` table (vocab × hidden_size, e.g. BF16 [248320,2048]). The
// a036021 reuse feature deduped these by hardlink/copy between draft dirs; this
// module centralizes them into one store so every draft of a target shares a
// single physical file, keyed by the sha256 of the tensor DATA:
//
//   <MODELS_DIR>/.embeddings/<sha256-of-tensor-data>.safetensors
//
// Each store file IS the single-tensor safetensors (8-byte length prefix + JSON
// header + raw data — exactly what hf_embeddings.js writes). A draft references
// its table via `<draftDir>/embeddings.safetensors` as a SYMLINK into the store,
// so the native runtime (`vk_eagle.hpp`) and the `/library` scan open it
// transparently with no path change. The SQLite `embeddings` / `draft_embeddings`
// tables (db.js, migration v7) track metadata + refcounts for GC.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readEmbeddingsMeta } from './hf_embeddings.js';
import {
  dbUpsertEmbedding,
  dbSetDraftEmbedding,
  dbDeleteDraftEmbedding,
  dbEmbeddingRefcount,
  dbDeleteEmbedding,
} from './db.js';

const STORE_SUBDIR = '.embeddings';
const EMBED_FILE = 'embeddings.safetensors';

export function storeDir(modelsDir) {
  return path.join(modelsDir, STORE_SUBDIR);
}

export function storePathForHash(modelsDir, hash) {
  return path.join(storeDir(modelsDir), `${hash}.safetensors`);
}

// Read a single-tensor safetensors' header + data-section bounds without slurping
// the (multi-hundred-MB) body. Returns { dataStart, dataEnd } byte offsets.
function readDataBounds(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const hlen = Number(lenBuf.readBigUInt64LE(0));
    const hdr = Buffer.alloc(hlen);
    fs.readSync(fd, hdr, 0, hlen, 8);
    const header = JSON.parse(hdr.toString('utf8'));
    const key = Object.keys(header).find(k => k.endsWith('embed_tokens.weight'));
    if (!key) throw new Error('embed_tokens.weight not found in header');
    const [begin, end] = header[key].data_offsets;
    return { dataStart: 8 + hlen + begin, dataEnd: 8 + hlen + end };
  } finally {
    fs.closeSync(fd);
  }
}

// sha256 of just the tensor DATA bytes of an embeddings safetensors file. Keying
// on data (not the whole file) means two tables with identical weights but
// cosmetically different headers still dedup to one store entry.
export function hashEmbeddingsFile(file) {
  const { dataStart, dataEnd } = readDataBounds(file);
  const fd = fs.openSync(file, 'r');
  try {
    const h = crypto.createHash('sha256');
    const CHUNK = 16 * 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let pos = dataStart;
    while (pos < dataEnd) {
      const want = Math.min(CHUNK, dataEnd - pos);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) throw new Error('unexpected EOF hashing embeddings data');
      h.update(buf.subarray(0, got));
      pos += got;
    }
    return h.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

// Is `p` already a symlink whose target is the given store file?
function isSymlinkTo(p, target) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
    const resolved = path.resolve(path.dirname(p), fs.readlinkSync(p));
    return path.resolve(resolved) === path.resolve(target);
  } catch { return false; }
}

// Point `<draftDir>/embeddings.safetensors` at the store file as a symlink.
// Relative target (so the models tree stays relocatable). Atomic via tmp+rename.
// Removes any pre-existing file/symlink at the destination first.
export function linkDraftToStore(modelsDir, draftDir, hash) {
  const dst = path.join(draftDir, EMBED_FILE);
  const storePath = storePathForHash(modelsDir, hash);
  if (isSymlinkTo(dst, storePath)) return dst;          // already correct
  const rel = path.relative(path.dirname(dst), storePath);
  const tmp = dst + '.lnk.tmp';
  try { fs.rmSync(tmp, { force: true }); } catch {}
  fs.symlinkSync(rel, tmp);
  fs.renameSync(tmp, dst);                               // atomically replaces dst
  return dst;
}

// Move/dedup a real embeddings file INTO the store (by content hash), returning
// { hash, storePath, deduped }. The source file is consumed (renamed in) unless
// `keepSource` is set, in which case it is copied. Verified by re-hashing the
// landed store copy before the source is removed (so a partial write never loses
// data). Idempotent: an identical hash already present is reused as-is.
export function ingestToStore(modelsDir, srcFile, { keepSource = false } = {}) {
  const hash = hashEmbeddingsFile(srcFile);
  const dir = storeDir(modelsDir);
  fs.mkdirSync(dir, { recursive: true });
  const storePath = storePathForHash(modelsDir, hash);

  if (fs.existsSync(storePath)) {
    // Already in the store — just drop the (now-redundant) source if we own it.
    if (!keepSource) { try { fs.rmSync(srcFile, { force: true }); } catch {} }
    return { hash, storePath, deduped: true };
  }

  // Land the bytes at a tmp path in the store dir, verify, then rename into place.
  const tmp = storePath + '.tmp';
  try { fs.rmSync(tmp, { force: true }); } catch {}
  // Try a same-filesystem hardlink first (instant, no extra copy); fall back to a
  // stream copy across filesystems.
  let copied = false;
  try { fs.linkSync(srcFile, tmp); }
  catch { fs.copyFileSync(srcFile, tmp); copied = true; }
  // Verify the landed copy hashes to the expected key before committing.
  const check = hashEmbeddingsFile(tmp);
  if (check !== hash) { try { fs.rmSync(tmp, { force: true }); } catch {} throw new Error(`store hash mismatch landing ${srcFile}`); }
  fs.renameSync(tmp, storePath);
  if (!keepSource) { try { fs.rmSync(srcFile, { force: true }); } catch {} }
  return { hash, storePath, deduped: false, copied };
}

// Full linkage: ingest a freshly-produced embeddings file into the store, record
// it + the draft's reference in the DB, and replace the draft's file with a
// symlink. `draftRel` is the draft dir relative to MODELS_DIR (the registry key).
// Returns { hash, storePath, deduped }.
export function registerDraftEmbeddings(modelsDir, draftRel, producedFile, { source = null } = {}) {
  const meta = readEmbeddingsMeta(producedFile);
  if (!meta) throw new Error(`produced file has no embed_tokens.weight: ${producedFile}`);
  const { hash, storePath, deduped } = ingestToStore(modelsDir, producedFile, { keepSource: false });
  dbUpsertEmbedding({ hash, shape: meta.shape, dtype: meta.dtype, nbytes: meta.nbytes, source });
  dbSetDraftEmbedding(draftRel, hash);
  linkDraftToStore(modelsDir, path.join(modelsDir, draftRel), hash);
  return { hash, storePath, deduped };
}

// GC on draft deletion: drop the draft's DB reference and, if the store table it
// pointed at is now unreferenced, delete the store file + its registry row.
// `draftRel` is relative to MODELS_DIR. Safe to call even if the draft had no
// registered embeddings. Returns { freedHash } when a store file was removed.
export function releaseDraftEmbeddings(modelsDir, draftRel) {
  const hash = dbDeleteDraftEmbedding(draftRel);
  if (!hash) return { freedHash: null };
  if (dbEmbeddingRefcount(hash) > 0) return { freedHash: null };  // still shared — keep it
  try { fs.rmSync(storePathForHash(modelsDir, hash), { force: true }); } catch {}
  dbDeleteEmbedding(hash);
  return { freedHash: hash };
}

// One-time migration: walk MODELS_DIR for draft dirs holding a REAL (non-symlink)
// embeddings.safetensors, hash + dedup each into the store, register it, and
// replace the per-draft file with a symlink. Idempotent (a draft already pointing
// at a symlink is skipped/registered without touching the file). Returns a
// summary { scanned, migrated, deduped, storeFiles }.
export function migrateExistingEmbeddings(modelsDir) {
  const summary = { scanned: 0, migrated: 0, deduped: 0, alreadyLinked: 0, errors: 0 };
  if (!fs.existsSync(modelsDir)) return summary;

  (function walk(dir, rel = '', depth = 0) {
    if (depth > 4) return;
    if (rel === STORE_SUBDIR) return;                   // never recurse into the store itself
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1); continue; }
      if (e.name !== EMBED_FILE) continue;
      const file = path.join(dir, e.name);
      summary.scanned++;
      try {
        let lst = fs.lstatSync(file);
        if (lst.isSymbolicLink()) {
          // Already a symlink — make sure it's registered (e.g. DB reset). Resolve
          // the target hash from the link name if it points into the store.
          const tgt = path.resolve(dir, fs.readlinkSync(file));
          const m = /([0-9a-f]{64})\.safetensors$/.exec(path.basename(tgt));
          if (m && fs.existsSync(tgt)) {
            const meta = readEmbeddingsMeta(tgt);
            if (meta) { dbUpsertEmbedding({ hash: m[1], shape: meta.shape, dtype: meta.dtype, nbytes: meta.nbytes, source: 'migrate' }); dbSetDraftEmbedding(rel, m[1]); }
          }
          summary.alreadyLinked++;
          continue;
        }
        const meta = readEmbeddingsMeta(file);
        if (!meta) continue;                            // not a valid embed table — leave it alone
        const { hash, deduped } = ingestToStore(modelsDir, file, { keepSource: false });
        dbUpsertEmbedding({ hash, shape: meta.shape, dtype: meta.dtype, nbytes: meta.nbytes, source: 'migrate' });
        dbSetDraftEmbedding(rel, hash);
        linkDraftToStore(modelsDir, dir, hash);
        summary.migrated++;
        if (deduped) summary.deduped++;
      } catch (err) {
        summary.errors++;
        console.error(`[Embeddings] migrate ${rel}/${e.name} failed: ${err.message}`);
      }
    }
  })(modelsDir);

  try { summary.storeFiles = fs.readdirSync(storeDir(modelsDir)).filter(n => /\.safetensors$/.test(n)).length; }
  catch { summary.storeFiles = 0; }
  return summary;
}
