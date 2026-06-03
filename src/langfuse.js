// Langfuse observability — uses @langfuse/client (official SDK v5).
//
// Configuration priority (per @langfuse/client convention):
//   1. DB settings  (Site Settings → Observability UI)
//   2. Environment variables:
//        LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
//
// The singleton is recreated if settings change, so edits take effect
// without a server restart.

import Langfuse from 'langfuse-node';
import { dbGetSetting } from './db.js';

let _client     = null;
let _configHash = null;

function currentConfig() {
  // Check DB first, fall back to env vars that @langfuse/client also reads natively
  const enabled =
    dbGetSetting('langfuse_enabled') === '1' ||
    process.env.LANGFUSE_ENABLED === 'true';
  if (!enabled) return null;

  const publicKey = dbGetSetting('langfuse_public_key') || process.env.LANGFUSE_PUBLIC_KEY || '';
  const secretKey = dbGetSetting('langfuse_secret_key') || process.env.LANGFUSE_SECRET_KEY || '';
  const baseUrl   = dbGetSetting('langfuse_base_url')   || process.env.LANGFUSE_BASE_URL   || '';

  if (!publicKey || !secretKey || !baseUrl) return null;
  return { publicKey, secretKey, baseUrl };
}

export function getLangfuse() {
  const cfg = currentConfig();
  if (!cfg) { _client = null; _configHash = null; return null; }

  const hash = `${cfg.baseUrl}|${cfg.publicKey}|${cfg.secretKey}`;
  if (hash !== _configHash) {
    _client = new Langfuse({
      publicKey:     cfg.publicKey,
      secretKey:     cfg.secretKey,
      baseUrl:       cfg.baseUrl,
      flushAt:       15,
      flushInterval: 5000,
    });
    _configHash = hash;
    console.log(`[Langfuse] Client initialised → ${cfg.baseUrl}`);
  }
  return _client;
}

// ── Per-request inference tracer ──────────────────────────────────────────
// Creates one Trace + one Generation per /v1/chat/completions call.
// Returns { end(result), traceId } — call .end() after inference completes.
// Returns a no-op object when Langfuse is not configured.

export function traceInference({ model, messages, modelParameters, metadata = {} }) {
  const lf = getLangfuse();
  if (!lf) return { end: () => {}, traceId: null };

  const trace = lf.trace({
    name:     'chat-completion',
    input:    messages,
    metadata: { model, ...metadata },
    tags:     ['orkllm'],
  });

  const generation = trace.generation({
    name:            'rkllm-generate',
    model,
    input:           messages,
    modelParameters,
    startTime:       new Date(),
  });

  return {
    traceId: trace.id,

    end({ output, prefillTokens, generateTokens, prefillMs, generateMs, cacheHit, error } = {}) {
      if (error) {
        generation.end({ level: 'ERROR', statusMessage: String(error) });
        trace.update({ output: { error: String(error) } });
      } else {
        generation.end({
          output,
          usage: {
            input:  prefillTokens  ?? 0,
            output: generateTokens ?? 0,
            total:  (prefillTokens ?? 0) + (generateTokens ?? 0),
          },
          metadata: {
            prefill_time_ms:  prefillMs,
            generate_time_ms: generateMs,
            cache_hit:        cacheHit,
          },
        });
        trace.update({ output });
      }
      // Flush in background — never block the HTTP response
      lf.flushAsync().catch(() => {});
    },
  };
}
