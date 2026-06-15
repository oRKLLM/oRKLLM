import { fork, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MODELS_DIR, LIBRKLLMRT_PATH, RUNTIMES_DIR, LLAMA_RUNTIME_DIR, parseRuntimeVersion, getNpuCoreCount } from './config.js';
import { dbGetSetting, dbSetSetting, dbGetModelSettings, dbSetModelSettings } from './db.js';
import { applyPerformance, restoreGovernor } from './perf_governor.js';
import { syncRuntimes, hasRuntime } from './runtime_sync.js';
import { syncLlamaRuntime, isLlamaRuntimeAvailable } from './llama_sync.js';
import { eagle3Generate } from './eagle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default rkllm context length when neither an explicit option nor a per-model
// `ctx_window` setting is given. 4096 matches the common RK3576/RK3588 model
// build and is large enough for chat templates the old 2048 default overflowed;
// rkllm clamps to the model's own max_context_limit. Override per model via the
// ctx_window setting (e.g. raise for long-context models, lower for 2048-only).
const DEFAULT_MAX_CONTEXT_LEN = 4096;

// Per-worker slot — each holds one loaded model and one worker process.
function createSlot(id) {
  return {
    id,
    worker:           null,
    activeModel:      null,   // { name, path, options, isMock, libPath }
    isLoaded:         false,
    loadingPromise:   null,
    activeGeneration: null,
    idleTimer:        null,
  };
}

class EnginePool {
  constructor() {
    const savedTimeout = dbGetSetting('idle_timeout_minutes');
    this.idleTimeoutMs = (savedTimeout !== null ? parseInt(savedTimeout) : 5) * 60_000;

    // Multi-worker pool. Each slot is a separate worker process; with >1 slot
    // each model is pinned to its own NPU core so they run in parallel (one
    // model claiming all cores blocks a second init). The number of parallel
    // models is therefore capped at the chipset's NPU core count (rk3576=2,
    // rk3588=3); a single slot stays unpinned for max single-model throughput.
    this.npuCores = getNpuCoreCount();
    const requested = Math.max(1, parseInt(dbGetSetting('npu_pool_size') ?? '1') || 1);
    const poolSize = Math.min(requested, this.npuCores);
    if (requested > this.npuCores) {
      console.warn(`[EnginePool] npu_pool_size ${requested} exceeds ${this.npuCores} NPU core(s) — capping at ${this.npuCores}`);
    }
    this._slots = Array.from({ length: poolSize }, (_, i) => createSlot(i));

    this.pinned = false;
    this.queue  = [];

    // Async load tracking — so a slow (multi-second, CPU-bound gguf) load can be
    // kicked off by beginLoad() and observed via getStatus() instead of holding
    // an HTTP request open for the whole load (which a reverse proxy can time
    // out, dropping the connection → the client sees a spurious "Network error").
    this._loadStatus = { loading: null, error: null }; // loading:{model}|null, error:{model,message,code}|null

    // Speculative decoding — draft model worker (null when spec decode disabled)
    this.draftWorker   = null;
    this.draftModel    = null;
    this.draftIsLoaded = false;
  }

  // ── Backward-compat accessors pointing at slot 0 ──────────────────────
  get worker()           { return this._slots[0].worker; }
  set worker(v)          { this._slots[0].worker = v; }
  get activeModel()      { return this._slots[0].activeModel; }
  set activeModel(v)     { this._slots[0].activeModel = v; }
  get isLoaded()         { return this._slots[0].isLoaded; }
  set isLoaded(v)        { this._slots[0].isLoaded = v; }
  get loadingPromise()   { return this._slots[0].loadingPromise; }
  set loadingPromise(v)  { this._slots[0].loadingPromise = v; }
  get activeGeneration() { return this._slots[0].activeGeneration; }
  set activeGeneration(v){ this._slots[0].activeGeneration = v; }
  get idleTimer()        { return this._slots[0].idleTimer; }
  set idleTimer(v)       { this._slots[0].idleTimer = v; }

  // Find the best idle slot for a given model.
  // Priority: idle slot already loaded with model > idle unloaded slot > null.
  _pickIdleSlot(modelName) {
    return this._slots.find(s => !s.activeGeneration && s.isLoaded && s.activeModel?.name === modelName)
        || this._slots.find(s => !s.activeGeneration && !s.loadingPromise);
  }

  // Number of slots in the pool
  get poolSize() { return this._slots.length; }

  // Slots loaded with a model (for status/health)
  get loadedSlots() { return this._slots.filter(s => s.isLoaded); }

  // True if any slot is loaded (replaces the old boolean this.isLoaded for external checks)
  get anyLoaded() { return this._slots.some(s => s.isLoaded); }

