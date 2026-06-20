import { reactive } from 'vue';

// Shared benchmark state — lives at module scope (like notify.js) so it
// survives navigating away from /bench and back. The run loop writes here
// regardless of whether the Bench component is currently mounted.

export const DEFAULT_PROMPT = 'Explain the theory of relativity in detail, covering both the special and general theories, their implications, and practical applications in modern technology.';

export const benchState = reactive({
  benchPrompt: DEFAULT_PROMPT,
  maxTokens: 512,
  running: false,
  benchOutput: '',
  results: null,
  historyDirty: false, // set true after a run is persisted so the view re-fetches
});

let abortController = null;

export async function runBenchmark(model) {
  if (!model || benchState.running) return;

  benchState.running = true;
  benchState.benchOutput = '';
  benchState.results = null;
  abortController = new AbortController();

  const t0 = performance.now();
  let ttft = null;
  let genTokens = 0;
  let prefillTimeMs = 0;
  let prefillTokens = 0;
  let genTimeMs = 0;
  let specDecode = null;   // { enabled, strategy, hardware, k } from the stop chunk

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: benchState.benchPrompt }],
        stream: true,
        max_tokens: benchState.maxTokens,
        temperature: 0.7,
        top_p: 0.9,
        no_cache: true,
      })
    });

    if (!res.ok) {
      const data = await res.json();
      benchState.benchOutput = `Error: ${data.error || 'Request failed'}`;
      benchState.running = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine.startsWith('data: ')) continue;

        const dataStr = cleanLine.substring(6);
        if (dataStr === '[DONE]') continue;

        try {
          const obj = JSON.parse(dataStr);

          if (obj.choices?.[0]?.delta?.content) {
            if (ttft === null) {
              ttft = performance.now() - t0;
            }
            benchState.benchOutput += obj.choices[0].delta.content;
            genTokens++;
          }

          if (obj.perf) {
            // Only update from non-zero values — the llama backend sends
            // prefill stats in an early callback and generate stats in the
            // final callback (each with the other zeroed out), so we must
            // not overwrite a non-zero value with 0.
            if (obj.perf.prefill_time_ms > 0) prefillTimeMs = obj.perf.prefill_time_ms;
            if (obj.perf.prefill_tokens  > 0) prefillTokens = obj.perf.prefill_tokens;
            if (obj.perf.generate_time_ms > 0) genTimeMs = obj.perf.generate_time_ms;
            genTokens = obj.perf.generate_tokens || genTokens;
          }
          if (obj.specDecode) specDecode = obj.specDecode;
        } catch (err) {}
      }
    }

    const total = performance.now() - t0;

    benchState.results = {
      ttft_ms: ttft ?? total,
      // Use the server-reported prefill_tokens (actual tokenized count, includes
      // chat template) rather than a client-side word split which can be 30-50%
      // lower than the real token count.
      prefill_tps: prefillTimeMs > 0 && prefillTokens > 0
        ? (prefillTokens / (prefillTimeMs / 1000))
        : 0,
      // When the server doesn't report generate_time_ms (Eagle-3 / speculative
      // paths currently report 0), subtract prefill time from the total wall-clock
      // so we don't penalise the gen speed with prefill + network overhead.
      gen_tps: genTimeMs > 0
        ? (genTokens / (genTimeMs / 1000))
        : genTokens > 0
        ? (genTokens / (Math.max(total - prefillTimeMs, total * 0.1) / 1000))
        : 0,
      gen_tokens: genTokens,
      prefill_tokens: prefillTokens,
      total_ms: total,
      model,
      max_tokens: benchState.maxTokens,
      // Speculative-decode status of this run (for the results card + history).
      spec_enabled:  specDecode?.enabled ? 1 : 0,
      spec_strategy: specDecode?.strategy || 'none',
      spec_hardware: specDecode?.hardware || null,
    };

    // Persist the completed run so it appears in the history table.
    try {
      await fetch('/api/admin/bench-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(benchState.results),
      });
      benchState.historyDirty = true; // signal the view to refresh
    } catch (e) {}

  } catch (err) {
    if (err.name !== 'AbortError') {
      benchState.benchOutput += `\n[Error: ${err.message}]`;
    }
  } finally {
    benchState.running = false;
    abortController = null;
  }
}

export function abortBenchmark() {
  if (abortController) {
    abortController.abort();
  }
  benchState.running = false;
  benchState.benchOutput += '\n[Benchmark aborted]';
  fetch('/api/admin/abort', { method: 'POST' }).catch(() => {});
}
