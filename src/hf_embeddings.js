// Extract an Eagle-3 draft head's companion embedding table.
//
// EAGLE-3 heads share the *base* target model's `embed_tokens` (they ship none
// of their own — see AGENTS.md §10.6), so the Vulkan draft head needs an
// `embeddings.safetensors` holding just that tensor. The base model is chosen
// explicitly by the user (HF metadata doesn't record it and repo names aren't
// reliable), via either:
//   - fetchBaseEmbeddings  — range-download only the embed tensor from a base
//                            repo on HuggingFace (~778 MB vs a multi-GB model)
//   - extractLocalEmbeddings — slice it out of an already-downloaded base model
//
// Both write an identical single-tensor `embed_tokens.weight` safetensors that
// the native Vulkan draft head (`vk_eagle.hpp`) reads one row at a time.

import fs from 'fs';
import path from 'path';

const HF = 'https://huggingface.co';
const EMBED_SUFFIX = 'embed_tokens.weight';

// Build the output single-tensor safetensors header bytes (8-byte length prefix
// + JSON header, padded so the data section is 8-byte aligned).
function buildHeader(tensor, nbytes) {
  const out = { [EMBED_SUFFIX]: { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [0, nbytes] } };
  let json = JSON.stringify(out);
  const pad = (8 - ((8 + Buffer.byteLength(json, 'utf8')) % 8)) % 8;
  json += ' '.repeat(pad);
  const headerBuf = Buffer.from(json, 'utf8');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0);
  return Buffer.concat([lenBuf, headerBuf]);
}

// ── HTTP range slice from a base repo ──────────────────────────────────────

// Fetch with a byte Range, following HF's CDN redirect while re-applying the
// Range + auth headers. Requires a 206 (a 200 would be the whole multi-GB
// object) — refused otherwise.
async function rangeFetch(url, baseHeaders, start, end) {
  const headers = { ...baseHeaders, Range: `bytes=${start}-${end}` };
  let res = await fetch(url, { headers, redirect: 'manual' });
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 5) {
    res = await fetch(res.headers.get('location'), { headers, redirect: 'manual' });
  }
  if (res.status !== 206) throw new Error(`range request not honoured (HTTP ${res.status}) for ${url}`);
  return res;
}

async function rangeBuffer(url, headers, start, end) {
  return Buffer.from(await (await rangeFetch(url, headers, start, end)).arrayBuffer());
}

// Locate embed_tokens in a remote base repo: returns { shardUrl, tensor, dataStart }.
async function locateRemote(baseRepoId, headers) {
  const encoded = baseRepoId.split('/').map(encodeURIComponent).join('/');
  const base = `${HF}/${encoded}/resolve/main`;
  let shard = 'model.safetensors';
  const idxRes = await fetch(`${base}/model.safetensors.index.json`, { headers });
  if (idxRes.ok) {
    const index = await idxRes.json();
    const map = index.weight_map || {};
    const key = Object.keys(map).find(k => k.endsWith(EMBED_SUFFIX));
    if (!key) throw new Error('base model index has no embed_tokens.weight');
    shard = map[key];
  }
  const shardUrl = `${base}/${shard}`;
  const lenBuf = await rangeBuffer(shardUrl, headers, 0, 7);
  const hlen = Number(lenBuf.readBigUInt64LE(0));
  const hdr = JSON.parse((await rangeBuffer(shardUrl, headers, 8, 8 + hlen - 1)).toString('utf8'));
  const key = Object.keys(hdr).find(k => k.endsWith(EMBED_SUFFIX));
  if (!key) throw new Error('embed_tokens.weight not found in shard header');
  return { shardUrl, tensor: hdr[key], dataStart: 8 + hlen };
}