  setPin(pinned) {
    this.pinned = pinned;
    if (pinned) {
      dbSetSetting('pinned_model', this.activeModel?.name ?? '');
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    } else {
      dbSetSetting('pinned_model', '');
      this.resetIdleTimer();
    }
  }

  // Returns the persisted pinned model name (or null if none)
  static getPinnedModel() {
    const v = dbGetSetting('pinned_model');
    return v || null;
  }

  // Extract version embedded in a librkllmrt.so binary via strings
  // Returns e.g. "1.2.3" or null
  static readSoVersion(soPath) {
    try {
      const out = execFileSync('strings', [soPath], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/RKLLM SDK \(version:\s*(\d+\.\d+\.\d+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // Discover available versioned runtimes in RUNTIMES_DIR, sorted newest-first
  static getAvailableRuntimes() {
    try {
      return fs.readdirSync(RUNTIMES_DIR)
        .filter(f => f.startsWith('librkllmrt') && f.endsWith('.so'))
        .map(f => {
          const soPath = path.join(RUNTIMES_DIR, f);
          // Prefer version read from the binary itself; fall back to filename
          const version = EnginePool.readSoVersion(soPath)
            ?? f.match(/(\d+\.\d+\.\d+)/)?.[1]
            ?? null;
          return { file: f, path: soPath, version };
        })
        .sort((a, b) => {
          // Sort newest-first by semver
          if (a.version && b.version) return b.version.localeCompare(a.version, undefined, { numeric: true });
          return b.file.localeCompare(a.file, undefined, { numeric: true });
        });
    } catch {
      return [];
    }
  }

  // Build ordered list of lib paths to try for a given model
  // Order: cached winner → parsed version → all others → fallback LIBRKLLMRT_PATH
  static runtimeCandidates(modelName) {
    const settings = dbGetModelSettings(modelName) || {};
    const cachedPath = settings.workingLibPath;
    const parsedVersion = parseRuntimeVersion(modelName);
    const available = EnginePool.getAvailableRuntimes();

    const candidates = [];

    // 1. Previously confirmed working lib
    if (cachedPath && fs.existsSync(cachedPath)) candidates.push(cachedPath);

    // 2. Runtime whose embedded version matches the version parsed from model filename
    if (parsedVersion) {
      const match = available.find(r => r.version === parsedVersion);
      if (match && match.path !== cachedPath) candidates.push(match.path);
    }

    // 3. All other available runtimes (newest first)
    for (const r of available) {
      if (!candidates.includes(r.path)) candidates.push(r.path);
    }

    // 4. System fallback (ORKLLM_LIB_PATH / /usr/lib/librkllmrt.so)
    if (!candidates.includes(LIBRKLLMRT_PATH)) candidates.push(LIBRKLLMRT_PATH);

    return candidates;
  }

  setIdleTimeout(minutes) {
    if (minutes <= 0) {
      this.idleTimeoutMs = 0; // Disable
    } else {
      this.idleTimeoutMs = minutes * 60 * 1000;
    }
    dbSetSetting('idle_timeout_minutes', minutes);
    this.resetIdleTimer();
  }

  // Reset the idle timer for a specific slot (or slot 0 if not given)
  resetIdleTimer(slot) {
    const s = slot ?? this._slots[0];
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    if (this.idleTimeoutMs > 0 && s.isLoaded && !s.activeGeneration && !this.pinned) {
      s.idleTimer = setTimeout(() => {
        console.log(`[EnginePool] Idle timeout on slot ${s.id}: unloading ${s.activeModel?.name}`);
        this._unloadSlot(s);
      }, this.idleTimeoutMs);
    }
  }

  // Load a model, optionally targeting a specific slot.
  // When called from processQueue a slot is always provided.
  // When called directly (e.g. from admin API) targets slot 0.
  async load(modelName, options = {}, slot) {
    const s = slot ?? this._slots[0];

    if (s.loadingPromise) return s.loadingPromise;

    // Resolve the rkllm context length (init-time `max_context_len`) once, so
    // every caller — pinned autoload (no options), admin load, chat route —
    // gets a consistent value. Precedence: explicit option → per-model
    // `ctx_window` setting → DEFAULT_MAX_CONTEXT_LEN. Without this the addon
    // silently defaults to 2048, which is too small for some chat templates
    // (e.g. Qwen3-VL) and makes every prompt overflow → empty replies.
    if (options.max_context_len == null || options.max_context_len === 0) {
      const saved = dbGetModelSettings(modelName) || {};
      const fromSetting = Number(saved.ctx_window) > 0 ? Number(saved.ctx_window) : 0;
      options = { ...options, max_context_len: fromSetting || DEFAULT_MAX_CONTEXT_LEN };
    }

    s.loadingPromise = (async () => {
      // Reuse only if it is the same model AND the same context length — a
      // changed ctx_window must force a re-init (max_context_len is init-time).
      if (s.isLoaded && s.activeModel?.name === modelName &&
          s.activeModel?.options?.max_context_len === options.max_context_len) {
        this.resetIdleTimer(s);
        return { status: 0, activeModel: s.activeModel };
      }

      // Otherwise, unload existing model on this slot first
      await this._unloadSlot(s);

      console.log(`[EnginePool] Slot ${s.id}: spawning worker for model: ${modelName}`);
      const modelPath = path.join(MODELS_DIR, modelName);
      if (!fs.existsSync(modelPath)) {
        throw new Error(`Model file not found: ${modelPath}`);
      }

      // Determine backend from file extension
      const isGguf = modelName.toLowerCase().endsWith('.gguf');
      const backend = isGguf ? 'llama' : 'rkllm';

      // NPU core pinning: with a single slot, leave the model unpinned so it
      // uses all cores (max single-model throughput). With multiple slots, pin
      // each slot to its own core (base_domain_id = slot+1, wrapped to the
      // core count) so multiple models load and run in parallel.
      const slotOptions = this._slots.length > 1
        ? { ...options, base_domain_id: (s.id % this.npuCores) + 1 }
        : { ...options };

      if (isGguf) {
        // ── llama backend (.gguf) ──────────────────────────────────────────
        const libPath = path.join(LLAMA_RUNTIME_DIR, 'libllama.so');
        const result = await this._tryLoadSlot(s, modelName, modelPath, slotOptions, libPath, 'llama');
        if (result.success) {
          s.isLoaded = true;
          applyPerformance();
          s.activeModel = { name: modelName, path: modelPath, options, isMock: result.isMock, libPath, backend: 'llama' };
          console.log(`[EnginePool] Slot ${s.id}: loaded ${modelName} (llama, isMock: ${result.isMock})`);
          this.resetIdleTimer(s);
          return { status: 0, activeModel: s.activeModel };
        }
        // Auto-download llama runtime if enabled and not yet present
        if (dbGetSetting('auto_download_llama_runtime') === '1' && !isLlamaRuntimeAvailable()) {
          console.log(`[EnginePool] Llama runtime missing — triggering sync`);
          await syncLlamaRuntime();
          const result2 = await this._tryLoadSlot(s, modelName, modelPath, slotOptions, libPath, 'llama');
          if (result2.success) {
            s.isLoaded = true;
            applyPerformance();
            s.activeModel = { name: modelName, path: modelPath, options, isMock: result2.isMock, libPath, backend: 'llama' };
            console.log(`[EnginePool] Slot ${s.id}: loaded after llama runtime sync: ${modelName}`);
            this.resetIdleTimer(s);
            return { status: 0, activeModel: s.activeModel };
          }
          if (s.worker) { s.worker.kill(); s.worker = null; }
        }
        if (s.worker) { s.worker.kill(); s.worker = null; }
        throw Object.assign(
          new Error(`Failed to load ${modelName}. Llama runtime not available at ${libPath}. ` +
            `Enable auto-download in Settings or manually sync via POST /api/admin/llama-runtime/sync.`),
          { code: 'LLAMA_RUNTIME_MISSING' }
        );
      }

      // ── rkllm backend (.rkllm) ─────────────────────────────────────────────
      const candidates = EnginePool.runtimeCandidates(modelName);
      console.log(`[EnginePool] Runtime candidates for ${modelName}: ${candidates.join(', ')}`);

      for (const libPath of candidates) {
        const result = await this._tryLoadSlot(s, modelName, modelPath, slotOptions, libPath, 'rkllm');
        if (result.success) {
          const settings = dbGetModelSettings(modelName) || {};
          if (settings.workingLibPath !== libPath) {
            dbSetModelSettings(modelName, { ...settings, workingLibPath: libPath });
          }
          s.isLoaded = true;
          applyPerformance();
          s.activeModel = { name: modelName, path: modelPath, options, isMock: result.isMock, libPath, backend: 'rkllm' };
          console.log(`[EnginePool] Slot ${s.id}: loaded ${modelName} using ${libPath} (isMock: ${result.isMock})`);
          this.resetIdleTimer(s);
          return { status: 0, activeModel: s.activeModel };
        }
        console.warn(`[EnginePool] ${libPath} failed for ${modelName}: ${result.error} — trying next`);
        if (s.worker) { s.worker.kill(); s.worker = null; }
      }

      // If auto-download is enabled and we know the required version, try fetching it
      const parsedVersion = parseRuntimeVersion(modelName);
      if (dbGetSetting('auto_download_runtimes') === '1' && parsedVersion && !hasRuntime(parsedVersion)) {
        console.log(`[EnginePool] No runtime found for ${modelName} — triggering sync for v${parsedVersion}`);
        await syncRuntimes(parsedVersion);
        const freshCandidates = EnginePool.runtimeCandidates(modelName);
        for (const libPath of freshCandidates) {
          const result2 = await this._tryLoadSlot(s, modelName, modelPath, slotOptions, libPath, 'rkllm');
          if (result2.success) {
            const settings = dbGetModelSettings(modelName) || {};
            dbSetModelSettings(modelName, { ...settings, workingLibPath: libPath });
            s.isLoaded = true;
            applyPerformance();
            s.activeModel = { name: modelName, path: modelPath, options, isMock: result2.isMock, libPath, backend: 'rkllm' };
            console.log(`[EnginePool] Slot ${s.id}: loaded after runtime sync: ${modelName} using ${libPath}`);
            this.resetIdleTimer(s);
            return { status: 0, activeModel: s.activeModel };
          }
          if (s.worker) { s.worker.kill(); s.worker = null; }
        }
      }

      const versionHint = parsedVersion ? ` (requires runtime v${parsedVersion})` : '';
      throw Object.assign(
        new Error(
          `Failed to load ${modelName}${versionHint}. All runtimes were tried and failed. ` +
          `Check journalctl -u orkllm for 'E rkllm:' lines — common causes: wrong target platform ` +
          `(model built for RK3588 but board is RK3576, or vice versa), corrupt model file, or ` +
          `insufficient NPU memory. Tried: ${candidates.join(', ')}`
        ),
        { code: 'RUNTIME_MISSING', runtimeVersion: parsedVersion }
      );
    })();

    this._loadStatus = { loading: { model: modelName }, error: null };
    try {
      const res = await s.loadingPromise;
      this._loadStatus.loading = null;
      return res;
    } catch (e) {
      this._loadStatus = { loading: null, error: { model: modelName, message: e.message, code: e.code ?? null } };
      throw e;
    } finally {
      s.loadingPromise = null;
    }
  }

  // Fire-and-forget load. Starts loading and returns immediately; progress and
  // failures are reported through getStatus().loading / .loadError so the client
  // polls instead of holding open a request that a reverse proxy could time out.
  // The rejection is swallowed here because it's recorded in _loadStatus.error
  // (an unhandled rejection would otherwise be noisy).
  beginLoad(modelName, options = {}) {
    this.load(modelName, options).catch(() => {});
    return { accepted: true, model: modelName };
  }

  // Attempt to load a model on a slot with a specific libPath
  _tryLoadSlot(slot, modelName, modelPath, options, libPath, backend = 'rkllm') {
    return new Promise((resolve) => {
      const workerPath = path.join(__dirname, 'worker.js');
      // 'advanced' (v8) IPC serialization preserves TypedArrays — Eagle-3's
      // hidden_states/logits are Float32Arrays and the default 'json' codec
      // turns them into plain objects (length lost), breaking the GPU draft.
      slot.worker = fork(workerPath, { serialization: 'advanced' });

      // Persistent guards so a worker that dies mid-inference can never crash the
      // whole server. Without an 'error' listener, an IPC failure (e.g.
      // ERR_IPC_CHANNEL_CLOSED from sending to a dead worker) is emitted as an
      // unhandled 'error' event and takes the process down. The 'exit' guard
      // marks the slot unloaded so the next request reloads instead of sending
      // into a closed channel. (The load handshake below uses its own one-shot
      // listeners; these stay attached for the worker's whole lifetime.)
      const deadWorker = slot.worker;
      deadWorker.on('error', (err) => {
        console.error(`[EnginePool] Slot ${slot.id}: worker IPC error: ${err.message}`);
      });
      deadWorker.on('exit', (code, signal) => {
        if (slot.worker === deadWorker) {
          if (slot.isLoaded) console.error(`[EnginePool] Slot ${slot.id}: worker exited unexpectedly (${signal ?? code}) — marking slot unloaded`);
          slot.isLoaded = false;
          slot.activeModel = null;
          slot.worker = null;
        }
      });

      const loadTimeout = setTimeout(() => {
        console.error(`[EnginePool] Slot ${slot.id}: load timeout (60s) with ${libPath}`);
        resolve({ success: false, error: 'Timeout (60s)' });
      }, 60000);

      const onMessage = (msg) => {
        if (msg.type !== 'loaded') return;
        clearTimeout(loadTimeout);
        slot.worker.removeListener('exit', onExit);
        slot.worker.removeListener('message', onMessage);
        if (msg.status === 0) {
          resolve({ success: true, isMock: msg.isMock });
        } else {
          resolve({ success: false, error: msg.error || `status ${msg.status}` });
        }
      };

      const onExit = (code, signal) => {
        clearTimeout(loadTimeout);
        if (slot.worker) slot.worker.removeListener('message', onMessage);
        slot.worker = null;
        resolve({ success: false, error: `Worker exited (${signal ?? code})` });
      };

      slot.worker.on('message', onMessage);
      slot.worker.once('exit', onExit);
      slot.worker.send({ type: 'load', modelPath, options, libPath, backend });
    });
  }

  // Unload a specific slot
  async _unloadSlot(slot) {
    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    if (slot.worker) {
      console.log(`[EnginePool] Slot ${slot.id}: terminating worker for ${slot.activeModel?.name}`);
      slot.worker.kill();
      slot.worker = null;
    }
    slot.activeModel = null;
    slot.isLoaded    = false;
    // When the last model unloads, drop the performance pin back to the board defaults.
    if (!this._slots.some((sl) => sl.isLoaded)) restoreGovernor();
  }

  // Public unload — unloads slot 0 (primary), preserves additional slots
  async unload() {
    await this._unloadSlot(this._slots[0]);
    this.pinned = false;
    dbSetSetting('pinned_model', '');
  }

  // Unload all slots (e.g. on server shutdown)
  async unloadAll() {
    await Promise.all(this._slots.map(s => this._unloadSlot(s)));
    this.pinned = false;
    dbSetSetting('pinned_model', '');
  }

  // ── Prefill-only cache warming ──────────────────────────────────────────
  // Runs inference, aborts after the first decode token, saves KV cache.
  // Returns { firstToken, savedPath } so callers can detect whether the
  // saved cache includes the first decode token (case B) or is clean (case A).
  async prefillAndCache(prompt, savePath) {
    if (!this.isLoaded) throw new Error('No model loaded');
    return new Promise((resolve, reject) => {
      let firstToken = null;
      let abortSent = false;

      const onMsg = (msg) => {
        if (msg.type !== 'token') return;

        if (msg.state === 0 && msg.text && !abortSent) {
          // First decode token — KV cache for prompt is fully built
          firstToken = { text: msg.text, token_id: msg.token_id };
          abortSent = true;
          if (this.worker) this.worker.send({ type: 'abort' });
        }

        if (msg.state === 2 || msg.state === 3) {
          // Generation stopped (naturally or via abort) — cache should be saved
          this.worker?.removeListener('message', onMsg);
          console.log(`[EnginePool] prefillAndCache done: saved to ${savePath}, firstToken="${firstToken?.text}"`);
          resolve({ firstToken, savedPath: savePath });
        }
      };

      this.worker.on('message', onMsg);
      this.worker.send({ type: 'run', prompt, saveCachePath: savePath });
    });
  }

  // ── Draft model management ──────────────────────────────────────────────

  async loadDraft(draftModelName) {
    if (this.draftIsLoaded && this.draftModel?.name === draftModelName) return;
    await this.unloadDraft();

    const draftPath = path.join(MODELS_DIR, draftModelName);
    if (!fs.existsSync(draftPath)) {
      throw new Error(`Draft model not found: ${draftPath}`);
    }

    // Draft model must generate exactly 1 token per step for speculative decoding
    const draftOptions = { max_new_tokens: 1 };
    const candidates = EnginePool.runtimeCandidates(draftModelName);
    for (const libPath of candidates) {
      const result = await this._tryLoadWorker('draft', draftModelName, draftPath, draftOptions, libPath);
      if (result.success) {
        this.draftIsLoaded = true;
        this.draftModel = { name: draftModelName, path: draftPath, isMock: result.isMock, libPath };
        console.log(`[EnginePool] Draft model loaded: ${draftModelName}`);
        return;
      }
      if (this.draftWorker) { this.draftWorker.kill(); this.draftWorker = null; }
    }
    throw new Error(`No compatible runtime for draft model: ${draftModelName}`);
  }

  async unloadDraft() {
    if (this.draftWorker) {
      this.draftWorker.kill();
      this.draftWorker = null;
    }
    this.draftModel = null;
    this.draftIsLoaded = false;
  }

  // Like _tryLoad but targets the draftWorker slot
  _tryLoadWorker(slot, modelName, modelPath, options, libPath) {
    const workerPath = path.join(__dirname, 'worker.js');
    if (slot === 'draft') {
      this.draftWorker = fork(workerPath, { serialization: 'advanced' });
      // Guard against unhandled 'error' (IPC failure) crashing the server.
      this.draftWorker.on('error', (err) => {
        console.error(`[EnginePool] Draft worker IPC error: ${err.message}`);
      });
    }
    const worker = slot === 'draft' ? this.draftWorker : this.worker;

    return new Promise((resolve) => {
      const loadTimeout = setTimeout(() => {
        resolve({ success: false, error: 'Timeout (60s)' });
      }, 60000);

      const onMessage = (msg) => {
        if (msg.type !== 'loaded') return;
        clearTimeout(loadTimeout);
        worker.removeListener('exit', onExit);
        worker.removeListener('message', onMessage);
        if (msg.status === 0) {
          resolve({ success: true, isMock: msg.isMock });
        } else {
          resolve({ success: false, error: msg.error || `status ${msg.status}` });
        }
      };

      const onExit = (code, signal) => {
        clearTimeout(loadTimeout);
        worker.removeListener('message', onMessage);
        if (slot === 'draft') this.draftWorker = null;
        else this.worker = null;
        resolve({ success: false, error: `Worker exited (${signal || code})` });
      };

      worker.on('message', onMessage);
      worker.once('exit', onExit);
      worker.send({ type: 'load', modelPath, options, libPath });
    });
  }

  // ── Speculative decoding ────────────────────────────────────────────────

  // Run one draft step: send prompt, collect the single token, wait for state=2 finish.
  // Draft model is loaded with max_new_tokens=1 so each run produces exactly 1 token.
  _runDraftStep(promptSoFar) {
    return new Promise((resolve, reject) => {
      if (!this.draftWorker) return reject(new Error('Draft worker not available'));
      let token = null;
      const onMsg = (msg) => {
        if (msg.type !== 'token') return;
        if (msg.state === 0 && msg.text && !token) {
          token = { text: msg.text, token_id: msg.token_id };
        }
        if (msg.state === 2 || msg.state === 3) {
          // state=2 confirms generation fully stopped — safe to proceed
          this.draftWorker.removeListener('message', onMsg);
          resolve(token);
        }
      };
      this.draftWorker.on('message', onMsg);
      this.draftWorker.send({ type: 'run', prompt: promptSoFar });
    });
  }

  // Run k draft steps sequentially, waiting for full stop between each.
  async _runDraftSteps(prompt, k) {
    if (!this.draftWorker || !this.draftIsLoaded) {
      throw new Error('Draft model not loaded');
    }
    const tokens = [];
    let promptSoFar = prompt;
    for (let i = 0; i < k; i++) {
      const token = await this._runDraftStep(promptSoFar);
      if (!token) break; // draft finished early (EOS)
      tokens.push(token);
      promptSoFar += token.text;
    }
    return tokens;
  }

  // Verify draft tokens with target model using get_logits mode.
  // Returns array of accepted tokens (longest matching prefix).
  // Verify draft tokens against target model.
  // Strategy: run target from `prompt`, collect k+1 tokens, find longest
  // prefix where target_token_id[i] === draft_token_id[i].
  // Returns { accepted: Token[], targetToken: Token|null }
  _verifyDraftTokens(prompt, draftTokens) {
    const k = draftTokens.length;
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.isLoaded) {
        return reject(new Error('Target model not loaded'));
      }

      const targetTokens = [];
      const onMsg = (msg) => {
        if (msg.type !== 'token') return;
        if (msg.state === 0 && msg.text) {
          targetTokens.push({ text: msg.text, token_id: msg.token_id });
          // Collected enough to verify all draft tokens + 1 correction token
          if (targetTokens.length >= k + 1) {
            this.worker.removeListener('message', onMsg);
            abortAndFinish(); // abort and wait for state=2 before resolving
          }
        } else if (msg.state === 2 || msg.state === 3) {
          // Generation finished naturally (EOS or max_tokens reached)
          this.worker.removeListener('message', onMsg);
          finish();
        }
      };

      const abortAndFinish = () => {
        // Send abort then wait for state=2 to flush IPC before resolving.
        // This prevents stale tokens leaking into the next run.
        if (this.worker) this.worker.send({ type: 'abort' });
        const waitDone = (msg) => {
          if (msg.type === 'token' && (msg.state === 2 || msg.state === 3)) {
            this.worker?.removeListener('message', waitDone);
            finish();
          }
        };
        this.worker?.on('message', waitDone);
        // Safety timeout in case abort arrives after state=2 already sent
        setTimeout(() => {
          this.worker?.removeListener('message', waitDone);
          finish();
        }, 500);
      };

      const finish = () => {
        // Find longest matching prefix
        const accepted = [];
        for (let i = 0; i < Math.min(draftTokens.length, targetTokens.length); i++) {
          if (targetTokens[i].token_id === draftTokens[i].token_id) {
            accepted.push(draftTokens[i]);
          } else {
            // Mismatch — use target's token at this position
            return resolve({ accepted, targetToken: targetTokens[i] });
          }
        }
        // All draft tokens accepted — if target has a bonus next token use it
        const bonus = targetTokens[draftTokens.length] || null;
        resolve({ accepted, targetToken: bonus });
      };

      this.worker.on('message', onMsg);
      this.worker.send({ type: 'run', prompt });
    });
  }

  // Speculative decoding generation loop
  async generateSpeculative(modelName, draftModelName, prompt, options, onToken, k = 4) {
    // Ensure target is loaded first
    await this.load(modelName, options);

    // Attempt to load draft — on a single NPU the second rkllm_init will block
    // indefinitely.  We try with a short timeout and fall back to standard
    // generate if the draft cannot load (single-NPU boards like RK3576).
    try {
      await Promise.race([
        this.loadDraft(draftModelName),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Draft model load timeout — single NPU likely blocked')), 15000)
        ),
      ]);
    } catch (e) {
      console.warn(`[EnginePool] Speculative decode unavailable (${e.message}), falling back to standard generate`);
      await this.unloadDraft();
      return this.generate(modelName, prompt, options, onToken);
    }

    let currentPrompt = prompt;
    let totalTokens = 0;
    const maxTokens = options.max_new_tokens || 512;
    let done = false;

    while (!done && totalTokens < maxTokens) {
      // 1. Draft phase: generate k candidate tokens
      const draftTokens = await this._runDraftSteps(currentPrompt, k);
      if (draftTokens.length === 0) break;

      // 2. Verify phase: target model verifies draft
      const { accepted, targetToken } = await this._verifyDraftTokens(currentPrompt, draftTokens);

      // 3. Emit accepted tokens
      for (const tok of accepted) {
        onToken({ text: tok.text, state: 0, perf: {} });
        currentPrompt += tok.text;
        totalTokens++;
        if (totalTokens >= maxTokens) { done = true; break; }
      }

      // 4. If mismatch, emit target's correction token
      if (!done && targetToken) {
        onToken({ text: targetToken.text, state: 0, perf: {} });
        currentPrompt += targetToken.text;
        totalTokens++;
        if (totalTokens >= maxTokens) done = true;
      }

      // 5. If no accepted tokens and no target token, generation is complete
      if (accepted.length === 0 && !targetToken) done = true;
    }

    onToken({ text: '', state: 2, perf: { prefill_time_ms: 0, prefill_tokens: 0, generate_time_ms: 0, generate_tokens: totalTokens } });
  }

  // ── Eagle-3 speculative decoding ────────────────────────────────────────
  // Uses RKLLM_INFER_GET_LAST_HIDDEN_LAYER + RKLLM_INFER_GET_LOGITS.
  // Empirically validated: GET_LOGITS processes k tokens in constant time
  // (~2200ms for k=1,2,4,8 on 1.7B) — see AGENTS.md Section 11.
  // Pipelined: Mali draft head runs concurrently with NPU verification.
  // Measured speedup: 3.73× vs baseline (1.7 tok/s vs 0.5 tok/s).
  //
  // Falls back to pool.generate() if:
  //   - RKLLM_INFER_GET_LAST_HIDDEN_LAYER returns no hidden states
  //   - No model loaded
  async generateEagle3(modelName, prompt, options, onToken, {
    k = 4,
    draftStrategy = 'cpu',
    draftWeightsPath = null,
  } = {}) {
    // Ensure target model is loaded on slot 0
    await this.load(modelName, options);

    // Find the worker for slot 0 (target model)
    const slot = this._slots[0];
    if (!slot.isLoaded || !slot.worker) {
      throw new Error('[Eagle-3] No model loaded in slot 0');
    }

    // The draft head path is stored relative to MODELS_DIR (e.g.
    // "Foo_eagle3/model.safetensors"); resolve it to an absolute path so the
    // native loader can open the head + its embeddings.safetensors regardless
    // of the process cwd. (Without this the Vulkan draft silently falls back to
    // the CPU placeholder → ~0% acceptance → constant KV rollback.)
    const resolvedDraftPath = draftWeightsPath
      ? (path.isAbsolute(draftWeightsPath) ? draftWeightsPath : path.join(MODELS_DIR, draftWeightsPath))
      : null;

    // Mark slot as busy during Eagle generation
    const genPromise = eagle3Generate(slot.worker, prompt, options, onToken, {
      k, draftStrategy, draftWeightsPath: resolvedDraftPath,
    });

    slot.activeGeneration = genPromise;
    try {
      const stats = await genPromise;
      if (stats === null) {
        // Hidden states not available — fall back to standard generation
        console.warn('[Eagle-3] Falling back to standard generate (no hidden states)');
        return this.generate(modelName, prompt, options, onToken);
      }
      const acceptRate = stats.drafted > 0 ? stats.accepted / stats.drafted : 0;
      const draftHiddenPct = stats.npu_verify_ms > 0
        ? (stats.draft_ms / stats.npu_verify_ms * 100).toFixed(1) + '%' : 'N/A';
      console.log(`[Eagle-3] Done — acceptance: ${(acceptRate * 100).toFixed(0)}%  ` +
        `draft hidden: ${draftHiddenPct}  ` +
        `tokens: ${stats.accepted + stats.corrected}`);
      return {
        perf: {
          prefill_time_ms:  stats.npu_hidden_ms,
          prefill_tokens:   0,
          generate_time_ms: stats.npu_verify_ms,
          generate_tokens:  stats.accepted + stats.corrected,
          eagle_stats: {
            steps:           stats.steps,
            drafted:         stats.drafted,
            accepted:        stats.accepted,
            corrected:       stats.corrected,
            acceptance_rate: acceptRate,
            npu_hidden_ms:   stats.npu_hidden_ms,
            npu_verify_ms:   stats.npu_verify_ms,
            draft_ms:        stats.draft_ms,
            draft_hidden_pct: draftHiddenPct,
          },
        },
      };
    } finally {
      slot.activeGeneration = null;
      this.resetIdleTimer(slot);
      this.processQueue();
    }
  }

  async generate(modelName, prompt, options, onToken, cachePaths = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ modelName, prompt, options, onToken, cachePaths, resolve, reject });
      this.processQueue();
    });
  }

  // Dispatch queued requests to idle slots concurrently.
  // Called whenever a slot becomes free or a new request is enqueued.
  processQueue() {
    if (this.queue.length === 0) return;

    for (let i = 0; i < this.queue.length; i++) {
      const req = this.queue[i];
      const slot = this._pickIdleSlot(req.modelName);
      if (!slot) continue; // all slots busy — wait for one to finish

      this.queue.splice(i, 1);
      i--;
      this._dispatchToSlot(slot, req);
    }
  }

  // Run one request on a slot; calls processQueue again when done.
  async _dispatchToSlot(slot, { modelName, prompt, options, onToken, cachePaths, resolve, reject }) {
    // Cancel any pending idle-timeout on this slot
    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }

    try {
      await this.load(modelName, options, slot);

      slot.activeGeneration = new Promise((genResolve, genReject) => {
        const tokenHandler = (msg) => {
          if (msg.type === 'token') {
            onToken(msg);
            if (msg.state === 2 || msg.state === 3) {
              cleanup();
              genResolve(msg);
            }
          } else if (msg.type === 'error') {
            cleanup();
            genReject(new Error(msg.message));
          }
        };

        const exitHandler = () => {
          cleanup();
          slot.isLoaded    = false;
          slot.worker      = null;
          slot.activeModel = null;
          genReject(new Error('Worker process exited unexpectedly during generation'));
        };

        const cleanup = () => {
          slot.worker?.removeListener('message', tokenHandler);
          slot.worker?.removeListener('exit',    exitHandler);
        };

        slot.worker.on('message', tokenHandler);
        slot.worker.on('exit',    exitHandler);
        slot.worker.send({
          type:          'run',
          prompt,
          loadCachePath: cachePaths?.loadCachePath,
          saveCachePath: cachePaths?.saveCachePath,
        });
      });

      const result = await slot.activeGeneration;
      resolve(result);
    } catch (e) {
      reject(e);
    } finally {
      slot.activeGeneration = null;
      this.resetIdleTimer(slot);
      this.processQueue(); // try to dispatch next queued request
    }
  }

  async abort() {
    // Abort all active generations across all slots
    for (const s of this._slots) {
      if (s.worker && s.activeGeneration) s.worker.send({ type: 'abort' });
    }
  }

  async clearCache() {
    for (const s of this._slots) {
      if (s.worker) s.worker.send({ type: 'clear_cache' });
    }
  }

  getStatus() {
    // Primary slot (slot 0) drives the single-model status reported to the UI
    const primary = this._slots[0];
    return {
      isLoaded:      primary.isLoaded,
      model:         primary.activeModel?.name  ?? null,
      isMock:        primary.activeModel?.isMock ?? false,
      options:       primary.activeModel?.options ?? null,
      activeRuntime: primary.activeModel?.backend ?? null,
      // Current idle-unload timeout (independent of whether a model is loaded),
      // so the UI can restore the saved value on page refresh.
      idleTimeoutMs: this.idleTimeoutMs,
      pinned:        this.pinned,
      // Async load observability (see beginLoad): a client that POSTed /load
      // polls these instead of awaiting the load over a single HTTP request.
      loading:       this._loadStatus.loading,  // { model } while a load runs, else null
      loadError:     this._loadStatus.error,    // { model, message, code } of the last failed load, else null
      poolSize:      this._slots.length,
      slots:         this._slots.map(s => ({
        id:      s.id,
        model:   s.activeModel?.name ?? null,
        loaded:  s.isLoaded,
        busy:    !!s.activeGeneration,
        backend: s.activeModel?.backend ?? null,
      })),
    };
  }
}

export const pool = new EnginePool();
export default pool;
