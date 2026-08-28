import fs from 'fs';
import path from 'path';
import https from 'https';
import zlib from 'zlib';
import crypto from 'crypto';
import { LLAMA_RUNTIME_DIR, LLAMA_RUNTIME_MIRRORS } from './config.js';
import { getConversionScheduler } from './conversion.js';

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

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({ hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'oRKLLM' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadBuffer(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), total: res.headers['content-length'] ? parseInt(res.headers['content-length']) : 0 }));
    }).on('error', reject);
  });
}

// Minimal tar extractor — supports ustar/POSIX pax (file entries only, no symlinks)
function extractTarGz(tarGzBuf, destDir) {
  const tar = zlib.gunzipSync(tarGzBuf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.slice(off, off + 512);
    if (header.every(b => b === 0)) break;
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*/, '');
    const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0.*/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    off += 512;
    if ((typeFlag === '0' || typeFlag === '\0') && name && size > 0) {
      const baseName = path.basename(name);
      const dest = path.join(destDir, baseName);
      fs.writeFileSync(dest, tar.slice(off, off + size));
      // Honor the tar header's execute bit so bundled BINARIES are runnable, not just .so libs — the
      // .orkpack conversion scheduler spawns the bundled `llama-completion`, which needs +x. (Mode is
      // the octal field at header offset 100.) Keep the .so fallback for archives without a mode set.
      const mode = parseInt(header.slice(100, 108).toString('utf8').replace(/\0.*/, '').trim(), 8) || 0;
      if ((mode & 0o111) || baseName.endsWith('.so') || baseName.includes('.so.')) fs.chmodSync(dest, 0o755);
    } else if (typeFlag === '2' && name) {
      // Symlink entry (e.g. libllama.so -> libllama.so.0 -> libllama.so.0.0.X).
      // We extract flat, so point the link at the target's basename in this dir.
      // Skipping these left the unversioned libllama.so stale — the addon dlopens
      // exactly that name, so the link MUST be (re)created to pick up a new lib.
      const linkTarget = path.basename(header.slice(157, 257).toString('utf8').replace(/\0.*/, ''));
      const dest = path.join(destDir, path.basename(name));
      if (linkTarget) {
        try { fs.rmSync(dest, { force: true }); } catch {}
        try { fs.symlinkSync(linkTarget, dest); } catch (e) { console.warn(`[LlamaSync] symlink ${dest} -> ${linkTarget} failed: ${e.message}`); }
      }
    }
    off += Math.ceil(size / 512) * 512;
  }
}

const syncState = {
  active: false,
  tag: null,
  bytesDown: 0,
  totalBytes: 0,
};

export function getLlamaSyncState() {
  return { ...syncState };
}

export function isLlamaRuntimeAvailable() {
  try {
    return fs.existsSync(path.join(LLAMA_RUNTIME_DIR, 'libllama.so'));
  } catch { return false; }
}

export function getLlamaRuntimeInfo() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(LLAMA_RUNTIME_DIR, 'manifest.json'), 'utf8'));
    return {
      available: isLlamaRuntimeAvailable(),
      path: LLAMA_RUNTIME_DIR,
      ...manifest,
      // Normalize the version fields the UI reads — the manifest may name them
      // llamaCommit/orkDriverCommit (or omit them), so map to llamaVersion/
      // orkDriverVersion with the build tag as the friendly llama.cpp fallback.
      llamaVersion:    manifest.llamaVersion    ?? manifest.llamaCommit    ?? manifest.tag ?? null,
      orkDriverVersion: manifest.orkDriverVersion ?? manifest.orkDriverCommit ?? null,
    };
  } catch {
    return { available: isLlamaRuntimeAvailable(), path: LLAMA_RUNTIME_DIR };
  }
}

// Parse the upstream llama.cpp build number from an `-ork` tag (e.g. "b9724-ork" →
// 9724). Tags track upstream build numbers, so a higher number = newer code — the
// reliable "latest" signal. Asset/publish timestamps are NOT: the fork's CI rebuilds
// the whole tag range concurrently and the uploads finish out of order.
function tagBuildNum(tag) {
  const m = /b(\d+)/.exec(String(tag || ''));
  return m ? parseInt(m[1], 10) : -1;
}

