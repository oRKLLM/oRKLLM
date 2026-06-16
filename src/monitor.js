import fs from 'fs';
import si from 'systeminformation';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pool from './pool.js';

const execFileAsync = promisify(execFile);

// Read TBW (total bytes written) from smartctl JSON for a device.
// smartctl exits non-zero on partial success (e.g. some ioctls need root)
// but still writes valid JSON to stdout — parse it regardless of exit code.
async function getSmartTbw(device) {
  return new Promise(resolve => {
    execFile('/usr/sbin/smartctl', ['-a', device, '-j'], { timeout: 5000 }, (err, stdout) => {
      try {
        const d = JSON.parse(stdout || '{}');
        const duw = d.nvme_smart_health_information_log?.data_units_written;
        // NVMe data_units_written is in 512 kB units
        resolve(duw != null ? Math.round(duw * 512000 / 1e9) / 1000 : null);
      } catch {
        resolve(null);
      }
    });
  });
}

// diskLayout + TBW are slow — cache together, refresh every 30 seconds.
// lastFetch = 0 so the first metrics call fetches immediately.
let diskCache = [];  // [{ device, type, size, smartStatus, tbw }]
let diskCacheLastFetch = 0;
async function getCachedDisks() {
  const now = Date.now();
  if (now - diskCacheLastFetch > 30000) {
    try {
      const layout = await si.diskLayout();
      diskCache = await Promise.all(layout.map(async d => ({
        device: d.device || d.name || '—',
        type:   d.type   || '—',
        size:   d.size   || 0,
        smartStatus: d.smartStatus || 'unknown',
        tbw: await getSmartTbw(d.device || d.name),
      })));
      diskCacheLastFetch = now;
    } catch {}
  }
  return diskCache;
}

/**
 * Gather current CPU, NPU, RAM, and Temperature metrics
 * @returns {Promise<object>} system metrics object
 */
