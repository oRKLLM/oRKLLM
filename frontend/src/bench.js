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
  let genTimeMs = 0;

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
        top_p: 0.9
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
            prefillTimeMs = obj.perf.prefill_time_ms || 0;
            genTimeMs = obj.perf.generate_time_ms || 0;
            genTokens = obj.perf.generate_tokens || genTokens;
          }
        } catch (err) {}
      }
    }

    const total = performance.now() - t0;

    benchState.results = {
      ttft_ms: ttft ?? total,
      prefill_tps: prefillTimeMs > 0 ? ((benchState.benchPrompt.split(' ').length) / (prefillTimeMs / 1000)) : 0,
      gen_tps: genTimeMs > 0 ? (genTokens / (genTimeMs / 1000)) : (genTokens / (total / 1000)),
      gen_tokens: genTokens,
      total_ms: total,
      model,
      max_tokens: benchState.maxTokens
    };

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
}
