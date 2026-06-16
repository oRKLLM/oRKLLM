import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { dbGetCredentials, dbSaveCredentials, dbGetUserByUsername, dbUpdateUser } from './db.js';

dotenv.config();

const home = os.homedir();
export const CONFIG_DIR = path.join(home, '.config', 'orkllm');
export const AUTH_FILE = process.env.ORKLLM_AUTH_FILE || path.join(CONFIG_DIR, 'auth.json');

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// Models directory
export const MODELS_DIR = process.env.ORKLLM_MODELS_DIR || path.join(process.cwd(), 'models');
if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

// RKLLM Shared Library Path on the board
export const LIBRKLLMRT_PATH = process.env.ORKLLM_LIB_PATH || '/usr/lib/librkllmrt.so';

// Ordered list of GitHub repo slugs to try when downloading runtime .so files.
// First mirror that has the requested version wins.
// Override with ORKLLM_RUNTIME_MIRRORS=owner/repo,owner2/repo2 (comma-separated).
export const RUNTIME_MIRRORS = (
  process.env.ORKLLM_RUNTIME_MIRRORS ||
  'oRKLLM/rkllm-runtimes,mafischer/rkllm-runtimes'
).split(',').map(s => s.trim()).filter(Boolean);

// Directory where versioned runtimes are stored (librkllmrt-aarch64-v1.2.3.so etc.)
export const RUNTIMES_DIR = process.env.ORKLLM_RUNTIMES_DIR ||
  (process.env.ORKLLM_DB_PATH
    ? path.join(path.dirname(process.env.ORKLLM_DB_PATH), 'runtimes')
    : path.join(CONFIG_DIR, 'runtimes'));
if (!fs.existsSync(RUNTIMES_DIR)) {
  fs.mkdirSync(RUNTIMES_DIR, { recursive: true });
}

// Llama runtime bundle (libllama.so + ggml-ork libs) for serving .gguf models on the open NPU stack.
// Defaults to the llama.cpp-rockchip release builds (the constantly-updated open
// NPU runtime); override with ORKLLM_LLAMA_RUNTIME_MIRRORS=owner/repo,... (comma-separated).
export const LLAMA_RUNTIME_MIRRORS = (
  process.env.ORKLLM_LLAMA_RUNTIME_MIRRORS ||
  'oRKLLM/llama.cpp-rockchip'
).split(',').map(s => s.trim()).filter(Boolean);

export const LLAMA_RUNTIME_DIR = process.env.ORKLLM_LLAMA_RUNTIME_DIR ||
  (process.env.ORKLLM_DB_PATH
    ? path.join(path.dirname(process.env.ORKLLM_DB_PATH), 'llama-runtime')
    : path.join(CONFIG_DIR, 'llama-runtime'));
if (!fs.existsSync(LLAMA_RUNTIME_DIR)) {
  fs.mkdirSync(LLAMA_RUNTIME_DIR, { recursive: true });
}

// Vulkan SPIR-V shader mirror (Eagle-3 'vulkan' draft strategy). Same
// distribution model as the runtime mirror: GitHub releases on oRKLLM/llama.cpp,
// each attaching a ggml-vulkan-spirv-<tag>.tar.gz of the compiled .spv modules.
// Override with ORKLLM_SPV_MIRRORS=owner/repo,owner2/repo2.
export const SPV_MIRRORS = (
  process.env.ORKLLM_SPV_MIRRORS ||
  'oRKLLM/llama.cpp'
).split(',').map(s => s.trim()).filter(Boolean);

// Directory where the extracted .spv modules + manifest live.
export const SPV_DIR = process.env.ORKLLM_SPV_DIR ||
  (process.env.ORKLLM_DB_PATH
    ? path.join(path.dirname(process.env.ORKLLM_DB_PATH), 'spv')
    : path.join(CONFIG_DIR, 'spv'));
if (!fs.existsSync(SPV_DIR)) {
  fs.mkdirSync(SPV_DIR, { recursive: true });
}
// Make the shader directory discoverable to the native addon's Vulkan loader
// (it reads ORKLLM_SPV_DIR). Set here so every process that imports config —
// the server and each forked worker — exposes it to the C++ side.
process.env.ORKLLM_SPV_DIR = SPV_DIR;

// Parse rkllm runtime version from a model filename, e.g. "model-1.2.3.rkllm" → "1.2.3"
export function parseRuntimeVersion(filename) {
  // Supports both new convention: ...-v1.2.3-RKLLM.rkllm
  // and legacy:                   ...-1.2.3.rkllm
  const m = filename.match(/[-_]v?(\d+\.\d+\.\d+)(?:-RKLLM)?\.rkllm$/i);
  return m ? m[1] : null;
}