export async function getSystemMetrics() {
  const isLinux = os.platform() === 'linux';
  
  // 1. CPU Usage — frequency-weighted across cores. On big.LITTLE SoCs (RK3588: 4×A76 +
  // 4×A55, RK3576: 4×A72 + 4×A53) a flat mean over-reports load, since a saturated little
  // core counts the same as a saturated big core despite far less compute. We weight each
  // core's load by its max clock (compute capacity), so the figure is "% of total CPU
  // throughput in use". Falls back to the flat mean when per-core data/weights are unavailable.
  let cpuLoad = 0;
  try {
    const loadData = await si.currentLoad();
    cpuLoad = weightedCpuLoad(loadData);
  } catch (e) {
    // fallback
  }

  // 2. RAM + Swap Usage
  let totalMem = 0;
  let usedMem = 0;
  let swapTotal = 0;
  let swapUsed = 0;
  try {
    const memData = await si.mem();
    totalMem = memData.total;
    // `active` (= MemTotal - MemAvailable) treats ALL page cache as reclaimable,
    // so a model loaded with mmap (llama.cpp's default — the GGUF file is mapped,
    // not copied) shows up as cache and is invisible here: a 20 GB-resident model
    // reads as ~3% used. On Linux we instead read /proc/meminfo and count
    // file-backed *mapped* pages (the model) as in-use, while leaving generic
    // unmapped file cache out — so the gauge reflects the loaded model. Falls back
    // to si's `active` off-Linux or if parsing fails.
    usedMem = (isLinux ? readMappedUsedMem() : 0) || memData.active;
    swapTotal = memData.swaptotal || 0;
    swapUsed = memData.swapused || 0;
  } catch (e) {
    // fallback
  }

  // 3. SoC Temperature
  let temperature = 0;
  if (isLinux) {
    try {
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        const rawTemp = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf-8');
        temperature = parseFloat(rawTemp) / 1000.0;
      }
    } catch (e) {
      // ignore
    }
  }
  
  if (temperature === 0) {
    try {
      const tempObj = await si.cpuTemperature();
      temperature = tempObj.main || 0;
    } catch (e) {
      // ignore
    }
  }

  // Mock temperature fallback
  if (temperature === 0) {
    const baseTemp = pool.activeGeneration ? 54 : 41;
    temperature = baseTemp + Math.random() * 2;
  }

  // 4. NPU Load — /sys/kernel/debug/rknpu/load is per-core ("Core0: X%, Core1: Y%, Core2: Z%").
  // npu = mean across cores (so 100% = every core saturated); npuCores = the per-core array.
  // A single-core workload therefore reads ~load/coreCount, which correctly shows the NPU is
  // mostly idle — earlier code matched only the FIRST "N%" (Core0), hiding the other cores.
  let npuLoad = 0;
  let npuCores = [];
  if (isLinux) {
    try {
      if (fs.existsSync('/sys/kernel/debug/rknpu/load')) {
        const rawLoad = fs.readFileSync('/sys/kernel/debug/rknpu/load', 'utf-8');
        npuCores = [...rawLoad.matchAll(/(\d+)\s*%/g)].map(m => parseInt(m[1]));
        if (npuCores.length) {
          npuLoad = Math.round(npuCores.reduce((a, b) => a + b, 0) / npuCores.length);
        } else {
          npuLoad = parseInt(rawLoad.trim()) || 0;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // Mock NPU load fallback based on active generation
  if (npuLoad === 0) {
    if (pool.activeGeneration) {
      npuLoad = Math.floor(68 + Math.random() * 24);
    } else {
      npuLoad = 0;
    }
  }

  // 5. GPU Load (Mali). On Rockchip the GPU is a devfreq node
  //    (/sys/class/devfreq/<addr>.gpu/load → "<load>@<freq>Hz", same format as the
  //    DMC), e.g. fb000000.gpu on RK3588. `readGpuLoad` prefers that and falls back
  //    to legacy debugfs mali utilization nodes; null when nothing is exposed.
  let gpuLoad = isLinux ? (readGpuLoad() ?? 0) : 0;

  // Mock GPU fallback — low idle load, spikes with CPU
  if (gpuLoad === 0 && !isLinux) {
    gpuLoad = Math.floor(cpuLoad * 0.3 + Math.random() * 5);
  }

  // 6. Disk Utilization (root filesystem)
  let diskTotal = 0;
  let diskUsed = 0;
  let diskPercentage = 0;
  try {
    const fsData = await si.fsSize();
    // Pick the root mount or the largest filesystem
    const root = fsData.find(f => f.mount === '/') || fsData.sort((a, b) => b.size - a.size)[0];
    if (root) {
      diskTotal = root.size;
      diskUsed = root.used;
      diskPercentage = root.size > 0 ? Math.round((root.used / root.size) * 100) : 0;
    }
  } catch (e) {
    // ignore
  }

  // 7. Disk layout with SMART status + TBW (cached, refreshed every 30s)
  let disks = [];
  try {
    disks = await getCachedDisks();
  } catch (e) {
    // ignore
  }

  // 8. CPU fan speed. Boards vary wildly: a tach fan exposes RPM via hwmon
  //    fan*_input; a PWM fan exposes only a duty value (pwm1, 0–255) or a
  //    thermal cooling_device cur_state/max_state. Read whichever exists and
  //    normalise to a percentage (with rpm when a tach is present). Returns
  //    null when no fan is exposed (e.g. passive cooling or unbound pwm-fan).
  const fan = isLinux ? readFanSpeed() : mockFan(temperature);

  // 9. Memory bandwidth via the DDR memory-controller devfreq monitor
  //    (/sys/class/devfreq/dmc/load → "<load>@<freq>Hz"). `load` is the DMC
  //    utilisation %, an excellent proxy for RAM bandwidth pressure; `freqMhz`
  //    is the current DDR clock. Null when no DMC devfreq node exists.
  const memBw = isLinux ? readMemBandwidth() : mockMemBw(cpuLoad);

  return {
    cpu: Math.round(cpuLoad),
    ram: {
      total: totalMem,
      used: usedMem,
      percentage: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0
    },
    swap: {
      total: swapTotal,
      used: swapUsed,
      percentage: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0
    },
    temperature: Math.round(temperature * 10) / 10,
    npu: npuLoad,
    npuCores,
    gpu: Math.round(gpuLoad),
    disk: {
      total: diskTotal,
      used: diskUsed,
      percentage: diskPercentage,
    },
    disks,
    fan,
    memBw,
  };
}

// ── Fan speed ───────────────────────────────────────────────────────────────
// Probe order: hwmon RPM tach → hwmon PWM duty → fan thermal cooling_device.
// Returns { percentage, rpm|null } or null when nothing is exposed.
function readFanSpeed() {
  try {
    const hwmons = fs.existsSync('/sys/class/hwmon') ? fs.readdirSync('/sys/class/hwmon') : [];

    // (a) Tachometer RPM — the only true speed signal. Treat ~6000 RPM as full.
    for (const h of hwmons) {
      const base = `/sys/class/hwmon/${h}`;
      for (const f of safeReaddir(base)) {
        if (/^fan\d+_input$/.test(f)) {
          const rpm = parseInt(fs.readFileSync(`${base}/${f}`, 'utf-8').trim(), 10);
          if (Number.isFinite(rpm) && rpm > 0) {
            const max = readIntFile(`${base}/${f.replace('_input', '_max')}`) || 6000;
            return { percentage: clampPct((rpm / max) * 100), rpm };
          }
        }
      }
    }

    // (b) PWM duty cycle (0–255) — a speed setting, not measured RPM.
    for (const h of hwmons) {
      const base = `/sys/class/hwmon/${h}`;
      const name = (readFile(`${base}/name`) || '').trim();
      if (fs.existsSync(`${base}/pwm1`) && /fan/i.test(name)) {
        const duty = readIntFile(`${base}/pwm1`);
        if (duty != null) return { percentage: clampPct((duty / 255) * 100), rpm: null };
      }
    }

    // (c) Thermal cooling device whose type mentions a fan (cur_state/max_state).
    const cds = safeReaddir('/sys/class/thermal').filter(d => d.startsWith('cooling_device'));
    for (const cd of cds) {
      const base = `/sys/class/thermal/${cd}`;
      const type = (readFile(`${base}/type`) || '').toLowerCase();
      if (type.includes('fan')) {
        const cur = readIntFile(`${base}/cur_state`);
        const max = readIntFile(`${base}/max_state`);
        if (cur != null && max) return { percentage: clampPct((cur / max) * 100), rpm: null };
      }
    }

    // (d) Raw PWM channel driven by a userspace fan daemon. On many DietPi /
    //     Armbian SBCs the kernel pwm-fan driver fails to bind (it stays
    //     `waiting_for_supplier`) and a script drives the PWM directly via
    //     /sys/class/pwm — so no hwmon/cooling_device exists, but the live
    //     duty cycle still tells us the fan speed. Read the first *enabled*
    //     channel and convert, honouring inverted polarity (where a higher
    //     duty means a slower fan, as the Rock 5B fan daemon uses).
    const fanPwm = readPwmFan();
    if (fanPwm) return fanPwm;
  } catch (e) {
    // ignore — fall through to null
  }
  return null;
}

function readPwmFan() {
  for (const chip of safeReaddir('/sys/class/pwm').filter(d => d.startsWith('pwmchip'))) {
    const chipBase = `/sys/class/pwm/${chip}`;
    for (const ch of safeReaddir(chipBase).filter(d => /^pwm\d+$/.test(d))) {
      const base = `${chipBase}/${ch}`;
      const enable = readIntFile(`${base}/enable`);
      if (enable === 0) return { percentage: 0, rpm: null };   // explicitly off
      const period = readIntFile(`${base}/period`);
      const duty = readIntFile(`${base}/duty_cycle`);
      if (!period || duty == null) continue;
      const inverted = /invers/i.test(readFile(`${base}/polarity`) || '');
      const frac = Math.min(1, duty / period);
      const speed = inverted ? 1 - frac : frac;
      return { percentage: clampPct(speed * 100), rpm: null };
    }
  }
  return null;
}

// ── Memory in use, counting mmap'd model pages ───────────────────────────────
// Parses /proc/meminfo and returns "used" bytes as anonymous/kernel memory PLUS
// file-backed mapped pages. llama.cpp mmaps the GGUF, so the model lives in page
// cache (Cached) and would be excluded by a plain MemTotal-MemAvailable metric;
// `Mapped` captures those mmap'd pages (the model + shared libs), while generic
// unmapped file cache (ordinary file reads) stays excluded. Returns 0 on failure
// so the caller can fall back to systeminformation's `active`.
function readMappedUsedMem() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf-8');
    const kb = (name) => {
      const m = txt.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const total = kb('MemTotal');
    if (!total) return 0;
    // classic "used" (anon + kernel) = total - free - buffers - cached, then add
    // back the mmap'd file pages so the loaded model is counted as in-use.
    const used = total - kb('MemFree') - kb('Buffers') - kb('Cached') + kb('Mapped');
    return Math.min(total, Math.max(0, used));
  } catch {
    return 0;
  }
}

// ── GPU load (Mali) ──────────────────────────────────────────────────────────
// Rockchip exposes the Mali GPU as a devfreq node whose `load` reads "<load>@<freq>Hz"
// (same as the DMC). The node is named by its MMIO address, e.g. `fb000000.gpu` on
// RK3588 — match any devfreq entry containing "gpu". Falls back to legacy debugfs
// mali utilization nodes. Returns a 0–100 percentage, or null when nothing is exposed.
function readGpuLoad() {
  try {
    const base = '/sys/class/devfreq';
    let entries = [];
    try { entries = fs.readdirSync(base); } catch { /* no devfreq */ }
    const gpu = entries.find(e => e.includes('gpu'));
    if (gpu) {
      const raw = readFile(`${base}/${gpu}/load`);          // e.g. "93@1000000000Hz"
      const m = raw && raw.trim().match(/^(\d+)/);
      if (m) return clampPct(parseInt(m[1], 10));
    }
    for (const p of [
      '/sys/kernel/debug/mali0/gpu_utilization',
      '/sys/kernel/debug/mali0/utilization_pp',
      '/sys/kernel/debug/mali0/dvfs_utilization',
      '/sys/class/misc/mali0/device/utilization',
    ]) {
      const raw = readFile(p);
      const m = raw && raw.match(/(\d+)/);
      if (m) return clampPct(parseInt(m[1], 10));
    }
  } catch { /* ignore */ }
  return null;
}

// ── Memory bandwidth (DDR memory-controller load) ────────────────────────────
// Returns { percentage, freqMhz } or null when no DMC devfreq node exists.
function readMemBandwidth() {
  try {
    const raw = readFile('/sys/class/devfreq/dmc/load');        // e.g. "7@528000000Hz"
    if (raw) {
      const m = raw.trim().match(/^(\d+)(?:@(\d+))?/);
      if (m) {
        const pct = clampPct(parseInt(m[1], 10));
        const freqMhz = m[2] ? Math.round(parseInt(m[2], 10) / 1e6) : null;
        return { percentage: pct, freqMhz };
      }
    }
    // Fallback: cur_freq only (no load governor) — report freq, unknown load.
    const cur = readIntFile('/sys/class/devfreq/dmc/cur_freq');
    if (cur != null) return { percentage: 0, freqMhz: Math.round(cur / 1e6) };
  } catch (e) {
    // ignore
  }
  return null;
}

// ── DRAM DVFS governor / throttle check ──────────────────────────────────────
// LLM *decode* is memory-bandwidth-bound. On many RK3576/RK3588 boards the
// default DMC devfreq governor (e.g. dmc_ondemand) does NOT ramp the DDR clock
// for NPU memory traffic, leaving it parked at the lowest step — which roughly
// HALVES decode throughput (measured: 528 MHz → 5.5 tok/s vs 2112 MHz →
// 11.2 tok/s for Qwen3-1.7B on RK3588). Pinning the governor to `performance`
// fixes it. We surface a soft warning so operators don't lose ~2× silently.
// Returns { governor, curFreqMhz, maxFreqMhz, throttled } or null (no dmc node /
// non-Linux). `throttled` = not pinned to performance AND currently below max.
export function getDramStatus() {
  if (os.platform() !== 'linux') return null;
  const governor = readFile('/sys/class/devfreq/dmc/governor');
  if (governor == null) return null;
  const gov = governor.trim();
  const cur = readIntFile('/sys/class/devfreq/dmc/cur_freq');
  let max = readIntFile('/sys/class/devfreq/dmc/max_freq');
  if (max == null) {
    const avail = readFile('/sys/class/devfreq/dmc/available_frequencies');
    if (avail) {
      const freqs = avail.trim().split(/\s+/).map((n) => parseInt(n, 10)).filter(Number.isFinite);
      if (freqs.length) max = Math.max(...freqs);
    }
  }
  const curFreqMhz = cur != null ? Math.round(cur / 1e6) : null;
  const maxFreqMhz = max != null ? Math.round(max / 1e6) : null;
  const throttled =
    gov !== 'performance' && curFreqMhz != null && maxFreqMhz != null && curFreqMhz < maxFreqMhz;
  return { governor: gov, curFreqMhz, maxFreqMhz, throttled };
}

// ── CPU DVFS governor / throttle check (mirrors getDramStatus) ────────────────
// Prefill is CPU-op bound (attention/softmax/norm), so a non-performance CPU governor that leaves
// the cores below their max clock throttles it — same failure mode as the DMC governor for decode.
// Reports the PERFORMANCE cluster (highest cpuinfo_max_freq — the A76s on big.LITTLE). cpufreq
// sysfs is in kHz (not Hz like devfreq). Returns { governor, curFreqMhz, maxFreqMhz, throttled }.
export function getCpuStatus() {
  if (os.platform() !== 'linux') return null;
  const dir = '/sys/devices/system/cpu/cpufreq';
  let policies;
  try { policies = fs.readdirSync(dir).filter((p) => p.startsWith('policy')); } catch (e) { return null; }
  if (!policies.length) return null;
  let best = null; // the perf cluster = highest cpuinfo_max_freq
  for (const p of policies) {
    const base = `${dir}/${p}`;
    const max = readIntFile(`${base}/cpuinfo_max_freq`);
    if (max == null) continue;
    if (!best || max > best.max) {
      const gov = readFile(`${base}/scaling_governor`);
      best = { gov: gov ? gov.trim() : null, cur: readIntFile(`${base}/scaling_cur_freq`), max };
    }
  }
  if (!best) return null;
  const curFreqMhz = best.cur != null ? Math.round(best.cur / 1000) : null; // kHz → MHz
  const maxFreqMhz = Math.round(best.max / 1000);
  const throttled =
    best.gov !== 'performance' && curFreqMhz != null && curFreqMhz < maxFreqMhz;
  return { governor: best.gov, curFreqMhz, maxFreqMhz, throttled };
}

function mockFan(temperature) {
  // Fan ramps with SoC temperature — idle ~30%, full near 80°C.
  const pct = clampPct(((temperature - 35) / 45) * 100);
  return { percentage: Math.round(20 + pct * 0.8), rpm: Math.round(1500 + pct * 35) };
}
function mockMemBw(cpuLoad) {
  return { percentage: clampPct(cpuLoad * 0.5 + Math.random() * 8), freqMhz: 2112 };
}

// Per-core max-clock weights (kHz) for the frequency-weighted CPU load, read once from
// /sys/devices/system/cpu/cpuN/cpufreq/cpuinfo_max_freq (static, so cached). Index = core
// number. Empty array => weighting unavailable (non-Linux, or no cpufreq), use the flat mean.
let _cpuWeights = null;
function getCpuCoreWeights() {
  if (_cpuWeights !== null) return _cpuWeights;
  _cpuWeights = [];
  if (os.platform() !== 'linux') return _cpuWeights;
  try {
    const base = '/sys/devices/system/cpu';
    const cores = fs.readdirSync(base)
      .filter(d => /^cpu\d+$/.test(d))
      .sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10));
    const w = cores.map(c => readIntFile(`${base}/${c}/cpufreq/cpuinfo_max_freq`) || 0);
    if (w.some(v => v > 0)) _cpuWeights = w;
  } catch { /* leave empty -> flat mean */ }
  return _cpuWeights;
}

// Frequency-weighted CPU utilisation: Σ(load_i · maxFreq_i) / Σ(maxFreq_i). On big.LITTLE this
// reflects actual compute-capacity usage instead of a flat per-core mean. Falls back to the flat
// `currentLoad` when per-core loads are missing or the core count doesn't match the weight table.
export function weightedCpuLoad(loadData, weights = getCpuCoreWeights()) {
  const flat = loadData?.currentLoad ?? 0;
  const cpus = loadData?.cpus;
  if (!Array.isArray(cpus) || cpus.length === 0) return flat;
  const w = weights;
  if (!Array.isArray(w) || w.length !== cpus.length) return flat;
  let num = 0, den = 0;
  for (let i = 0; i < cpus.length; i++) {
    const load = typeof cpus[i].load === 'number' ? cpus[i].load : 0;
    num += load * w[i];
    den += w[i];
  }
  return den > 0 ? num / den : flat;
}

// Small sysfs read helpers.
function readFile(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } }
function readIntFile(p) { const v = readFile(p); if (v == null) return null; const n = parseInt(v.trim(), 10); return Number.isFinite(n) ? n : null; }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function clampPct(n) { return Math.max(0, Math.min(100, Math.round(n))); }
