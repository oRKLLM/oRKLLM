import fs from 'fs';
import { createRequire } from 'module';
import { MockEngine } from './mock_engine.js';
import { LIBRKLLMRT_PATH } from './config.js';

const require = createRequire(import.meta.url);

const isProductionHardware = process.platform === 'linux' && process.arch === 'arm64';

// Backend-specific addon cache — loaded lazily per 'load' message
const addonCache = {};

function loadAddon(name) {
  if (addonCache[name]) return addonCache[name];
  try {
    addonCache[name] = require(`../build/Release/${name}.node`);
    return addonCache[name];
  } catch (e) {
    if (isProductionHardware) {
      console.error(`[Worker] Native addon ${name} failed to load: ${e.message}`);
    }
    return null;
  }
}

let engine = null;
let useMock = !!process.env.ORKLLM_MOCK;

process.on('message', async (msg) => {
  if (msg.type === 'load') {
    const { modelPath, options, libPath, backend = 'rkllm' } = msg;

    // Select addon and default lib path based on backend
    const addonName = backend === 'llama' ? 'orkllm_llama_napi' : 'orkllm_napi';
    const resolvedLibPath = libPath || LIBRKLLMRT_PATH;

    let nativeAddon = null;
    if (!useMock) {
      nativeAddon = loadAddon(addonName);
      if (!nativeAddon && !isProductionHardware) {
        console.log(`Could not load native addon ${addonName}. Running in mock mode.`);
        useMock = true;
      }
    }

    if (!useMock) {
      if (!nativeAddon) {
        process.send({ type: 'loaded', status: -1, error: `Native addon ${addonName} failed to load. Run npm install on the board to recompile.` });
        return;
      }
      try {
        console.log(`[Worker:${backend}] Loading library: ${resolvedLibPath}`);
        const loaded = nativeAddon.load_library(resolvedLibPath);
        if (!loaded) {
          if (isProductionHardware) {
            process.send({ type: 'loaded', status: -1, error: `Failed to dlopen ${resolvedLibPath}` });
            return;
          }
          console.warn(`Failed to dlopen ${resolvedLibPath}. Falling back to mock engine.`);
          useMock = true;
        } else {
          // PACK-BACKED LOAD. llama.cpp needs a gguf to open, and for a pack that gguf is the SPARSE
          // one rebuilt from the pack's own embedded metadata: header/KV/tensor-info verbatim (so stock
          // llama.cpp loads it with no loader change) and the packed tensors left as file HOLES that
          // ork serves. Extract once and keep it next to the pack — this is the same file, and the same
          // name, the runtime's own build-time stub would have written.
          let loadPath = modelPath;
          if (options?.orkpack) {
            const stub = options.stub_path || (options.orkpack + '.gguf');
            let haveStub = false;
            try { haveStub = fs.statSync(stub).size > 0; } catch {}
            if (!haveStub) {
              if (typeof nativeAddon.extract_orkpack_gguf !== 'function') {
                process.send({ type: 'loaded', status: -1, error:
                  'This llama runtime cannot extract a gguf from a .orkpack (needs a build with ' +
                  'ggml_backend_ork_extract_gguf). Update the llama runtime, or serve the source GGUF.' });
                return;
              }
              console.log(`[Worker:llama] extracting sparse gguf from pack → ${stub}`);
              if (!nativeAddon.extract_orkpack_gguf(options.orkpack, stub)) {
                // Two different causes reach here — the runtime cannot do it, or the pack predates the
                // embedded-metadata format — and from JS they are indistinguishable. The addon logs
                // which one to stderr (see resolve_ork_extract), so point at that rather than guess:
                // an earlier version asserted "pre-v6 pack" and sent the diagnosis the wrong way.
                process.send({ type: 'loaded', status: -1, error:
                  `Could not extract a gguf from ${options.orkpack}. Either this llama runtime ` +
                  'predates ggml_backend_ork_extract_gguf, or the pack has no embedded metadata ' +
                  '(pre-v6) — the server log carries an [ork] line saying which.' });
                return;
              }
            }
            loadPath = stub;
          }
          console.log(`[Worker:${backend}] Initializing model: ${loadPath}`);
          const ret = nativeAddon.init_model(loadPath, options || {});
          if (ret !== 0) {
            const msg = backend === 'rkllm'
              ? `rkllm_init failed (code ${ret}): likely RKLLM runtime version mismatch. See server logs.`
              : `llama_init_from_model failed (code ${ret}). Check model format and library compatibility.`;
            console.error(`[Worker:${backend}] init_model returned ${ret}`);
            process.send({ type: 'loaded', status: ret, error: msg });
            return;
          }
          engine = nativeAddon;
          process.send({ type: 'loaded', status: 0, isMock: false });
          return;
        }
      } catch (err) {
        if (isProductionHardware) {
          console.error(`[Worker:${backend}] Exception:`, err.message);
          process.send({ type: 'loaded', status: -1, error: `Exception: ${err.message}` });
          return;
        }
        console.error(`[Worker:${backend}] Exception loading model natively:`, err.message);
        useMock = true;
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
    const { prompt, loadCachePath, saveCachePath, infer_mode, token_ids, keep_history, options } = msg;
    if (!engine) {
      process.send({ type: 'error', message: 'No active engine loaded' });
      return;
    }

    try {
      if (useMock) {
        await engine.run(prompt || '', (res) => {
          process.send({ type: 'token', ...res });
        });
      } else {
        // infer_mode: 0=generate, 1=get_last_hidden_layer, 2=get_logits (Eagle-3 verification)
        // token_ids: Int32Array — when present, uses RKLLM_INPUT_TOKEN instead of prompt string
        // keep_history: true — append to existing NPU KV cache (Eagle-3 pipelined loop)
        engine.run({
          prompt: prompt || '',
          loadCachePath,
          saveCachePath,
          infer_mode: infer_mode || 0,
          token_ids: token_ids ? Int32Array.from(token_ids) : undefined,
          keep_history: !!keep_history,
          // Forwarded per-request params; read by the llama addon, ignored by rkllm.
          max_new_tokens:    options?.max_new_tokens,
          temperature:       options?.temperature,
          top_p:             options?.top_p,
          top_k:             options?.top_k,
          min_p:             options?.min_p,
          repeat_penalty:    options?.repeat_penalty,
          presence_penalty:  options?.presence_penalty,
          frequency_penalty: options?.frequency_penalty,
          mirostat:          options?.mirostat,
          mirostat_tau:      options?.mirostat_tau,
          mirostat_eta:      options?.mirostat_eta,
          // Structured messages for llama.cpp chat templating (non-ChatML models).
          messages:          options?.messages,
          // Thinking toggle — addon closes a reasoning template's <think> when off.
          enable_thinking:   options?.enable_thinking,
        }, (res) => {
          process.send({ type: 'token', ...res });
        });
      }
    } catch (err) {
      process.send({ type: 'error', message: err.message });
    }
  }

  else if (msg.type === 'run_dflash') {
    // DFlash speculative decode: the llama addon loads the draft co-resident (ctx_other=target) and runs
    // the whole block-draft/verify loop natively, streaming tokens back the same way as 'run'.
    const { prompt, draft_path, block_size, options } = msg;
    if (!engine || !engine.run_dflash) {
      process.send({ type: 'error', message: 'DFlash not supported by this engine/runtime' });
      return;
    }
    try {
      engine.run_dflash({
        prompt: prompt || '',
        draft_path,
        block_size: block_size || 16,
        max_new_tokens: options?.max_new_tokens,
      }, (res) => { process.send({ type: 'token', ...res }); });
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

  else if (msg.type === 'rollback_kv_cache') {
    if (engine) {
      if (engine.rollback_kv_cache) {
        engine.rollback_kv_cache(msg.pos, msg.seq_id);
      }
    }
  }
});
