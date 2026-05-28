import fs from 'fs';
import path from 'path';
import { MODELS_DIR } from '../config.js';
import pool from '../pool.js';
import { recordRequest } from '../stats.js';
import { cacheKey, getCachePath, putCachePath, tmpCachePath, isCacheEnabled, getMaxContextTokens } from '../cache.js';

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
      const files = fs.readdirSync(MODELS_DIR);
      const rkllmFiles = files.filter(f => f.endsWith('.rkllm'));
      
      const data = rkllmFiles.map(file => {
        const stats = fs.statSync(path.join(MODELS_DIR, file));
        return {
          id: file,
          object: 'model',
          created: Math.floor(stats.birthtimeMs / 1000),
          owned_by: 'orkllm',
          size: stats.size
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
      max_tokens = 512
    } = request.body || {};

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
    const cacheEnabled = isCacheEnabled();
    let loadCachePath = null;
    let saveCachePath = null;
    let prefixMessages = trimmed;

    if (cacheEnabled && trimmed.length >= 2) {
      const prefixMsgs = trimmed.slice(0, -1); // everything except last (new user) message
      const pKey       = cacheKey(model, prefixMsgs);
      const hit        = getCachePath(pKey);

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

    const completionId = 'chatcmpl-' + Math.random().toString(36).substring(2, 15);
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const onToken = (msg) => {
        if (msg.text) {
          const chunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: msg.text },
              finish_reason: null
            }]
          };
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      };

       try {
        const cachePaths = loadCachePath || saveCachePath ? { loadCachePath, saveCachePath } : {};
        const finalResult = await pool.generate(model, prompt, modelOptions, onToken, cachePaths);
        recordRequest(finalResult.perf);
        if (cacheEnabled && saveCachePath) {
          const nextKey = cacheKey(model, trimmed);
          putCachePath(nextKey, saveCachePath);
        }
        
        const stopChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }],
          perf: finalResult.perf
        };
        reply.raw.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (err) {
        const errorChunk = {
          error: { message: err.message, type: 'invalid_request_error' }
        };
        reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        reply.raw.end();
      }
      return reply;
    } else {
      let accumulatedText = "";
      const onToken = (msg) => {
        if (msg.text) accumulatedText += msg.text;
      };

      try {
        const cachePaths = loadCachePath || saveCachePath ? { loadCachePath, saveCachePath } : {};
        const finalResult = await pool.generate(model, prompt, modelOptions, onToken, cachePaths);
        recordRequest(finalResult.perf);
        if (cacheEnabled && saveCachePath) {
          const nextKey = cacheKey(model, trimmed);
          putCachePath(nextKey, saveCachePath);
        }
        return {
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: accumulatedText },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: finalResult.perf?.prefill_tokens || 0,
            completion_tokens: finalResult.perf?.generate_tokens || 0,
            total_tokens: (finalResult.perf?.prefill_tokens || 0) + (finalResult.perf?.generate_tokens || 0)
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
