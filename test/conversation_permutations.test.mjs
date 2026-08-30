import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import pool from '../src/pool.js';
import { dbSetModelSettings } from '../src/db.js';

describe('Model Conversations and Permutations Integration', { skip: process.platform !== 'linux' || process.arch !== 'arm64' }, () => {
  const targetModel = 'Qwen3-1.7B-GGUF/Qwen3-1.7B-UD-Q4_K_XL.gguf';
  const targetDraftModel = 'Qwen3-1.7B_eagle3/model.safetensors';
  
  before(async () => {
    // Check if the models exist before proceeding
    const modelPath = `/var/lib/orkllm/models/${targetModel}`;
    if (!fs.existsSync(modelPath)) {
      console.warn(`Target model ${modelPath} not found, skipping tests.`);
      process.exit(0);
    }
  });

  after(async () => {
    await pool.unload();
  });

  async function generateFull(modelId, messages, useEagle3, draftModelPath, enableThinking) {
    let response = '';
    const onToken = (chunk) => {
      // console.log("onToken chunk:", chunk);
      if (chunk.text) response += chunk.text;
    };
    
    // Format messages into a ChatML prompt string (matches routes.js behavior)
    let promptStr = '';
    for (const msg of messages) {
      if (msg.role === 'system') promptStr += `<|im_start|>system\n${msg.content}<|im_end|>\n`;
      else if (msg.role === 'user') promptStr += `<|im_start|>user\n${msg.content}<|im_end|>\n`;
      else if (msg.role === 'assistant') promptStr += `<|im_start|>assistant\n${msg.content}<|im_end|>\n`;
    }
    promptStr += `<|im_start|>assistant\n` + (!enableThinking ? `<think>\n\n</think>\n\n` : ``);
    
    const options = { 
      max_tokens: 50, 
      temperature: 0.1,
      messages: messages,
      enable_thinking: enableThinking
    };
    
    if (useEagle3) {
      const stats = await pool.generateEagle3(modelId, promptStr, options, onToken, { draftWeightsPath: draftModelPath });
      console.log("[Eagle3 Return]:", stats);
    } else {
      const msg = await pool.generate(modelId, promptStr, options, onToken, {});
      console.log("[Generate Return]:", msg);
    }
    return response;
  }

  const permutations = [
    { name: 'Standard (no thinking, no spec)', thinking: false, spec: 'off' },
    { name: 'Thinking Enabled (no spec)', thinking: true, spec: 'off' },
    { name: 'Speculative Decoding (eagle3, no thinking)', thinking: false, spec: 'eagle3' },
    { name: 'Thinking + Speculative Decoding (eagle3)', thinking: true, spec: 'eagle3' }
  ];

  for (const perm of permutations) {
    test(`Permutation: ${perm.name}`, async () => {
      // Configure the model settings in the DB
      dbSetModelSettings(targetModel, {
        thinking_enabled: perm.thinking,
        speculative_mode: perm.spec,
        draft_model: perm.spec === 'eagle3' ? targetDraftModel : ''
      });

      // Load the model
      pool.beginLoad(targetModel, {});
      while (!pool.isLoaded) {
        const status = pool.getStatus();
        if (!status.loading && !status.isLoaded) {
           const errStr = typeof status.loadError === 'object' ? (status.loadError.message || JSON.stringify(status.loadError)) : status.loadError;
           assert.fail(`Model failed to load: ${errStr}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }

      const useEagle3 = perm.spec === 'eagle3';

      // Turn 1
      const messages = [{ role: 'user', content: 'What is 2+2? Answer in one short sentence.' }];
      let startTime = Date.now();
      let responseContent = await generateFull(targetModel, messages, useEagle3, targetDraftModel, perm.thinking);
      let duration = Date.now() - startTime;
      
      assert.ok(responseContent.length > 0, 'Should return a response');
      console.log(`[Turn 1] Time: ${duration}ms, Resp: ${responseContent.slice(0, 40).replace(/\\n/g, ' ')}...`);

      // Turn 2
      messages.push({ role: 'assistant', content: responseContent });
      messages.push({ role: 'user', content: 'What is 3+3? Answer in one short sentence.' });
      
      startTime = Date.now();
      responseContent = await generateFull(targetModel, messages, useEagle3, targetDraftModel, perm.thinking);
      duration = Date.now() - startTime;
      
      assert.ok(responseContent.length > 0, 'Should return a response');
      console.log(`[Turn 2] Time: ${duration}ms, Resp: ${responseContent.slice(0, 40).replace(/\\n/g, ' ')}...`);
      
      await pool.unload();
    });
  }
});
