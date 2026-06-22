import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);

describe('llama.cpp native integration', { skip: process.platform !== 'linux' || process.arch !== 'arm64' }, () => {
  test('init_model successfully allocates a context without asserting', async () => {
    // Check for native addon
    let addon;
    try {
      addon = require('../build/Release/orkllm_llama_napi.node');
    } catch (e) {
      assert.fail('orkllm_llama_napi.node not built or missing: ' + e.message);
    }

    // Locate libllama.so
    const libPath = '/var/lib/orkllm/llama-runtime/libllama.so';
    if (!fs.existsSync(libPath)) {
      assert.fail(`libllama.so not found at ${libPath}`);
    }

    // Load library
    const loaded = addon.load_library(libPath);
    assert.equal(loaded, true, 'Failed to load libllama.so via dlopen');

    // Use an existing test model on the SBC
    const modelPath = '/var/lib/orkllm/models/Netsnake/Qwen3-0.6B-Q4_0-GGUF/qwen3-0.6b-q4_0.gguf';
    if (!fs.existsSync(modelPath)) {
      assert.fail(`Test model not found at ${modelPath}. This test expects a small model to be present on the SBC.`);
    }

    // Attempt to initialize the model (this will trigger context allocation)
    // If there is an upstream mismatch like the n_outputs_max assertion, this will SIGABRT the process
    // and the node test runner will fail the test.
    const slotId = addon.init_model(modelPath, {
      max_context_len: 256,
      n_gpu_layers: 0,
      use_mmap: false
    });

    assert.ok(slotId >= 0, `init_model failed, returned ${slotId}`);

    // Clean up
    addon.unload_model(slotId);
  });
});