/**
 * Retrieve saved credentials
 * @returns {object|null} {username, hash, salt} or null
 */
export function getCredentials() {
  return dbGetCredentials();
}

/**
 * Create and save new credentials
 * @param {string} username 
 * @param {string} password 
 * @returns {boolean} true
 */
export function saveCredentials(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha256').toString('hex');
  return dbSaveCredentials(username, hash, salt);
}

/**
 * Validate username and password
 * Checks the multi-user table first, falls back to legacy auth table.
 * @returns {{ valid: boolean, user: object|null }}
 */
export function verifyCredentials(username, password) {
  // Multi-user path
  const user = dbGetUserByUsername(username);
  if (user) {
    if (user.auth_provider !== 'local') return { valid: false, user: null };
    if (!user.password_hash || !user.password_salt) return { valid: false, user: null };
    const hash = crypto.pbkdf2Sync(password, user.password_salt, 1000, 64, 'sha256').toString('hex');
    return { valid: hash === user.password_hash, user: hash === user.password_hash ? user : null };
  }

  // Legacy single-user fallback
  const creds = getCredentials();
  if (!creds) return { valid: false, user: null };
  if (creds.username !== username) return { valid: false, user: null };
  const hash = crypto.pbkdf2Sync(password, creds.salt, 1000, 64, 'sha256').toString('hex');
  return { valid: hash === creds.hash, user: hash === creds.hash ? { username, role: 'admin', auth_provider: 'local', id: 'local-admin' } : null };
}

/**
 * Hash a password for storage
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha256').toString('hex');
  return { hash, salt };
}

/**
 * Verify a password against stored hash/salt
 */
export function checkPassword(password, hash, salt) {
  const derived = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha256').toString('hex');
  return derived === hash;
}

// ── Chipset capability detection ─────────────────────────────────────────────
// Single source of truth for SoC + NPU core count, derived from the device
// tree. Used by the engine pool (per-core model pinning, parallel-model cap)
// and surfaced in the admin status. Cached after first read.
let _platformCache = undefined;

const NPU_CORES_BY_SOC = { rk3576: 2, rk3588: 3, rk3588s: 3 };

/** Detected SoC slug (e.g. 'rk3576', 'rk3588') or null when undetectable. */
export function getPlatform() {
  if (_platformCache !== undefined) return _platformCache;
  try {
    const compat = fs.readFileSync('/proc/device-tree/compatible', 'utf8').replace(/\0/g, ' ');
    const m = compat.match(/rockchip,(rk\d+[a-z]?)/i);
    _platformCache = m ? m[1].toLowerCase() : null;
  } catch {
    _platformCache = null;
  }
  return _platformCache;
}

/**
 * Number of NPU compute cores for the detected SoC. Unknown/non-Rockchip → 1
 * (safe default: single core, no parallel-model pinning).
 */
export function getNpuCoreCount() {
  const soc = getPlatform();
  return (soc && NPU_CORES_BY_SOC[soc]) || 1;
}

let _gpuInfoCache;
/**
 * Mali GPU model + shader-core count, read from the kernel's `gpuinfo` node
 * (e.g. "Mali-G610 4 cores r0p0 0x0A080607"). Returns { model, cores } or null
 * when not exposed (non-Rockchip / no Mali devfreq node). Cached.
 */
export function getGpuInfo() {
  if (_gpuInfoCache !== undefined) return _gpuInfoCache;
  _gpuInfoCache = null;
  try {
    // The GPU is a devfreq node named by MMIO address (e.g. fb000000.gpu); its
    // `device/gpuinfo` carries the product string + core count.
    const base = '/sys/class/devfreq';
    const gpu = fs.readdirSync(base).find(e => e.includes('gpu'));
    const candidates = [];
    if (gpu) candidates.push(`${base}/${gpu}/device/gpuinfo`);
    try {
      for (const d of fs.readdirSync('/sys/devices/platform')) {
        if (d.includes('gpu')) candidates.push(`/sys/devices/platform/${d}/gpuinfo`);
      }
    } catch { /* ignore */ }
    for (const p of candidates) {
      let raw;
      try { raw = fs.readFileSync(p, 'utf8').trim(); } catch { continue; }
      if (!raw) continue;
      const model = (raw.match(/^(\S+)/) || [])[1] || null;        // "Mali-G610"
      const cores = parseInt((raw.match(/(\d+)\s*cores?/i) || [])[1], 10);
      _gpuInfoCache = { model, cores: Number.isFinite(cores) ? cores : null };
      break;
    }
  } catch { /* ignore */ }
  return _gpuInfoCache;
}
