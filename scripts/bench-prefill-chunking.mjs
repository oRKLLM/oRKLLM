#!/usr/bin/env node
// Measure the prefill chunk strategies against a running oRKLLM, so the choice is made on data.
//
// WHY THIS EXISTS. Prefill is issued in chunks of at most n_batch (512). How the prompt divides is not
// neutral — measured per-token cost on RK3588 (Qwen3-1.7B int4 .orkpack, warm):
//
//     M=32  7.27   M=64  4.78   M=128  3.79   M=256  3.63   M=384  3.85   M=512  4.08   ms/token
//
// so a chunk below ~128 pays a fixed per-call cost amortised over almost nothing, and the current cap of
// 512 is itself ~12% off the optimum near 256. The default FILL strategy leaves n % cap as the tail: a
// 519-token prompt becomes 512 + 7, and that tail measured 63.5 ms/token.
//
// Two effects pull in OPPOSITE directions, which is why this must be measured rather than reasoned:
//   • tail cost     — favours eliminating small chunks (balanced, borrow)
//   • shape re-warm — ork_bench documents NPU prefill warm-up as SHAPE-DEPENDENT. A cap-sized chunk is
//                     reused across every request; an M derived from n is novel per prompt length, so
//                     balanced may swap a known tail cost for a fresh re-warm on every request.
//
// The re-warm effect is why each length is measured REPEATEDLY and both the first and the settled rate
// are reported: a strategy that looks good once but never settles is worse than a slower stable one.
//
// USAGE (on the board, service running, NPU otherwise idle):
//   ORKLLM_CHUNK_STRATEGY is read by the addon AT FORK, so it must be set for the service, not here:
//     sudo sed -i '/ORKLLM_CHUNK_STRATEGY/d' /etc/orkllm/orkllm.conf
//     echo 'ORKLLM_CHUNK_STRATEGY=balanced' | sudo tee -a /etc/orkllm/orkllm.conf
//     sudo systemctl restart orkllm
//     node scripts/bench-prefill-chunking.mjs --model <id> --label balanced
//   Repeat for fill and borrow, then compare. Remove the var when done.
//
// Optionally set ORKLLM_PREFILL_DEBUG=1 for the service to get [PF-PLAN] and [PF-DECODE] in the journal,
// which shows the actual chunk list and the per-chunk llama_decode time.

import http from 'node:http';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const HOST  = opt('host', '127.0.0.1');
const PORT  = Number(opt('port', 8000));
const MODEL = opt('model', null);
const LABEL = opt('label', 'unlabelled');
const REPS  = Number(opt('reps', 5));
// Lengths chosen to straddle the cap: just under, just over (the pathological tail), and well over.
const LENGTHS = (opt('lengths', '400,519,530,700,1030')).split(',').map(Number);

if (!MODEL) {
  console.error('usage: bench-prefill-chunking.mjs --model <model-id> [--label fill|balanced|borrow]');
  console.error('       [--reps 5] [--lengths 400,519,530,700,1030] [--host h] [--port p]');
  process.exit(2);
}

const UNIT = 'Memory bandwidth rather than arithmetic throughput usually limits single stream decoding on embedded systems on chip. ';

// Build a prompt whose TOKEN count is close to the target. Tokenisation is model-specific, and the
// whole point of these lengths is to straddle the n_batch cap (512) — an assumed chars-per-token gets
// that wrong and quietly leaves every length under the cap, where all three strategies are identical
// by construction and the measurement is empty. So the ratio is CALIBRATED against the model itself:
// one probe request, chars/tokens from the server's own count, then every prompt is sized from that.
let CPT = 4.6;                      // replaced by calibrate() before any measurement
function promptFor(tokens) {
  const want = Math.round(tokens * CPT);
  let s = '';
  while (s.length < want) s += UNIT;
  return s.slice(0, want);
}

async function calibrate() {
  const probeChars = 3000;
  let probe = '';
  while (probe.length < probeChars) probe += UNIT;
  probe = probe.slice(0, probeChars);
  const p = await once(probe);
  if (!p || !p.prefill_tokens) { console.error('calibration failed — is the model loaded?'); process.exit(1); }
  CPT = probeChars / p.prefill_tokens;
  console.log(`calibration: ${probeChars} chars -> ${p.prefill_tokens} tokens (${CPT.toFixed(2)} chars/token)`);
}

function once(prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }],
                                  max_tokens: 4, stream: true, no_cache: true });
    const req = http.request(
      { host: HOST, port: PORT, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let s = '', perf = null;
        res.on('data', (d) => s += d);
        res.on('end', () => {
          for (const line of s.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const b = line.slice(6).trim(); if (b === '[DONE]') continue;
            try { const j = JSON.parse(b); if (j.perf) perf = j.perf; } catch {}
          }
          resolve(perf);
        });
      });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

const rate = (p) => (p && p.prefill_time_ms) ? p.prefill_tokens / (p.prefill_time_ms / 1000) : null;

(async () => {
  console.log(`strategy=${LABEL}  model=${MODEL}  reps=${REPS}`);
  await calibrate();
  // The cap is what the strategies differ around; say plainly which lengths actually cross it.
  console.log('  requested lengths: ' + LENGTHS.join(', ') + '  (cap=512 — anything under it is ONE chunk in every strategy)');
  console.log('  tokens   first    settled(mean of last 3)   spread   note');
  const rows = [];
  for (const want of LENGTHS) {
    const prompt = promptFor(want);
    const seen = [];
    let toks = null;
    for (let i = 0; i < REPS; i++) {
      const p = await once(prompt);
      if (!p) { console.log(`  ${String(want).padStart(6)}   request failed`); break; }
      toks = p.prefill_tokens;
      const r = rate(p);
      if (r) seen.push(r);
    }
    if (seen.length < 2) continue;
    const tail = seen.slice(-3);
    const settled = tail.reduce((a, b) => a + b, 0) / tail.length;
    const spread = Math.max(...tail) - Math.min(...tail);
    // A large first-vs-settled gap is the shape re-warm; it is the cost balanced partitioning risks
    // paying on every request when prompt lengths vary.
    const warm = ((settled - seen[0]) / settled * 100);
    console.log(`  ${String(toks).padStart(6)}  ${seen[0].toFixed(1).padStart(6)}  ` +
                `${settled.toFixed(1).padStart(22)}  ${spread.toFixed(1).padStart(7)}   ` +
                `re-warm ${warm >= 0 ? '+' : ''}${warm.toFixed(0)}%`);
    rows.push({ label: LABEL, tokens: toks, first: seen[0], settled, spread });
  }
  console.log('\nTSV (label\\ttokens\\tfirst\\tsettled):');
  for (const r of rows) console.log(`${r.label}\t${r.tokens}\t${r.first.toFixed(2)}\t${r.settled.toFixed(2)}`);
})();