// The mirror publishes TWO kinds of release under the SAME bNNNN build number:
//   • bNNNN-ork — our NPU runtime bundle, asset `llama-cpp-rockchip-npu-bNNNN-ork.tar.gz`
//                 (the CI job uploads exactly `llama-cpp-rockchip-npu-*.tar.gz`)
//   • bNNNN     — a mirror of the corresponding UPSTREAM llama.cpp release, whose assets include
//                 `llama-bNNNN-bin-ubuntu-arm64.tar.gz`, `…-android-arm64.tar.gz`, `…-macos-x64…`
// Both end in .tar.gz and both parse to the same tagBuildNum, so selecting on the extension alone left
// the tie to GitHub's array order — and the upstream one carries no ggml-ork backend at all (its first
// .tar.gz is an Android build). Today the -ork releases happen to sort first because they are published
// later; that is luck, not a rule. Select the asset by NAME instead, so the two can never be confused.
const ORK_ASSET_RE = /^llama-cpp-rockchip-npu-.*\.tar\.gz$/i;

// The runtime-bundle asset of a release, or null when this release has none (i.e. it is an upstream
// mirror release, not one of ours).
export function orkAsset(release) {
  return release?.assets?.find(a => ORK_ASSET_RE.test(a.name)) ?? null;
}

// Pick the release to install from a GitHub releases page. Pure — exported for unit tests.
// With `tag`, that exact tag (and only if it actually carries a runtime bundle). Without, the highest
// tag build number: NOT releases[0] / publish order, which is unreliable because the fork's CI rebuilds
// the whole tag window concurrently and the uploads finish out of order.
export function pickLlamaRelease(releases, tag = null) {
  const ours = (releases ?? []).filter(r => orkAsset(r));
  if (tag) return ours.find(r => r.tag_name === tag) ?? null;
  return ours.sort((a, b) => tagBuildNum(b.tag_name) - tagBuildNum(a.tag_name))[0] ?? null;
}

export async function getLlamaReleases() {
  const isARM64Linux = process.platform === 'linux' && process.arch === 'arm64';
  if (!isARM64Linux) return [];

  for (const slug of LLAMA_RUNTIME_MIRRORS) {
    try {
      // llama.cpp pushes builds constantly, so only surface the newest handful for
      // the picker — ordered by tag build number (highest = latest code), NOT by
      // GitHub's array/publish order, which is unreliable when concurrent CI builds
      // upload out of order. syncLlamaRuntime fetches a wider window, so any listed
      // tag still resolves.
      // Wide page: the upstream mirror releases share this listing, so a page sized to the number we
      // want to SHOW could come back with too few of ours after filtering.
      const res = await httpsGet(mirrorApi(slug) + '?per_page=60');
      if (res.status !== 200) continue;
      const releases = JSON.parse(res.body.toString());
      return releases
        .map(r => ({ r, asset: orkAsset(r) }))
        .filter(({ asset }) => asset)
        .map(({ r, asset }) => ({ tag: r.tag_name, publishedAt: r.published_at,
                                  assetDigest: asset.digest ?? null, assetSize: asset.size ?? null }))
        .sort((a, b) => tagBuildNum(b.tag) - tagBuildNum(a.tag))
        .slice(0, 10);
    } catch { /* try next */ }
  }
  return [];
}

