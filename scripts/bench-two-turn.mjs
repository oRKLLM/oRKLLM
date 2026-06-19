#!/usr/bin/env node
// Two-turn (or N-turn) chat benchmark — observe per-turn performance.
//
// Purpose: the open-NPU (gguf/llama) path has shown a "fast turn 1, slow turn 2"
// pattern. This drives a real multi-turn conversation against the running server
// and prints prefill / decode throughput per turn so the difference is measurable
// (not eyeballed off the dashboard). Decode tok/s is the number to watch: a large
// turn-2 drop is the signature of M=1 decode being dragged onto the NPU (per-token
// submits) instead of staying on CPU NEON.
//
// Usage:
//   node scripts/bench-two-turn.mjs <model-id> [baseUrl]
//   ORKLLM_MODEL=... ORKLLM_URL=http://127.0.0.1:8000 node scripts/bench-two-turn.mjs
//
// Env:
//   ORKLLM_URL      base URL              (default http://127.0.0.1:8000)
//   ORKLLM_MODEL    model id              (or pass as arg 1)
//   ORKLLM_COOKIE   session cookie        (only needed if LOAD=1 — admin endpoints require auth)
//   LOAD=1          load the model first  (polls /api/admin/status; needs ORKLLM_COOKIE)
//   TURNS=2         number of turns
//   MAX_TOKENS=128  generation cap per turn
//   NO_CACHE=1      send no_cache:true     (force a fresh prefill every turn — isolate the prefix cache)
//   SYSTEM="..."    optional system prompt
//
// /v1/chat/completions is unauthenticated (OpenAI-compatible), so the chat turns
// need no cookie. Loading a model does — either pass ORKLLM_COOKIE + LOAD=1, or
// load the model in the UI first and just run the turns.

const BASE = (process.argv[3] || process.env.ORKLLM_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const MODEL = process.argv[2] || process.env.ORKLLM_MODEL;
const COOKIE = process.env.ORKLLM_COOKIE || '';
const TURNS = parseInt(process.env.TURNS || '2', 10);
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '128', 10);
const NO_CACHE = process.env.NO_CACHE === '1';
const SYSTEM = process.env.SYSTEM || '';

if (!MODEL) {
  console.error('error: model id required (arg 1 or ORKLLM_MODEL)');
  process.exit(1);
}

// Distinct, similar-length user turns so decode throughput is comparable across
// turns (the metric is rate, but keeping lengths close avoids confounds).
const USER_TURNS = [
  'Explain in a few sentences what a neural network is.',
  'Now explain what backpropagation does, in a few sentences.',
  'And what is gradient descent? A few sentences.',
  'Finally, what is overfitting? A few sentences.',
];

const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? 'n/a' : n.toFixed(d));
const headers = (json = true) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...(COOKIE ? { Cookie: COOKIE } : {}) });

async function getStatus() {
  const res = await fetch(`${BASE}/api/admin/status`, { headers: headers(false) });
  if (!res.ok) throw new Error(`status ${res.status} (auth? set ORKLLM_COOKIE)`);
  return res.json();
}

async function loadModel() {
  console.log(`→ loading ${MODEL} …`);
  const res = await fetch(`${BASE}/api/admin/load`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ model: MODEL, options: { max_new_tokens: MAX_TOKENS } }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`load failed: ${res.status} ${await res.text().catch(() => '')}`);
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await getStatus();
    if (s.loadError) throw new Error(`load error: ${JSON.stringify(s.loadError)}`);
    if (s.isLoaded && s.model === MODEL) { console.log(`  loaded in ${fmt((Date.now() - t0) / 1000, 1)}s\n`); return; }
    if ((Date.now() - t0) > 15 * 60_000) throw new Error('load timed out (15m)');
    process.stdout.write('.');
  }
}

