import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { dbGetCredentials, dbSaveCredentials } from './db.js';

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
 * @param {string} username 
 * @param {string} password 
 * @returns {boolean} true if valid
 */
export function verifyCredentials(username, password) {
  const creds = getCredentials();
  if (!creds) return false;
  if (creds.username !== username) return false;
  const hash = crypto.pbkdf2Sync(password, creds.salt, 1000, 64, 'sha256').toString('hex');
  return hash === creds.hash;
}