export async function syncLlamaRuntime(tag = null, { force = false } = {}) {
  const isARM64Linux = process.platform === 'linux' && process.arch === 'arm64';
  if (!isARM64Linux) {
    console.log('[LlamaSync] Skipping — not ARM64 Linux');
    return;
  }

  console.log(tag
    ? `[LlamaSync] Fetching llama runtime ${tag} (mirrors: ${LLAMA_RUNTIME_MIRRORS.join(', ')})...`
    : `[LlamaSync] Checking for latest llama runtime (mirrors: ${LLAMA_RUNTIME_MIRRORS.join(', ')})...`);

  for (const slug of LLAMA_RUNTIME_MIRRORS) {
    let releases;
    try {
      const res = await httpsGet(mirrorApi(slug) + '?per_page=60');
      if (res.status !== 200) {
        console.warn(`[LlamaSync] Mirror ${slug}: HTTP ${res.status} — skipping`);
        continue;
      }
      releases = JSON.parse(res.body.toString());
    } catch (e) {
      console.warn(`[LlamaSync] Mirror ${slug}: ${e.message} — skipping`);
      continue;
    }

    const release = pickLlamaRelease(releases, tag);
    if (!release) {
      // Distinguish "no such tag" from "that tag is an upstream mirror release, not a runtime bundle" —
      // the second is an easy mistake to make by hand (b10664 vs b10664-ork).
      if (tag && releases.some(r => r.tag_name === tag)) {
        console.warn(`[LlamaSync] Mirror ${slug}: ${tag} carries no runtime bundle ` +
                     `(no llama-cpp-rockchip-npu-*.tar.gz asset) — did you mean ${tag}-ork?`);
      }
      continue;
    }

    const asset = orkAsset(release);
    if (!asset) continue;

    // Up to date? Compare the release asset against what's installed by **content**
    // (GitHub's sha256 `digest`, or size if absent), not just the tag — a re-released /
    // overwritten tag keeps the same name but ships new bytes, so a tag match alone
    // can't tell them apart. Differing digest/size ⇒ a real update ⇒ re-fetch even at
    // the same tag. `force` overrides regardless (explicit user sync).
    const info = getLlamaRuntimeInfo();
    const remoteDigest = asset.digest || null;   // "sha256:…" from GitHub (may be absent)
    const sameAsset = remoteDigest
      ? info.assetSha === remoteDigest
      : (info.assetSize != null && info.assetSize === asset.size);
    if (!force && info.tag === release.tag_name && sameAsset && isLlamaRuntimeAvailable()) {
      console.log(`[LlamaSync] Already at ${release.tag_name} (asset unchanged)`);
      return;
    }

    console.log(`[LlamaSync] Downloading ${asset.name} from ${slug}...`);
    syncState.active = true;
    syncState.tag = release.tag_name;
    syncState.bytesDown = 0;
    syncState.totalBytes = asset.size ?? 0;

    try {
      const { buf } = await downloadBuffer(asset.browser_download_url);
      syncState.bytesDown = buf.length;
      // Replace, don't merge: extracting over an existing install accumulates stale
      // .so versions across releases (e.g. ggml 0.15.1 leftovers under a 0.12.0
      // release), and the soname symlinks can then resolve to a mismatched mix
      // (libggml-base.so.0→old vs libggml-vulkan.so.0→new) → ABI mismatch / crashes.
      // The tarball is fully buffered above, so wiping now is safe.
      try { fs.rmSync(LLAMA_RUNTIME_DIR, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(LLAMA_RUNTIME_DIR, { recursive: true });
      extractTarGz(buf, LLAMA_RUNTIME_DIR);
      // Write the tag + the installed asset's identity (sha256 of the exact bytes we
      // fetched, its size, and name) into the manifest. The sha256 is what lets a
      // later sync definitively detect an update — including a re-released/overwritten
      // tag — by comparing against the release asset's digest, independent of tag/time.
      const manifestPath = path.join(LLAMA_RUNTIME_DIR, 'manifest.json');
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
      manifest.tag = release.tag_name;
      manifest.assetName = asset.name;
      manifest.assetSize = buf.length;
      manifest.assetSha  = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`[LlamaSync] Installed llama runtime ${release.tag_name} to ${LLAMA_RUNTIME_DIR}`);
      // Runtime changed → re-check every model's .orkpack against the new runtime and rebuild any
      // that are now stale (the pack tiling/format can differ across runtime versions). The manifest
      // above is already written, so orkpackRuntimeId() reflects the new runtime. Covers the manual
      // Settings sync, auto-download, and the model-load auto-fetch — every path that installs a runtime.
      try { getConversionScheduler()?.revalidateForRuntime(); } catch (e) { console.warn('[LlamaSync] orkpack revalidation failed:', e.message); }
      return;
    } catch (e) {
      console.error(`[LlamaSync] Failed to download from ${slug}: ${e.message}`);
    } finally {
      syncState.active = false;
      syncState.tag = null;
      syncState.bytesDown = 0;
      syncState.totalBytes = 0;
    }
  }

  console.warn('[LlamaSync] No mirror reachable or no release found');
}
