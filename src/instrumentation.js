// Langfuse OpenTelemetry instrumentation.
// MUST be imported before any other application code in server.js.
//
// Credentials are read from DB settings at startup (same priority as all
// other oRKLLM config). Changes take effect on server restart.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { dbGetSetting } from './db.js';

const publicKey = dbGetSetting('langfuse_public_key') || process.env.LANGFUSE_PUBLIC_KEY || '';
const secretKey = dbGetSetting('langfuse_secret_key') || process.env.LANGFUSE_SECRET_KEY || '';
const baseUrl   = dbGetSetting('langfuse_base_url')   || process.env.LANGFUSE_BASE_URL   || '';
const enabled   = dbGetSetting('langfuse_enabled') === '1';

// Export the processor so routes can call forceFlush() after streaming
export let langfuseSpanProcessor = null;

if (enabled && publicKey && secretKey && baseUrl) {
  langfuseSpanProcessor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });

  const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
  sdk.start();

  console.log(`[Langfuse] OTel tracing initialised → ${baseUrl}`);
} else {
  console.log('[Langfuse] Tracing disabled (not configured or disabled in settings)');
}

export const isTracingEnabled = () => langfuseSpanProcessor !== null;
