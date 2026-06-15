import fs from 'fs';
import path from 'path';
import { MODELS_DIR, parseRuntimeVersion } from '../config.js';
import pool from '../pool.js';
import { recordRequest } from '../stats.js';
import { dbGetModelSettings, dbSetModelSettings, dbGetSetting, dbListEnabledMcpServers } from '../db.js';
import { cacheKey, getCachePath, putCachePath, tmpCachePath, isCacheEnabled, getMaxContextTokens } from '../cache.js';
import { traceInference } from '../langfuse.js';
import { getAggregatedTools } from '../mcp.js';
import { resolveWithTools } from '../mcp_inference.js';


// Rough token estimate: ~4 chars per token
function estimateTokens(messages) {
  return messages.reduce((n, m) => n + Math.ceil((m.content?.length ?? 0) / 4) + 4, 0);
}

// Drop oldest non-system messages until the conversation fits within maxTokens
function trimMessages(messages, maxTokens) {
  const sys  = messages.filter(m => m.role === 'system');
  let conv   = messages.filter(m => m.role !== 'system');
  while (estimateTokens([...sys, ...conv]) > maxTokens && conv.length > 1) {
    conv.shift();
  }
  return [...sys, ...conv];
}

export default async function apiRoutes(fastify, options) {
  
  // GET /v1/models
  fastify.get('/models', async (request, reply) => {
    try {
      // Recursively collect .rkllm and .gguf files, using paths relative to MODELS_DIR as IDs
      function scanDir(dir, prefix = '') {
        const results = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            results.push(...scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
          } else if (entry.name.endsWith('.rkllm') || entry.name.endsWith('.gguf')) {
            results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
          }
        }
        return results;
      }
      const modelFiles = scanDir(MODELS_DIR);

      const data = modelFiles.map(file => {
        const stats = fs.statSync(path.join(MODELS_DIR, file));
        const basename = path.basename(file);
        const isGguf = basename.endsWith('.gguf');
        const runtime = isGguf ? 'llama' : 'rkllm';

        // Persist parsed runtime version into model_settings if not already stored (rkllm only)
        const runtimeVersion = isGguf ? null : parseRuntimeVersion(basename);
        if (runtimeVersion) {
          const existing = dbGetModelSettings(file) || {};
          if (!existing.runtimeVersion) {
            dbSetModelSettings(file, { ...existing, runtimeVersion });
          }
        }

        return {
          id: file,
          object: 'model',
          created: Math.floor(stats.birthtimeMs / 1000),
          owned_by: 'orkllm',
          size: stats.size,
          runtime,
          runtimeVersion: runtimeVersion ?? (dbGetModelSettings(file)?.runtimeVersion ?? null),
        };
      });

      return {
        object: 'list',
        data
      };
    } catch (e) {
      reply.status(500).send({ error: e.message });
    }
  });

  // POST /v1/chat/completions
  fastify.post('/chat/completions', async (request, reply) => {
    const {
      model,
      messages,
      stream = false,
      temperature = 0.8,
      top_p = 0.9,
      top_k = 40,
      max_tokens = 512,
      mcp_tools = undefined,
      no_cache = false,
    } = request.body || {};

    // Per-request MCP tool selection (sent by the Chat page's tool picker).
    // An array — even empty — is an explicit override: run the tool-use loop
    // scoped to exactly these tool names, regardless of the global
    // `mcp_inference_enabled` setting. `undefined` (field absent) falls back to
    // the global setting (all enabled tools) so external API clients are
    // unaffected.
    const mcpToolsRequested = Array.isArray(mcp_tools) ? mcp_tools : null;

    if (!model) {
      return reply.status(400).send({ error: "Missing required field 'model'" });
    }
    if (!messages || !Array.isArray(messages)) {
      return reply.status(400).send({ error: "Missing or invalid field 'messages'" });
    }

    // Sliding window: trim oldest non-system turns if conversation is too long
    const maxCtx = getMaxContextTokens();
    const trimmed = trimMessages(messages, maxCtx);

    // Prefix cache: check if we have KV state for all messages except the new user turn
    // Callers can set no_cache:true (e.g. benchmark runs) to force fresh prefill.
    const cacheEnabled = isCacheEnabled() && !no_cache;
    let loadCachePath = null;
    let saveCachePath = null;
    let prefixMessages = trimmed;

    if (cacheEnabled && trimmed.length >= 2) {
      const prefixMsgs = trimmed.slice(0, -1); // everything except last (new user) message
      const pKey       = cacheKey(model, prefixMsgs);
      const hit        = await getCachePath(pKey);  // async: dequantizes if needed

      // Key for the state we'll save after this response
      const nextKey    = cacheKey(model, trimmed);
      saveCachePath    = tmpCachePath(nextKey);

      if (hit) {
        loadCachePath   = hit;
        prefixMessages  = trimmed.slice(-1); // only the new user message
        console.log(`[Cache] HIT ${pKey} → sending only ${prefixMessages.length} message(s)`);
      } else {
        console.log(`[Cache] MISS ${pKey}`);
      }
    }

    // Convert (possibly shortened) messages to ChatML format
    function formatMessages(msgs) {
      let p = "";
      for (const msg of msgs) {
        if (msg.role === 'system')    p += `<|im_start|>system\n${msg.content}<|im_end|>\n`;
        else if (msg.role === 'user') p += `<|im_start|>user\n${msg.content}<|im_end|>\n`;
        else if (msg.role === 'assistant') p += `<|im_start|>assistant\n${msg.content}<|im_end|>\n`;
        else if (msg.role === 'tool') p += `<|im_start|>tool\n${msg.content}<|im_end|>\n`;
      }
      return p + `<|im_start|>assistant\n`;
    }
    const prompt = formatMessages(prefixMessages);

    const modelOptions = {
      temperature,
      top_p,
      top_k,
      max_new_tokens: max_tokens
    };

    // Apply per-model settings overrides from model_settings JSON
    const saved = dbGetModelSettings(model) || {};
    if (saved.force_sampling) {
      // Force sampling: stored values override per-request params
      if (saved.temperature != null)       modelOptions.temperature       = saved.temperature;
      if (saved.top_p != null)             modelOptions.top_p             = saved.top_p;
      if (saved.top_k != null)             modelOptions.top_k             = saved.top_k;
      if (saved.max_new_tokens != null)    modelOptions.max_new_tokens    = saved.max_new_tokens;
      if (saved.rep_penalty != null)       modelOptions.repeat_penalty    = saved.rep_penalty;
    }
    if (saved.presence_penalty != null)    modelOptions.presence_penalty  = saved.presence_penalty;
    if (saved.frequency_penalty != null)   modelOptions.frequency_penalty = saved.frequency_penalty;
    if (saved.mirostat)                    modelOptions.mirostat          = saved.mirostat;
    if (saved.mirostat_tau != null)        modelOptions.mirostat_tau      = saved.mirostat_tau;
    if (saved.mirostat_eta != null)        modelOptions.mirostat_eta      = saved.mirostat_eta;
    if (saved.ctx_window != null)          modelOptions.max_context_len   = saved.ctx_window;
    if (saved.thinking_enabled)            modelOptions.enable_thinking   = true;

    // Speculative-decode status from the model's saved settings. Computed once
    // and attached to the stop chunk of every response path (normal, eagle-3,
    // and the MCP tool loop) so the benchmark records what's configured.
    // hardware = the draft compute target.
    const specDecode =
      saved.speculative_mode === 'eagle3'
        ? { enabled: true, strategy: 'eagle3', hardware: saved.eagle3_strategy || 'cpu', k: saved.spec_draft_tokens || 8 }
        : (saved.speculative_mode === 'speculative' && saved.draft_model)
          ? { enabled: true, strategy: 'speculative', hardware: 'npu', draftModel: saved.draft_model, k: saved.spec_draft_tokens || 8 }
          : { enabled: false, strategy: 'none', hardware: null };

    const completionId = 'chatcmpl-' + Math.random().toString(36).substring(2, 15);
    const created = Math.floor(Date.now() / 1000);

    const traceParams = {
      model,
      messages: trimmed,
      modelParameters: {
        temperature:    modelOptions.temperature,
        top_p:          modelOptions.top_p,
        top_k:          modelOptions.top_k,
        max_new_tokens: modelOptions.max_new_tokens,
      },
      metadata: { cache_hit: !!loadCachePath },
    };

    // ── MCP tool use ─────────────────────────────────────────────────────
    // Run the prompt-driven tool loop (instead of a single generation) when
    // either the global `mcp_inference_enabled` setting is on, OR this request
    // carries an explicit `mcp_tools` selection (the Chat page's per-chat tool
    // picker). The per-request selection wins: an empty array means "no tools"
    // and skips the loop entirely. Prefix cache and speculative paths are
    // bypassed for tool rounds (correctness over speed).
    const mcpLoopEnabled = mcpToolsRequested
      ? mcpToolsRequested.length > 0
      : dbGetSetting('mcp_inference_enabled') === '1';
    if (mcpLoopEnabled) {
      let mcpTools = null;
      try {
        const servers = dbListEnabledMcpServers();
        if (servers.length > 0) {
          const agg = await getAggregatedTools(servers);
          // Scope to the requested subset when the Chat page sent one.
          if (mcpToolsRequested) {
            const want = new Set(mcpToolsRequested);
            const tools = agg.tools.filter(t => want.has(t.function.name));
            const lookup = new Map([...agg.lookup].filter(([name]) => want.has(name)));
            if (tools.length > 0) mcpTools = { tools, lookup };
          } else if (agg.tools.length > 0) {
            mcpTools = agg;
          }
        }
      } catch (e) {
        console.error('[MCP] Tool aggregation failed:', e.message);
      }

      if (mcpTools) {
        const generate = async (p) => {
          let t = '';
          const r = await pool.generate(model, p, modelOptions, (m) => { if (m.text) t += m.text; }, {});
          return { text: t, perf: r.perf };
        };
        let resolved;
        try {
          resolved = await resolveWithTools({
            messages: trimmed, tools: mcpTools.tools, lookup: mcpTools.lookup, formatMessages, generate,
          });
        } catch (err) {
          if (stream) {
            reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
            reply.raw.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } })}\n\n`);
            reply.raw.end();
            return reply;
          }
          return reply.status(500).send({ error: err.message });
        }
        recordRequest(resolved.perf);
        const finalText = resolved.finalText || '';

        if (stream) {
          reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          // Emit the resolved answer as word chunks to preserve the streaming contract.
          for (const piece of finalText.match(/\S+\s*/g) || [finalText]) {
            reply.raw.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
          }
          reply.raw.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], perf: resolved.perf, mcp_tool_calls: resolved.toolCalls, specDecode })}\n\n`);
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
          return reply;
        }
        return {
          id: completionId, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens:     resolved.perf?.prefill_tokens  || 0,
            completion_tokens: resolved.perf?.generate_tokens || 0,
            total_tokens:      (resolved.perf?.prefill_tokens || 0) + (resolved.perf?.generate_tokens || 0),
          },
          perf: resolved.perf,
          mcp_tool_calls: resolved.toolCalls,
        };
      }
    }

    if (stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Disable proxy buffering (nginx/tailscale) so SSE tokens flush live
        // instead of being released all at once when the response ends.
        'X-Accel-Buffering': 'no'
      });

      await traceInference(traceParams, async (gen) => {
        let streamText = '';
        const onToken = (msg) => {
          if (msg.text) {
            streamText += msg.text;
            const chunk = {
              id: completionId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: msg.text }, finish_reason: null }]
            };
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        };

        try {
          const cachePaths = loadCachePath || saveCachePath ? { loadCachePath, saveCachePath } : {};
          const isLlamaModel = model.endsWith('.gguf');
          const specMode    = isLlamaModel ? null : saved.speculative_mode;
          const draftModel  = saved.draft_model;
          const specK       = saved.spec_draft_tokens || 8;
          const eagle3Weights = saved.eagle3_weights_path ?? null;
          let finalResult;
          if (specMode === 'eagle3') {
            // Eagle-3: pipelined GET_HIDDEN_LAYER + GET_LOGITS + Mali Vulkan draft
            console.log(`[Eagle-3] target=${model} k=${specK} draft=${saved.eagle3_strategy || 'cpu'}`);
            finalResult = await pool.generateEagle3(model, prompt, modelOptions, onToken, {
              k:                specK,
              draftStrategy:    saved.eagle3_strategy || 'cpu',
              draftWeightsPath: eagle3Weights,
            });
          } else if (specMode === 'speculative' && draftModel) {
            console.log(`[Spec] Using speculative decode: target=${model} draft=${draftModel} k=${specK}`);
            await pool.generateSpeculative(model, draftModel, prompt, modelOptions, onToken, specK);
            finalResult = { perf: {} };
          } else {
            finalResult = await pool.generate(model, prompt, modelOptions, onToken, cachePaths);
          }
          recordRequest(finalResult.perf);
          if (cacheEnabled && saveCachePath)
            putCachePath(cacheKey(model, trimmed), saveCachePath, saved.kv_cache_quant ?? null);

          gen.setOutput(streamText, {
            promptTokens:    finalResult.perf?.prefill_tokens,
            completionTokens: finalResult.perf?.generate_tokens,
            prefillMs:       finalResult.perf?.prefill_time_ms,
            generateMs:      finalResult.perf?.generate_time_ms,
            cacheHit:        !!loadCachePath,
          });

          const stopChunk = {
            id: completionId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            perf: finalResult.perf,
            specDecode
          };
          reply.raw.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        } catch (err) {
          reply.raw.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } })}\n\n`);
          reply.raw.end();
          throw err;
        }
      }).catch(() => {});

      return reply;
    } else {
      let accumulatedText = '';
      const onToken = (msg) => { if (msg.text) accumulatedText += msg.text; };

      try {
        const finalResult = await traceInference(traceParams, async (gen) => {
          const cachePaths  = loadCachePath || saveCachePath ? { loadCachePath, saveCachePath } : {};
          const specMode2   = model.endsWith('.gguf') ? null : saved.speculative_mode;
          let result;
          if (specMode2 === 'eagle3') {
            result = await pool.generateEagle3(model, prompt, modelOptions, onToken, {
              k:             saved.spec_draft_tokens || 8,
              draftStrategy: saved.eagle3_strategy || 'cpu',
              draftWeightsPath: saved.eagle3_weights_path ?? null,
            }) ?? { perf: {} };
          } else {
            result = await pool.generate(model, prompt, modelOptions, onToken, cachePaths);
          }
          recordRequest(result.perf);
          if (cacheEnabled && saveCachePath)
            putCachePath(cacheKey(model, trimmed), saveCachePath, saved.kv_cache_quant ?? null);

          gen.setOutput(accumulatedText, {
            promptTokens:    result.perf?.prefill_tokens,
            completionTokens: result.perf?.generate_tokens,
            prefillMs:       result.perf?.prefill_time_ms,
            generateMs:      result.perf?.generate_time_ms,
            cacheHit:        !!loadCachePath,
          });
          return result;
        });

        return {
          id: completionId, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: accumulatedText }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens:     finalResult.perf?.prefill_tokens     || 0,
            completion_tokens: finalResult.perf?.generate_tokens    || 0,
            total_tokens:      (finalResult.perf?.prefill_tokens || 0) + (finalResult.perf?.generate_tokens || 0),
          },
          perf: finalResult.perf
        };
      } catch (err) {
        return reply.status(500).send({ error: err.message });
      }
    }
  });

  // POST /v1/embeddings
  fastify.post('/embeddings', async (request, reply) => {
    const { model, input } = request.body || {};
    if (!input) {
      return reply.status(400).send({ error: "Missing required field 'input'" });
    }
    
    // Simple 1536-dimensional mock embedding vector
    const embedding = Array.from({ length: 1536 }, () => Math.random() * 2 - 1);
    
    return {
      object: 'list',
      data: [{
        object: 'embedding',
        index: 0,
        embedding
      }],
      model: model || 'mock-embedding-model',
      usage: {
        prompt_tokens: 0,
        total_tokens: 0
      }
    };
  });
}
