// Vulkan SPIR-V shader auto-fetch — the GPU-side counterpart to runtime_sync.js.
//
// Mirrors the RKLLM-runtime download model: pull the latest GitHub release from
// SPV_MIRRORS (default oRKLLM/llama.cpp), which attaches a
// `ggml-vulkan-spirv-<tag>.tar.gz` (all compiled `.spv` modules + manifest.json
// + ggml-vulkan-shaders.hpp + SHA256SUMS). We download the tarball, verify it
// against its `.sha256` sidecar, extract it into SPV_DIR, and record the tag.
// Once present, oRKLLM's Eagle-3 `vulkan` draft strategy can be enabled.
//
// SPIR-V is a portable IR (x86-built, runs on any Vulkan device), so there's no
// arch-specific artifact — but the Mali path only matters on the board, so we
// keep the same ARM64-Linux guard (a dev mac has no Mali to run them on).

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { SPV_DIR, SPV_MIRRORS } from './config.js';

const TAG_FILE = path.join(SPV_DIR, '.spv-tag');

function mirrorApi(slug) {
  return `https://api.github.com/repos/${slug}/releases`;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({ hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'oRKLLM' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({ hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'oRKLLM' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, dest, onProgress));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const stream = fs.createWriteStream(dest + '.tmp');
      res.on('data', chunk => { received += chunk.length; if (onProgress) onProgress(received, total); });
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); fs.renameSync(dest + '.tmp', dest); resolve(); });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

// Live progress — polled by the UI during a download.
const spvSyncState = { active: false, tag: null, filename: null, bytesDown: 0, totalBytes: 0 };
export function getSpvSyncState() { return { ...spvSyncState }; }

/** List the extracted .spv modules currently on disk. */
export function listSpvFiles() {
  try { return fs.readdirSync(SPV_DIR).filter(f => f.endsWith('.spv')); }
  catch { return []; }
}

/** True once the shader set is installed (≥1 .spv + a manifest). */
export function isSpvAvailable() {
  return listSpvFiles().length > 0 && fs.existsSync(path.join(SPV_DIR, 'manifest.json'));
}

/** The upstream build tag currently installed (e.g. 'b9596'), or null. */
export function installedSpvTag() {
  try { return fs.readFileSync(TAG_FILE, 'utf8').trim() || null; }
  catch { return null; }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const SPV_TARBALL_RE = /^ggml-vulkan-spirv-.*\.tar\.gz$/;
const spvTarball = (release) => release.assets?.find(a => SPV_TARBALL_RE.test(a.name) && !a.name.endsWith('.sha256'));

/**
 * Available shader releases from the first reachable mirror, newest-first,
 * for the Settings release picker. Returns [{ tag, name, size, publishedAt }].
 */
export async function getReleases() {
  for (const slug of SPV_MIRRORS) {
    try {
      const res = await httpsGet(mirrorApi(slug) + '?per_page=30');
      if (res.status !== 200) continue;
      const releases = JSON.parse(res.body.toString());
      const withTarball = (Array.isArray(releases) ? releases : []).filter(r => !r.draft && spvTarball(r));
      if (withTarball.length) {
        return withTarball.map(r => ({ tag: r.tag_name, name: r.name || r.tag_name, size: spvTarball(r)?.size ?? null, publishedAt: r.published_at }));
      }
    } catch { /* try next mirror */ }
  }
  return [];
}

/** Download a specific release tag (or the latest when null) and install it. */
export async function syncSpv(requestedTag = null) {
  const isARM64Linux = process.platform === 'linux' && process.arch === 'arm64';
  if (!isARM64Linux) {
    console.log('[SpvSync] Skipping — not ARM64 Linux (no Mali GPU to run the shaders)');
    return;
  }

  console.log(`[SpvSync] Fetching Vulkan SPIR-V shaders${requestedTag ? ` (${requestedTag})` : ' (latest)'} (mirrors: ${SPV_MIRRORS.join(', ')})...`);

  for (const slug of SPV_MIRRORS) {
    let releases;
    try {
      const res = await httpsGet(mirrorApi(slug) + '?per_page=30');
      if (res.status !== 200) { console.warn(`[SpvSync] Mirror ${slug}: HTTP ${res.status} — skipping`); continue; }
      releases = JSON.parse(res.body.toString());
    } catch (e) {
      console.warn(`[SpvSync] Mirror ${slug}: ${e.message} — skipping`);
      continue;
    }

    const release = Array.isArray(releases)
      ? (requestedTag ? releases.find(r => r.tag_name === requestedTag) : releases.find(r => !r.draft))
      : null;
    if (!release) continue;
    const tarball = spvTarball(release);
    if (!tarball) { console.warn(`[SpvSync] Mirror ${slug}: no spirv tarball in ${release.tag_name} — skipping`); continue; }

    const tag = release.tag_name;
    if (installedSpvTag() === tag && isSpvAvailable()) {
      console.log(`[SpvSync] Shaders ${tag} already present`);
      return;
    }

    const dest = path.join(SPV_DIR, tarball.name);
    console.log(`[SpvSync] Downloading ${tarball.name} (${tag}) from ${slug}...`);
    spvSyncState.active = true;
    spvSyncState.tag = tag;
    spvSyncState.filename = tarball.name;
    spvSyncState.bytesDown = 0;
    spvSyncState.totalBytes = tarball.size ?? 0;
    try {
      await downloadFile(tarball.browser_download_url, dest, (received, total) => {
        spvSyncState.bytesDown = received;
        if (total) spvSyncState.totalBytes = total;
      });

      // Verify against the .sha256 sidecar asset when available.
      const sumAsset = release.assets?.find(a => a.name === `${tarball.name}.sha256`);
      if (sumAsset) {
        const sumRes = await httpsGet(sumAsset.browser_download_url);
        const expected = sumRes.body.toString().trim().split(/\s+/)[0];
        const actual = sha256(dest);
        if (expected && expected !== actual) {
          throw new Error(`checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
        }
      }

      // Clear any previously-installed shaders so switching tags can't leave
      // stale modules behind, then extract the new set (tar is standard on the board).
      for (const f of listSpvFiles()) { try { fs.unlinkSync(path.join(SPV_DIR, f)); } catch {} }
      try { fs.unlinkSync(path.join(SPV_DIR, 'manifest.json')); } catch {}
      execFileSync('tar', ['-xzf', dest, '-C', SPV_DIR], { timeout: 30000 });
      fs.unlinkSync(dest);
      fs.writeFileSync(TAG_FILE, tag);
      console.log(`[SpvSync] Installed ${listSpvFiles().length} shader module(s) for ${tag}`);
      return;
    } catch (e) {
      console.error(`[SpvSync] Failed for ${tag} from ${slug}: ${e.message}`);
      try { fs.unlinkSync(dest + '.tmp'); } catch {}
      try { fs.unlinkSync(dest); } catch {}
    } finally {
      spvSyncState.active = false;
      spvSyncState.tag = null;
      spvSyncState.filename = null;
      spvSyncState.bytesDown = 0;
      spvSyncState.totalBytes = 0;
    }
  }
}
