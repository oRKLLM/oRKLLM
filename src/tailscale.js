// Tailscale integration — runtime-detected, never a hard dependency.
//
// oRKLLM does not ship or require Tailscale (it isn't in stock Debian repos).
// This module shells out to the `tailscale` CLI if present, to (a) report
// state, (b) join the tailnet headlessly with an auth key, and (c) toggle
// `tailscale serve` so the app is reachable over HTTPS at the node's
// `*.ts.net` name. All functions degrade gracefully (return state/`{ok:false}`
// rather than throwing) so the feature is a no-op when Tailscale is absent.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const TS = 'tailscale';

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

/** Derive the public HTTPS URL from a Tailscale DNSName (trailing dot stripped). */
export function serveUrlFromDNSName(dnsName) {
  if (!dnsName || typeof dnsName !== 'string') return null;
  return `https://${dnsName.replace(/\.$/, '')}`;
}

/** Summarize `tailscale status --json` into oRKLLM's state shape. */
export function summarizeStatus(status) {
  if (!status || typeof status !== 'object') {
    return { loggedIn: false, backendState: null, dnsName: null, serveUrl: null };
  }
  const self = status.Self || {};
  const dnsName = self.DNSName || null;
  return {
    loggedIn: status.BackendState === 'Running',
    backendState: status.BackendState || null,
    dnsName,
    serveUrl: serveUrlFromDNSName(dnsName),
  };
}

/** Redact an auth key before it could reach a log or an API response. */
export function scrubKey(message, authKey) {
  const s = String(message ?? '');
  return authKey ? s.split(authKey).join('tskey-***') : s;
}

// ── CLI wrappers (graceful) ──────────────────────────────────────────────────

export async function isAvailable() {
  try {
    await execFileAsync('which', [TS], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function rawStatus() {
  try {
    const { stdout } = await execFileAsync(TS, ['status', '--json'], { timeout: 5000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function isServeActive() {
  try {
    const { stdout } = await execFileAsync(TS, ['serve', 'status', '--json'], { timeout: 5000 });
    const cfg = JSON.parse(stdout || '{}');
    return !!cfg && Object.keys(cfg).length > 0;
  } catch {
    return false;
  }
}

/** Full state for the admin UI. Never throws. */
export async function getState() {
  if (!(await isAvailable())) {
    return { installed: false, loggedIn: false, backendState: null, dnsName: null, serveUrl: null, serveActive: false };
  }
  const state = summarizeStatus(await rawStatus());
  return { installed: true, ...state, serveActive: await isServeActive() };
}

/** Join the tailnet headlessly with a pre-shared auth key. Never logs the key. */
export async function up({ authKey, hostname } = {}) {
  if (!authKey) return { ok: false, error: 'authKey required' };
  const args = ['up', '--authkey', authKey];
  if (hostname) args.push('--hostname', hostname);
  try {
    await execFileAsync(TS, args, { timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: scrubKey(e.stderr || e.message, authKey) };
  }
}

/** Expose the local app over HTTPS on the tailnet (background serve). */
export async function enableServe(port) {
  try {
    await execFileAsync(TS, ['serve', '--bg', String(port)], { timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
}

export async function disableServe() {
  try {
    await execFileAsync(TS, ['serve', 'reset'], { timeout: 10000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
}
