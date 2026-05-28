import { createRequire } from 'module';
import { MockEngine } from './mock_engine.js';
import { LIBRKLLMRT_PATH } from './config.js';

const require = createRequire(import.meta.url);

const isProductionHardware = process.platform === 'linux' && process.arch === 'arm64';

let nativeAddon = null;
let engine = null;
let useMock = !!process.env.ORKLLM_MOCK;

// Attempt to load native N-API addon
if (!useMock) {
  try {
    nativeAddon = require('../build/Release/orkllm_napi.node');
  } catch (e) {
    if (isProductionHardware) {
      // Keep nativeAddon null — hard error reported when 'load' message arrives
      console.error(`[Worker] Native N-API addon failed to load: ${e.message}`);
    } else {
      console.log("Could not load native N-API addon. Running in mock mode.");
      useMock = true;
    }
  }
}

process.on('message', async (msg) => {
  if (msg.type === 'load') {
    const { modelPath, options } = msg;

    if (!useMock) {
      if (!nativeAddon) {
        if (isProductionHardware) {
          process.send({ type: 'loaded', status: -1, error: 'Native N-API addon failed to load. Run npm install on the board to recompile.' });
          return;
        }
        useMock = true;
      } else {
        try {
          console.log(`Attempting to load NPU library from: ${LIBRKLLMRT_PATH}`);
          const loaded = nativeAddon.load_library(LIBRKLLMRT_PATH);
          if (!loaded) {
            if (isProductionHardware) {
              process.send({ type: 'loaded', status: -1, error: `Failed to load RKLLM library at ${LIBRKLLMRT_PATH}. Ensure librkllmrt.so is installed and ORKLLM_LIB_PATH is set correctly.` });
              return;
            }
            console.warn(`Failed to dlopen ${LIBRKLLMRT_PATH}. Falling back to mock engine.`);
            useMock = true;
          } else {
            console.log(`Initializing RKLLM model: ${modelPath}`);
            const ret = nativeAddon.init_model(modelPath, options || {});
            if (ret !== 0) {
              console.error(`[Worker] rkllm_init returned error code: ${ret}`);
              console.error(`[Worker] This usually means an RKLLM runtime version mismatch.`);
              console.error(`[Worker] The model was compiled for a different RKLLM version than what is installed on the board.`);
              console.error(`[Worker] Board runtime: check 'I rkllm: rkllm-runtime version:' above. Model must match.`);
              process.send({ type: 'loaded', status: ret, error: `rkllm_init failed (code ${ret}): likely RKLLM runtime version mismatch. See server logs.` });
              return;
            }
            engine = nativeAddon;
            process.send({ type: 'loaded', status: 0, isMock: false });
            return;
          }
        } catch (err) {
          if (isProductionHardware) {
            console.error("[Worker] Exception loading RKLLM library:", err.message);
            process.send({ type: 'loaded', status: -1, error: `Exception loading RKLLM library: ${err.message}` });
            return;
          }
          console.error("[Worker] Exception loading model natively:", err.message);
          console.error(err.stack);
          useMock = true;
        }
      }
    }

    if (useMock) {
      try {
        console.log(`Initializing mock engine for: ${modelPath}`);
        engine = new MockEngine(modelPath, options);
        process.send({ type: 'loaded', status: 0, isMock: true });
      } catch (err) {
        process.send({ type: 'loaded', status: -1, error: err.message });
      }
    }
  }

  else if (msg.type === 'run') {
    const { prompt } = msg;
    if (!engine) {
      process.send({ type: 'error', message: 'No active engine loaded' });
      return;
    }

    try {
      if (useMock) {
        await engine.run(prompt, (res) => {
          process.send({ type: 'token', ...res });
        });
      } else {
        // Native addon run blocks until completion in its internal thread,
        // but it executes callbacks on our JS thread via ThreadSafeFunction
        engine.run({ prompt }, (res) => {
          process.send({ type: 'token', ...res });
        });
      }
    } catch (err) {
      process.send({ type: 'error', message: err.message });
    }
  }

  else if (msg.type === 'abort') {
    if (engine) {
      if (engine.abort_inference) {
        engine.abort_inference();
      } else if (engine.abort) {
        engine.abort();
      }
    }
  }

  else if (msg.type === 'clear_cache') {
    if (engine) {
      if (engine.clear_kv_cache) {
        engine.clear_kv_cache();
      } else if (engine.clearKVCache) {
        engine.clearKVCache();
      }
    }
  }
});