// Run one turn; returns { perf, ttftWallMs, wallMs, text }.
async function runTurn(messages) {
  const body = { model: MODEL, messages, stream: true, max_tokens: MAX_TOKENS, ...(NO_CACHE ? { no_cache: true } : {}) };
  const t0 = Date.now();
  let ttftWallMs = null, text = '', perf = null;
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith('data: ')) continue;           // skip ': keepalive' comments
      const d = l.slice(6);
      if (d === '[DONE]') continue;
      let obj; try { obj = JSON.parse(d); } catch { continue; }
      const piece = obj.choices?.[0]?.delta?.content;
      if (piece) { if (ttftWallMs == null) ttftWallMs = Date.now() - t0; text += piece; }
      if (obj.perf) perf = obj.perf;
    }
  }
  return { perf, ttftWallMs, wallMs: Date.now() - t0, text };
}

function summarize(turn, r) {
  const p = r.perf || {};
  const prefillTps = p.prefill_time_ms ? (p.prefill_tokens / (p.prefill_time_ms / 1000)) : null;
  const decodeTps  = p.generate_time_ms ? (p.generate_tokens / (p.generate_time_ms / 1000)) : null;
  return {
    turn,
    prefillTokens: p.prefill_tokens ?? null,
    prefillMs: p.prefill_time_ms ?? null,
    prefillTps,
    ttftWallMs: r.ttftWallMs,
    decodeTokens: p.generate_tokens ?? null,
    decodeMs: p.generate_time_ms ?? null,
    decodeTps,
    wallMs: r.wallMs,
  };
}

(async () => {
  console.log(`oRKLLM 2-turn bench  •  ${BASE}\n  model: ${MODEL}\n  turns: ${TURNS}  max_tokens: ${MAX_TOKENS}  cache: ${NO_CACHE ? 'OFF (no_cache)' : 'ON'}\n`);

  if (process.env.LOAD === '1') {
    await loadModel();
  } else {
    try { const s = await getStatus(); if (!s.isLoaded || s.model !== MODEL) console.log(`! note: status says loaded=${s.isLoaded} model=${s.model}; first turn will cold-load (or set LOAD=1 + ORKLLM_COOKIE)\n`); } catch { /* /status needs auth; chat still works */ }
  }

  const messages = [];
  if (SYSTEM) messages.push({ role: 'system', content: SYSTEM });
  const rows = [];
  for (let t = 1; t <= TURNS; t++) {
    const user = USER_TURNS[(t - 1) % USER_TURNS.length];
    messages.push({ role: 'user', content: user });
    process.stdout.write(`→ turn ${t}: "${user.slice(0, 48)}…"  `);
    const r = await runTurn(messages);
    messages.push({ role: 'assistant', content: r.text });
    const s = summarize(t, r);
    rows.push(s);
    console.log(`prefill ${fmt(s.prefillTps)} t/s (${s.prefillTokens} tok, ${fmt(s.prefillMs, 0)}ms)  |  decode ${fmt(s.decodeTps)} t/s (${s.decodeTokens} tok)  |  TTFT ${fmt(s.ttftWallMs, 0)}ms`);
  }

  console.log('\n──────── per-turn ────────');
  console.log('turn   prefill t/s   decode t/s   TTFT(ms)   decode tok');
  for (const s of rows) {
    console.log(`  ${s.turn}     ${fmt(s.prefillTps).padStart(8)}    ${fmt(s.decodeTps).padStart(8)}   ${fmt(s.ttftWallMs, 0).padStart(7)}   ${String(s.decodeTokens).padStart(8)}`);
  }

  if (rows.length >= 2 && rows[0].decodeTps && rows[1].decodeTps) {
    const ratio = rows[0].decodeTps / rows[1].decodeTps;
    console.log(`\ndecode turn1/turn2 = ${fmt(ratio, 2)}×  (${fmt(rows[0].decodeTps)} → ${fmt(rows[1].decodeTps)} t/s)`);
    if (ratio >= 2) console.log('⚠  turn-2 decode is ≥2× slower — consistent with M=1 decode running on the NPU (per-token submits) instead of CPU.');
    else console.log('✓  turn-2 decode is in line with turn 1.');
  }
})().catch(e => { console.error('\nbench failed:', e.message); process.exit(1); });
