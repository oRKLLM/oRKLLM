import { fork } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MODELS_DIR } from './config.js';
import { dbGetSetting, dbSetSetting } from './db.js';

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
    if (!pinned) {
      this.resetIdleTimer(); // restart idle countdown when unpinned
    } else {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    }
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

      const workerPath = path.join(__dirname, 'worker.js');
      this.worker = fork(workerPath);

      return new Promise((resolve, reject) => {
        const loadTimeout = setTimeout(() => {
          console.error(`[EnginePool] Load timeout (60s) for model: ${modelName}`);
          this.unload();
          reject(new Error("Timeout loading model (60s) — check server logs for details"));
        }, 60000);

        const onMessage = (msg) => {
          if (msg.type === 'loaded') {
            clearTimeout(loadTimeout);
            this.worker.removeListener('exit', onExit);
            this.worker.removeListener('message', onMessage);
            if (msg.status === 0) {
              this.isLoaded = true;
              this.activeModel = {
                name: modelName,
                path: modelPath,
                options,
                isMock: msg.isMock
              };
              console.log(`[EnginePool] Model loaded successfully: ${modelName} (isMock: ${msg.isMock})`);
              this.resetIdleTimer();
              resolve({ status: 0, activeModel: this.activeModel });
            } else {
              console.error(`[EnginePool] Model init failed for ${modelName}: ${msg.error}`);
              this.unload();
              reject(new Error(msg.error || `Failed to load model: status ${msg.status}`));
            }
          }
        };

        const onExit = (code, signal) => {
          clearTimeout(loadTimeout);
          this.worker.removeListener('message', onMessage);
          const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
          console.error(`[EnginePool] Worker process crashed during load of ${modelName}: ${reason}`);
          console.error(`[EnginePool] Possible causes: RKLLM version mismatch, corrupt model file, or insufficient NPU memory.`);
          this.worker = null;
          this.isLoaded = false;
          this.activeModel = null;
          reject(new Error(`Worker crashed during model load (${reason}). Check logs — possible RKLLM version mismatch.`));
        };

        this.worker.on('message', onMessage);
        this.worker.once('exit', onExit);

        this.worker.send({
          type: 'load',
          modelPath,
          options
        });
      });
    })();

    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
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
