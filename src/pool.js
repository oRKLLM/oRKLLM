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
        new Error(`No compatible rkllm runtime found for ${modelName}${versionHint}. Tried: ${candidates.join(', ')}`),
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
