// perf_governor.js — automatic CPU + DRAM (DMC) DVFS governor management.
//
// LLM inference on Rockchip is sensitive to clock policy: decode is
// memory-bandwidth-bound (wants DDR at max), prefill is compute-bound (wants
// CPU/NPU at max). The stock board governors (dmc_ondemand / schedutil) often
// FAIL to ramp — notably the DMC governor leaves DDR parked at its lowest step
// for NPU traffic, which roughly halves decode throughput (measured on RK3588:
// 528 MHz → 5.5 tok/s vs 2112 MHz → 11.2 tok/s for Qwen3-1.7B).
//
// So while a model is loaded we pin the CPU cores and the DDR controller to
// `performance`, and restore the original governors when the last model
// unloads. Writing these sysfs nodes needs privileges; if denied we record the
// failure so the UI can surface a manual-fix warning instead.

import fs from 'fs';
import os from 'os';
import { dbGetSetting } from './db.js';

const DMC_GOVERNOR = '/sys/class/devfreq/dmc/governor';
const CPU_BASE = '/sys/devices/system/cpu';

let saved = null;          // { dmc: string|null, cpus: {path: governor} } captured at first apply
let applied = false;       // true while we hold the performance pin
let lastError = null;      // human-readable reason the last apply could not complete

// Default ON — this is an inference appliance; opt out via the `manage_performance` setting.
export function isManaged() {
  if (os.platform() !== 'linux') return false;
  const v = dbGetSetting('manage_performance');
  return v === null || v === undefined ? true : v === '1';
}

function readGov(p) { try { return fs.readFileSync(p, 'utf-8').trim(); } catch { return null; } }
function writeGov(p, v) { fs.writeFileSync(p, v); } // throws on EACCES/ENOENT — caller handles

function cpuGovernorPaths() {
  try {
    return fs.readdirSync(CPU_BASE)
      .filter((d) => /^cpu\d+$/.test(d))
      .map((d) => `${CPU_BASE}/${d}/cpufreq/scaling_governor`)
      .filter((p) => fs.existsSync(p));
  } catch { return []; }
}

// Pin CPU cores + DDR controller to `performance`. Idempotent; no-op off-board,
// when disabled, or when already applied. Records lastError on permission fail.
export function applyPerformance() {
  if (!isManaged() || applied) return getState();

  const dmcExists = fs.existsSync(DMC_GOVERNOR);
  const cpuPaths = cpuGovernorPaths();
  if (!dmcExists && cpuPaths.length === 0) return getState(); // nothing to manage

  // Capture originals once so restore() is faithful.
  const snapshot = { dmc: dmcExists ? readGov(DMC_GOVERNOR) : null, cpus: {} };
  for (const p of cpuPaths) snapshot.cpus[p] = readGov(p);

  lastError = null;
  let wrote = false;
  try {
    if (dmcExists) { writeGov(DMC_GOVERNOR, 'performance'); wrote = true; }
    for (const p of cpuPaths) { writeGov(p, 'performance'); wrote = true; }
  } catch (e) {
    lastError = e.code === 'EACCES' || e.code === 'EPERM'
      ? 'permission denied (run oRKLLM with privileges to manage governors)'
      : e.message;
    console.warn(`[perf] could not set performance governor: ${lastError}`);
  }

  if (wrote && !lastError) {
    saved = snapshot;
    applied = true;
    console.log('[perf] CPU + DDR pinned to performance (model loaded)');
  }
  return getState();
}

// Restore the governors captured at apply time. Called when the last model unloads.
export function restoreGovernor() {
  if (!applied || !saved) return;
  try {
    if (saved.dmc) writeGov(DMC_GOVERNOR, saved.dmc);
    for (const [p, g] of Object.entries(saved.cpus)) if (g) writeGov(p, g);
    console.log('[perf] governors restored (idle)');
  } catch (e) {
    console.warn(`[perf] could not restore governors: ${e.message}`);
  }
  applied = false;
  saved = null;
}

// State for /api/admin/status so the UI knows whether to show the manual warning.
export function getState() {
  return { enabled: isManaged(), applied, failed: !!lastError, reason: lastError };
}
