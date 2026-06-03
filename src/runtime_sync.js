import fs from 'fs';
import path from 'path';
import https from 'https';
import { RUNTIMES_DIR } from './config.js';

const MIRROR_API = 'https://api.github.com/repos/oRKLLM/rkllm-runtimes/releases';
const ARCH = 'aarch64'; // oRKLLM targets ARM64

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
    const req = https.get({ hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'oRKLLM' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, dest, onProgress));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const stream = fs.createWriteStream(dest + '.tmp');
      res.on('data', chunk => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        fs.renameSync(dest + '.tmp', dest);
        resolve();
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Live sync state — polled by the UI during JIT downloads
const syncState = {
  active: false,
  version: null,
  filename: null,
  bytesDown: 0,
  totalBytes: 0,
};

export function getSyncState() {
  return { ...syncState };
}

// Check if a specific version is already available locally
export function hasRuntime(version) {
  try {
    return fs.readdirSync(RUNTIMES_DIR)
      .some(f => f.includes(version) && f.endsWith('.so'));
  } catch { return false; }
}

export async function syncRuntimes(requiredVersion = null) {
  const isARM64Linux = process.platform === 'linux' && process.arch === 'arm64';
  if (!isARM64Linux) {
    console.log('[RuntimeSync] Skipping — not ARM64 Linux');
    return;
  }

  if (requiredVersion && hasRuntime(requiredVersion)) {
    console.log(`[RuntimeSync] Runtime ${requiredVersion} already present`);
    return;
  }

  console.log(requiredVersion
    ? `[RuntimeSync] Fetching runtime ${requiredVersion}...`
    : '[RuntimeSync] Checking for new rkllm runtime versions...');

  let releases;
  try {
    const res = await httpsGet(MIRROR_API + '?per_page=50');
    if (res.status !== 200) {
      console.warn(`[RuntimeSync] Failed to fetch releases: HTTP ${res.status}`);
      return;
    }
    releases = JSON.parse(res.body.toString());
  } catch (e) {
    console.warn(`[RuntimeSync] Failed to fetch release list: ${e.message}`);
    return;
  }

  let downloaded = 0;
  for (const release of releases) {
    const asset = release.assets?.find(a => a.name.includes(ARCH));
    if (!asset) continue;

    const dest = path.join(RUNTIMES_DIR, asset.name);
    if (fs.existsSync(dest)) continue;

    console.log(`[RuntimeSync] Downloading ${asset.name}...`);
    syncState.active = true;
    syncState.version = release.tag_name;
    syncState.filename = asset.name;
    syncState.bytesDown = 0;
    syncState.totalBytes = asset.size ?? 0;
    try {
      await downloadFile(asset.browser_download_url, dest, (received, total) => {
        syncState.bytesDown = received;
        if (total) syncState.totalBytes = total;
      });
      fs.chmodSync(dest, 0o755);
      console.log(`[RuntimeSync] Downloaded ${asset.name}`);
      downloaded++;
    } catch (e) {
      console.error(`[RuntimeSync] Failed to download ${asset.name}: ${e.message}`);
      try { fs.unlinkSync(dest + '.tmp'); } catch {}
    } finally {
      syncState.active = false;
      syncState.version = null;
      syncState.filename = null;
      syncState.bytesDown = 0;
      syncState.totalBytes = 0;
    }
  }

  if (downloaded === 0) {
    console.log('[RuntimeSync] All runtimes up to date');
  } else {
    console.log(`[RuntimeSync] Downloaded ${downloaded} new runtime(s)`);
  }
}
