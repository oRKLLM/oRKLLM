// Langfuse inference tracing — @langfuse/tracing + @langfuse/otel (v5).
//
// traceInference(params, inferFn) wraps an inference call in a
// Langfuse Trace + Generation observation.  inferFn receives a `gen`
// helper with a .setOutput() method for recording results.
// Returns whatever inferFn returns, or the inferFn's return value on error.

import { startActiveObservation } from '@langfuse/tracing';
import { langfuseSpanProcessor, isTracingEnabled } from './instrumentation.js';

export async function traceInference(
  { model, messages, modelParameters, metadata = {} },
  inferFn
) {
  // No-op when tracing is disabled
  if (!isTracingEnabled()) return inferFn({ setOutput: () => {} });

  return startActiveObservation(
    'chat-completion',
    async (trace) => {
      // Root trace — set input and metadata
      trace.update({
        input:    messages,
        metadata: { model, ...metadata },
      });

      // Nested generation span for the LLM call
      return startActiveObservation(
        'rkllm-generate',
        async (gen) => {
          gen.update({
            model,
            input:           messages,
            modelParameters: modelParameters ?? {},
          });

          // Helper passed to the caller for recording output + usage
          const genHelper = {
            setOutput(output, {
              promptTokens = 0,
              completionTokens = 0,
              prefillMs,
              generateMs,
              cacheHit,
            } = {}) {
              gen.update({
                output,
                usageDetails: {
                  input:  promptTokens,
                  output: completionTokens,
                  total:  promptTokens + completionTokens,
                },
                metadata: {
                  prefill_time_ms:  prefillMs,
                  generate_time_ms: generateMs,
                  cache_hit:        cacheHit,
                },
              });
            },
          };

          const result = await inferFn(genHelper);

          // Mirror output on trace root for quick visibility
          trace.update({
            output: typeof result === 'string' ? result : undefined,
          });

          return result;
        },
        { asType: 'generation' }
      );
    }
  ).finally(() => {
    langfuseSpanProcessor?.forceFlush().catch(() => {});
  });
}
