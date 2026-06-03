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
