import { fork, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MODELS_DIR, LIBRKLLMRT_PATH, RUNTIMES_DIR, parseRuntimeVersion } from './config.js';
import { dbGetSetting, dbSetSetting, dbGetModelSettings, dbSetModelSettings } from './db.js';
import { syncRuntimes, hasRuntime } from './runtime_sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class EnginePool {
  constructor() {
    this.worker = null;
    this.activeModel = null; // { name, path, options, isMock }
    this.isLoaded = false;
    this.loadingPromise = null;
    this.activeGeneration = null;
    this.idleTimer = null;
    this.pinned = false; // when true, idle timer never fires

    // Load idle timeout from DB or default to 5 minutes
    const savedTimeout = dbGetSetting('idle_timeout_minutes');
    const timeoutVal = savedTimeout !== null ? parseInt(savedTimeout) : 5;
    this.idleTimeoutMs = timeoutVal * 60 * 1000;

    this.queue = [];
    this.processingQueue = false;

    // Speculative decoding — draft model worker (null when spec decode disabled)
    this.draftWorker = null;
    this.draftModel = null; // { name, path, options, isMock }
    this.draftIsLoaded = false;
  }

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

  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleTimeoutMs > 0 && this.isLoaded && !this.activeGeneration && !this.pinned) {
      this.idleTimer = setTimeout(() => {
        console.log(`[EnginePool] Idle timeout reached. Unloading active model: ${this.activeModel?.name}`);
        this.unload();
      }, this.idleTimeoutMs);
    }
  }

  async load(modelName, options = {}) {
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      // If already loaded and it is the same model, reuse it
      if (this.isLoaded && this.activeModel && this.activeModel.name === modelName) {
        this.resetIdleTimer();
        return { status: 0, activeModel: this.activeModel };
      }

      // Otherwise, unload any existing model first
      await this.unload();

      console.log(`[EnginePool] Spawning worker process for model: ${modelName}`);
      const modelPath = path.join(MODELS_DIR, modelName);
      if (!fs.existsSync(modelPath)) {
        throw new Error(`Model file not found: ${modelPath}`);
      }

      const candidates = EnginePool.runtimeCandidates(modelName);
      console.log(`[EnginePool] Runtime candidates for ${modelName}: ${candidates.join(', ')}`);

      // Try each candidate lib path until one succeeds
      for (const libPath of candidates) {
        const result = await this._tryLoad(modelName, modelPath, options, libPath);
        if (result.success) {
          // Cache the working lib path so future loads skip straight to it
          const settings = dbGetModelSettings(modelName) || {};
          if (settings.workingLibPath !== libPath) {
            dbSetModelSettings(modelName, { ...settings, workingLibPath: libPath });
          }
          this.isLoaded = true;
          this.activeModel = { name: modelName, path: modelPath, options, isMock: result.isMock, libPath };
          console.log(`[EnginePool] Model loaded: ${modelName} using ${libPath} (isMock: ${result.isMock})`);
          this.resetIdleTimer();
          return { status: 0, activeModel: this.activeModel };
        }
        console.warn(`[EnginePool] ${libPath} failed for ${modelName}: ${result.error} — trying next`);
        // Kill the failed worker before trying next candidate
        if (this.worker) { this.worker.kill(); this.worker = null; }
      }

      // If auto-download is enabled and we know the required version, try fetching it
      const parsedVersion = parseRuntimeVersion(modelName);
      if (dbGetSetting('auto_download_runtimes') === '1' && parsedVersion && !hasRuntime(parsedVersion)) {
        console.log(`[EnginePool] No runtime found for ${modelName} — triggering sync for v${parsedVersion}`);
        await syncRuntimes(parsedVersion);
        // Rebuild candidates with newly downloaded runtime and retry once
        const freshCandidates = EnginePool.runtimeCandidates(modelName);
        for (const libPath of freshCandidates) {
          const result = await this._tryLoad(modelName, modelPath, options, libPath);
          if (result.success) {
            const settings = dbGetModelSettings(modelName) || {};
            dbSetModelSettings(modelName, { ...settings, workingLibPath: libPath });
            this.isLoaded = true;
            this.activeModel = { name: modelName, path: modelPath, options, isMock: result.isMock, libPath };
            console.log(`[EnginePool] Model loaded after runtime sync: ${modelName} using ${libPath}`);
            this.resetIdleTimer();
            return { status: 0, activeModel: this.activeModel };
          }
          if (this.worker) { this.worker.kill(); this.worker = null; }
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

    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  // Attempt to load a model with a specific libPath — resolves with {success, isMock} or {success:false, error}
  _tryLoad(modelName, modelPath, options, libPath) {
    return new Promise((resolve) => {
      const workerPath = path.join(__dirname, 'worker.js');
      this.worker = fork(workerPath);

      const loadTimeout = setTimeout(() => {
        console.error(`[EnginePool] Load timeout (60s) with ${libPath}`);
        resolve({ success: false, error: 'Timeout (60s)' });
      }, 60000);

      const onMessage = (msg) => {
        if (msg.type !== 'loaded') return;
        clearTimeout(loadTimeout);
        this.worker.removeListener('exit', onExit);
        this.worker.removeListener('message', onMessage);
        if (msg.status === 0) {
          resolve({ success: true, isMock: msg.isMock });
        } else {
          resolve({ success: false, error: msg.error || `status ${msg.status}` });
        }
      };

      const onExit = (code, signal) => {
        clearTimeout(loadTimeout);
        this.worker.removeListener('message', onMessage);
        this.worker = null;
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        resolve({ success: false, error: `Worker exited (${reason})` });
      };

      this.worker.on('message', onMessage);
      this.worker.once('exit', onExit);
      this.worker.send({ type: 'load', modelPath, options, libPath });
    });
  }

  async unload() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.worker) {
      console.log(`[EnginePool] Terminating worker process for model: ${this.activeModel?.name}`);
      this.worker.kill();
      this.worker = null;
    }

    this.activeModel = null;
    this.isLoaded = false;
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
      this.draftWorker = fork(workerPath);
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
    // Ensure both models are loaded
    await this.load(modelName, options);
    await this.loadDraft(draftModelName);

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

  async generate(modelName, prompt, options, onToken, cachePaths = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ modelName, prompt, options, onToken, cachePaths, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processingQueue || this.queue.length === 0) return;
    this.processingQueue = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const request = this.queue.shift();
    const { modelName, prompt, options, onToken, cachePaths, resolve, reject } = request;

    try {
      await this.load(modelName, options);

      this.activeGeneration = new Promise((genResolve, genReject) => {
        const tokenHandler = (msg) => {
          if (msg.type === 'token') {
            onToken(msg);
            if (msg.state === 2 || msg.state === 3) { // Finish or Error
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
          this.isLoaded = false;
          this.worker = null;
          this.activeModel = null;
          genReject(new Error("Worker process exited unexpectedly during generation"));
        };

        const cleanup = () => {
          if (this.worker) {
            this.worker.removeListener('message', tokenHandler);
            this.worker.removeListener('exit', exitHandler);
          }
        };

        this.worker.on('message', tokenHandler);
        this.worker.on('exit', exitHandler);

        // Send generation task (cache paths are optional; undefined fields are ignored by worker)
        this.worker.send({
          type: 'run',
          prompt,
          loadCachePath: cachePaths?.loadCachePath,
          saveCachePath: cachePaths?.saveCachePath,
        });
      });

      const result = await this.activeGeneration;
      resolve(result);
    } catch (e) {
      reject(e);
    } finally {
      this.activeGeneration = null;
      this.resetIdleTimer();
      this.processingQueue = false;
      this.processQueue(); // trigger next
    }
  }

  async abort() {
    if (this.worker && this.activeGeneration) {
      this.worker.send({ type: 'abort' });
    }
  }

  async clearCache() {
    if (this.worker) {
      this.worker.send({ type: 'clear_cache' });
    }
  }

  getStatus() {
    return {
      isLoaded: this.isLoaded,
      model: this.activeModel ? this.activeModel.name : null,
      isMock: this.activeModel ? this.activeModel.isMock : false,
      options: this.activeModel ? this.activeModel.options : null,
      pinned: this.pinned
    };
  }
}

export const pool = new EnginePool();
export default pool;
