import fs from 'fs';
import path from 'path';
import https from 'https';
import zlib from 'zlib';
import { LLAMA_RUNTIME_DIR, LLAMA_RUNTIME_MIRRORS } from './config.js';

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
      // preserve execute bit for .so files
      if (baseName.endsWith('.so') || baseName.includes('.so.')) fs.chmodSync(dest, 0o755);
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

export async function getLlamaReleases() {
  const isARM64Linux = process.platform === 'linux' && process.arch === 'arm64';
  if (!isARM64Linux) return [];

  for (const slug of LLAMA_RUNTIME_MIRRORS) {
    try {
      // llama.cpp pushes builds constantly, so only surface the newest handful
      // for the picker (GitHub returns newest-first). syncLlamaRuntime fetches a
      // wider window, so any listed tag still resolves.
      const res = await httpsGet(mirrorApi(slug) + '?per_page=20');
      if (res.status !== 200) continue;
      const releases = JSON.parse(res.body.toString());
      return releases
        .filter(r => r.assets?.some(a => a.name.endsWith('.tar.gz')))
        .map(r => ({ tag: r.tag_name, publishedAt: r.published_at }))
        .slice(0, 10);
    } catch { /* try next */ }
  }
  return [];
}

export async function syncLlamaRuntime(tag = null) {
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
      const res = await httpsGet(mirrorApi(slug) + '?per_page=20');
      if (res.status !== 200) {
        console.warn(`[LlamaSync] Mirror ${slug}: HTTP ${res.status} — skipping`);
        continue;
      }
      releases = JSON.parse(res.body.toString());
    } catch (e) {
      console.warn(`[LlamaSync] Mirror ${slug}: ${e.message} — skipping`);
      continue;
    }

    const release = tag
      ? releases.find(r => r.tag_name === tag)
      : releases[0]; // latest
    if (!release) continue;

    const asset = release.assets?.find(a => a.name.endsWith('.tar.gz'));
    if (!asset) continue;

    // Already have this tag?
    const info = getLlamaRuntimeInfo();
    if (info.tag === release.tag_name && isLlamaRuntimeAvailable()) {
      console.log(`[LlamaSync] Already at ${release.tag_name}`);
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
      fs.mkdirSync(LLAMA_RUNTIME_DIR, { recursive: true });
      extractTarGz(buf, LLAMA_RUNTIME_DIR);
      // Write tag into manifest if not already there
      const manifestPath = path.join(LLAMA_RUNTIME_DIR, 'manifest.json');
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
      manifest.tag = release.tag_name;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`[LlamaSync] Installed llama runtime ${release.tag_name} to ${LLAMA_RUNTIME_DIR}`);
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