// Range-download only the embed tensor from a HuggingFace base repo into destPath.
export async function fetchBaseEmbeddings({ baseRepoId, destPath, hfToken, job }) {
  const headers = { 'User-Agent': 'oRKLLM/1.0' };
  if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

  const { shardUrl, tensor, dataStart } = await locateRemote(baseRepoId, headers);
  const [begin, end] = tensor.data_offsets;
  const nbytes = end - begin;
  if (job) { job.totalBytes = nbytes; job.bytesDown = 0; }

  const tmp = destPath + '.tmp';
  const out = fs.createWriteStream(tmp);
  out.write(buildHeader(tensor, nbytes));

  const res = await rangeFetch(shardUrl, headers, dataStart + begin, dataStart + end - 1);
  const reader = res.body.getReader();
  let lastCheck = Date.now(), bytesAtLast = 0;
  try {
    while (true) {
      if (job?.status === 'cancelled') { reader.cancel(); out.close(); fs.unlink(tmp, () => {}); return; }
      const { value, done } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      if (job) {
        job.bytesDown += value.length;
        const now = Date.now();
        if (now - lastCheck >= 500) {
          job.speedBps = Math.round((job.bytesDown - bytesAtLast) / ((now - lastCheck) / 1000));
          bytesAtLast = job.bytesDown; lastCheck = now;
        }
      }
    }
    await new Promise((res2, rej) => out.end(err => err ? rej(err) : res2()));
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ── Local slice from an already-downloaded base model ──────────────────────

function readLocalHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const hlen = Number(lenBuf.readBigUInt64LE(0));
    const hdr = Buffer.alloc(hlen);
    fs.readSync(fd, hdr, 0, hlen, 8);
    return { header: JSON.parse(hdr.toString('utf8')), dataStart: 8 + hlen };
  } finally { fs.closeSync(fd); }
}

// Find the shard file + tensor entry for embed_tokens in a local base-model dir.
function locateLocal(baseDir) {
  const indexPath = path.join(baseDir, 'model.safetensors.index.json');
  let shardFile;
  if (fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const map = index.weight_map || {};
    const key = Object.keys(map).find(k => k.endsWith(EMBED_SUFFIX));
    if (!key) throw new Error('base model index has no embed_tokens.weight');
    shardFile = path.join(baseDir, map[key]);
  } else {
    shardFile = path.join(baseDir, 'model.safetensors');
    if (!fs.existsSync(shardFile)) throw new Error('no model.safetensors / index in base dir');
  }
  const { header, dataStart } = readLocalHeader(shardFile);
  const key = Object.keys(header).find(k => k.endsWith(EMBED_SUFFIX));
  if (!key) throw new Error('embed_tokens.weight not found in shard header');
  return { shardFile, tensor: header[key], dataStart };
}

// Whether a local directory looks like it can supply embeddings.
export function localBaseHasEmbeddings(baseDir) {
  try { locateLocal(baseDir); return true; } catch { return false; }
}

// Extract the embed tensor from a locally-downloaded base model into destPath.
export async function extractLocalEmbeddings({ baseDir, destPath, job }) {
  const { shardFile, tensor, dataStart } = locateLocal(baseDir);
  const [begin, end] = tensor.data_offsets;
  const nbytes = end - begin;
  if (job) { job.totalBytes = nbytes; job.bytesDown = 0; }

  const tmp = destPath + '.tmp';
  const out = fs.createWriteStream(tmp);
  out.write(buildHeader(tensor, nbytes));

  const inFd = fs.openSync(shardFile, 'r');
  const CHUNK = 16 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let remaining = nbytes, srcPos = dataStart + begin;
  let lastCheck = Date.now(), bytesAtLast = 0;
  try {
    while (remaining > 0) {
      if (job?.status === 'cancelled') { out.close(); fs.unlink(tmp, () => {}); return; }
      const want = Math.min(CHUNK, remaining);
      const got = fs.readSync(inFd, buf, 0, want, srcPos);
      if (got <= 0) throw new Error('unexpected EOF reading base embedding data');
      out.write(Buffer.from(buf.subarray(0, got)));
      srcPos += got; remaining -= got;
      if (job) {
        job.bytesDown += got;
        const now = Date.now();
        if (now - lastCheck >= 500) {
          job.speedBps = Math.round((job.bytesDown - bytesAtLast) / ((now - lastCheck) / 1000));
          bytesAtLast = job.bytesDown; lastCheck = now;
        }
      }
    }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  } finally {
    fs.closeSync(inFd);
  }
}
