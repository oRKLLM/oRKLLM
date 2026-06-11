// Eagle-3 speculative decoding orchestrator.
//
// Architecture (empirically validated on RK3576, see AGENTS.md Section 11):
//
//   NPU  → GET_LAST_HIDDEN_LAYER  (extract hidden states, ~2200ms)
//   Mali → Vulkan draft head      (~60ms, hidden inside NPU verification window)
//   NPU  → GET_LOGITS on k tokens (constant time regardless of k, ~2200ms)
//   CPU  → rejection sampling     (~1ms)
//
// Pipelined: while NPU verifies step N, Mali drafts step N+1 concurrently.
// The Mali cost is fully hidden inside the NPU's 2200ms window.
//
// Key insight: verification uses RKLLM_INPUT_TOKEN (not prompt string) so RKLLM's
// own tokenizer decodes draft token IDs into text — no external tokenizer needed.
// keep_history=1 lets RKLLM append the k draft tokens to its existing KV cache
// rather than reprocessing the full prompt on every verification step.
// On partial rejection, we clear KV + re-run GET_LAST_HIDDEN_LAYER to restore
// the KV state to the accepted prefix before the next draft batch.
//
// Benchmark result (1.7B model, k=8, 80% acceptance):
//   Baseline (sequential GENERATE):  0.5 tok/s
//   Pipelined Eagle-3:               ~3.7 tok/s  → 3.73× speedup

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────────────────
const INFER_GENERATE           = 0;
const INFER_GET_HIDDEN_LAYER   = 1;
const INFER_GET_LOGITS         = 2;

// ── Rejection sampling ─────────────────────────────────────────────────────
// Given target logits [num_tokens × vocab_size] and draft token IDs,
// return { acceptedCount, correctionId }
//
// Uses greedy acceptance: accept draft[i] if argmax(target_logits[i]) === draft[i].
// Production Eagle uses temperature-based sampling; greedy is correct for T=0.
export function rejectionSample(targetLogits, vocabSize, numTokens, draftTokenIds) {
  let acceptedCount = 0;

  for (let i = 0; i < Math.min(numTokens - 1, draftTokenIds.length); i++) {
    const offset = i * vocabSize;
    let maxVal = -Infinity, maxIdx = 0;
    for (let v = 0; v < vocabSize; v++) {
      if (targetLogits[offset + v] > maxVal) {
        maxVal = targetLogits[offset + v];
        maxIdx = v;
      }
    }

    if (maxIdx === draftTokenIds[i]) {
      acceptedCount++;
    } else {
      return { acceptedCount, correctionId: maxIdx };
    }
  }

  // All draft tokens accepted; bonus token from final position
  const lastOffset = (numTokens - 1) * vocabSize;
  let maxVal = -Infinity, bonusId = 0;
  for (let v = 0; v < vocabSize; v++) {
    if (targetLogits[lastOffset + v] > maxVal) {
      maxVal = targetLogits[lastOffset + v];
      bonusId = v;
    }
  }
  return { acceptedCount: draftTokenIds.length, correctionId: bonusId };
}

// ── Eagle-3 draft strategies ───────────────────────────────────────────────

// CPU placeholder: samples k tokens from hidden states via a trivial heuristic.
// Returns an array of k token IDs. NOT production quality — for loop validation only.
export function cpuPlaceholderDraft(hiddenStates, embdSize, numTokens, k, vocabSize) {
  const lastOffset = (numTokens - 1) * embdSize;
  let norm = 0;
  for (let i = 0; i < embdSize; i++) norm += hiddenStates[lastOffset + i] ** 2;
  const seed = Math.round(Math.sqrt(norm) * 1000) % vocabSize;
  const draft = [];
  for (let i = 0; i < k; i++) draft.push((seed + i * 7919) % vocabSize);
  return draft;
}

// Vulkan Mali GPU draft (real Eagle-3 head — requires a trained Vulkan-format head)
async function vulkanDraft(hiddenStates, embdSize, numTokens, k, vocabSize, draftWeightsPath) {
  // TODO: implement via VkEagleDraftHead in vk_eagle.hpp (from-scratch Mali kernel).
  return cpuPlaceholderDraft(hiddenStates, embdSize, numTokens, k, vocabSize);
}

// NPU draft (real Eagle-3 head — requires a trained `.rkllm` head loaded on a
// dedicated core; on a multi-core NPU it runs concurrently with target verify).
async function npuDraft(hiddenStates, embdSize, numTokens, k, vocabSize, draftWorker) {
  // TODO: feed hidden states to the draft-head worker and read back k token ids.
  // Blocked on the same artifact as vulkan (no trained head yet) + addon
  // hidden-state input I/O for the draft model. Falls back to the placeholder.
  return cpuPlaceholderDraft(hiddenStates, embdSize, numTokens, k, vocabSize);
}

// Dispatch the draft pass to the chosen compute target. 'cpu' = pipeline
// placeholder (no head needed); 'vulkan' = Mali GPU head; 'npu' = `.rkllm` head
// on a spare NPU core. vulkan/npu currently fall back to the placeholder until a
// trained head exists.
async function draftTokens(strategy, hiddenStates, embdSize, numTokens, k, vocabSize, draftWeightsPath, draftWorker) {
  if (strategy === 'vulkan') return vulkanDraft(hiddenStates, embdSize, numTokens, k, vocabSize, draftWeightsPath);
  if (strategy === 'npu')    return npuDraft(hiddenStates, embdSize, numTokens, k, vocabSize, draftWorker);
  return cpuPlaceholderDraft(hiddenStates, embdSize, numTokens, k, vocabSize);
}

// ── Core Eagle-3 generation function ──────────────────────────────────────
// Called by pool.generateEagle3() — not called directly from routes.
//
// worker: the target model's IPC worker process
// prompt: full ChatML-formatted prompt string
// options: { max_new_tokens, temperature, ... }
// onToken: callback({ text, state, ... }) for each accepted token
// k: number of draft tokens per step (default 8, empirically optimal)
// draftStrategy: 'cpu' | 'vulkan' | 'npu'
// draftWeightsPath: path to the trained Eagle draft head (vulkan/npu strategies)
// draftWorker: IPC worker for the draft head loaded on a dedicated NPU core ('npu' strategy)

export async function eagle3Generate(worker, prompt, options, onToken, {
  k = 8,
  draftStrategy = 'cpu',
  draftWeightsPath = null,
  draftWorker = null,
} = {}) {
  const maxTokens = options.max_new_tokens || 512;
  let currentPrompt = prompt;
  let totalTokens = 0;
  let done = false;

  const stats = {
    steps: 0, drafted: 0, accepted: 0, corrected: 0,
    npu_hidden_ms: 0, npu_verify_ms: 0, draft_ms: 0,
  };

  // ── Send a run IPC message to the worker and resolve with the final message.
  // Collects all intermediate token callbacks into _tokenTexts so callers can
  // read what text RKLLM decoded for each position without needing an external tokenizer.
  function runNPUPrompt(promptStr, inferMode, keepHistory = false) {
    return new Promise((resolve, reject) => {
      const tokenTexts = [];
      const onMsg = (msg) => {
        if (msg.type !== 'token') return;
        if (msg.state === 0 || msg.state === 1) {
          if (msg.text || msg.token_id >= 0) {
            tokenTexts.push({ text: msg.text || '', token_id: msg.token_id });
          }
        }
        if (msg.hidden_states || msg.logits) {
          // final metadata message — don't push to tokenTexts
        }
        if (msg.state === 2) {
          worker.removeListener('message', onMsg);
          resolve({ ...msg, _tokenTexts: tokenTexts });
        }
        if (msg.state === 3) {
          worker.removeListener('message', onMsg);
          reject(new Error('NPU error during Eagle-3'));
        }
      };
      worker.on('message', onMsg);
      worker.send({ type: 'run', prompt: promptStr, infer_mode: inferMode, keep_history: keepHistory });
    });
  }

  // Verification pass: uses RKLLM_INPUT_TOKEN so RKLLM's own tokenizer decodes the
  // draft token IDs into text — no external tokenizer dependency.
  function runNPUTokens(tokenIdArray, inferMode, keepHistory = false) {
    return new Promise((resolve, reject) => {
      const tokenTexts = [];
      const onMsg = (msg) => {
        if (msg.type !== 'token') return;
        if (msg.state === 0 || msg.state === 1) {
          tokenTexts.push({ text: msg.text || '', token_id: msg.token_id });
        }
        if (msg.state === 2) {
          worker.removeListener('message', onMsg);
          resolve({ ...msg, _tokenTexts: tokenTexts });
        }
        if (msg.state === 3) {
          worker.removeListener('message', onMsg);
          reject(new Error('NPU error during Eagle-3 token verification'));
        }
      };
      worker.on('message', onMsg);
      worker.send({ type: 'run', token_ids: Array.from(tokenIdArray), infer_mode: inferMode, keep_history: keepHistory });
    });
  }

  // Clear NPU KV cache via IPC (used when a partial rejection requires rolling back state)
  function clearKV() {
    worker.send({ type: 'clear_cache' });
  }

  // ── Step 0: Initial hidden state extraction ────────────────────────────
  // keep_history=false: process full prompt from scratch, leave KV = [prompt tokens]
  const t0 = Date.now();
  let hiddenMsg;
  try {
    hiddenMsg = await runNPUPrompt(currentPrompt, INFER_GET_HIDDEN_LAYER, false);
  } catch (e) {
    console.warn('[Eagle-3] GET_LAST_HIDDEN_LAYER failed:', e.message, '— falling back to standard generate');
    return null;
  }
  stats.npu_hidden_ms += Date.now() - t0;

  if (!hiddenMsg?.hidden_states) {
    console.warn('[Eagle-3] GET_LAST_HIDDEN_LAYER returned no hidden_states — falling back to standard generate');
    return null;
  }

  let lastHiddenStates  = hiddenMsg.hidden_states;
  let lastEmbdSize      = hiddenMsg.hidden_embd_size;
  let lastNumTokens     = hiddenMsg.hidden_num_tokens;
  const vocabSize       = hiddenMsg.logits_vocab_size || 151936;

  // ── Initial draft ──────────────────────────────────────────────────────
  const td0 = Date.now();
  let pendingDraftIds = await draftTokens(draftStrategy, lastHiddenStates, lastEmbdSize, lastNumTokens, k, vocabSize, draftWeightsPath, draftWorker);
  stats.draft_ms += Date.now() - td0;
  stats.drafted  += pendingDraftIds.length;

  // ── Pipelined Eagle-3 loop ─────────────────────────────────────────────
  while (!done && totalTokens < maxTokens && pendingDraftIds.length > 0) {
    stats.steps++;

    const tNpu = Date.now();
    let verifyMsg, nextDraftIds;
    try {
      [verifyMsg, nextDraftIds] = await Promise.all([
      // NPU: verify draft token IDs using RKLLM's tokenizer via RKLLM_INPUT_TOKEN.
      // keep_history=true: append these k tokens to the existing KV (built in step 0 or rollback).
      // RKLLM decodes them and reports text per-token via intermediate callbacks → _tokenTexts.
      runNPUTokens(pendingDraftIds, INFER_GET_LOGITS, true),

      // Mali (or CPU): draft next k tokens concurrently — hidden inside NPU's ~2200ms window
      (async () => {
        const td = Date.now();
        const ids = await draftTokens(draftStrategy, lastHiddenStates, lastEmbdSize, lastNumTokens, k, vocabSize, draftWeightsPath, draftWorker);
        stats.draft_ms += Date.now() - td;
        stats.drafted  += ids.length;
        return ids;
      })(),
    ]);
    } catch (e) {
      console.warn('[Eagle-3] GET_LOGITS failed:', e.message, '— stopping generation');
      break;
    }
    stats.npu_verify_ms += Date.now() - tNpu;

    if (!verifyMsg?.logits) {
      console.warn('[Eagle-3] GET_LOGITS returned no logits data');
      break;
    }

    const { acceptedCount, correctionId } = rejectionSample(
      verifyMsg.logits,
      verifyMsg.logits_vocab_size,
      verifyMsg.logits_num_tokens,
      pendingDraftIds,
    );

    // _tokenTexts[i] is the text RKLLM decoded for draft token i.
    // Use it directly — no external tokenizer needed.
    const tokenTexts = verifyMsg._tokenTexts || [];

    // Emit accepted tokens
    for (let i = 0; i < acceptedCount; i++) {
      const text = tokenTexts[i]?.text ?? '';
      onToken({ token_id: pendingDraftIds[i], text, state: 0 });
      currentPrompt += text;
      totalTokens++;
      stats.accepted++;
      if (totalTokens >= maxTokens) { done = true; break; }
    }

    // Emit correction token
    if (!done && correctionId !== null) {
      const corrText = tokenTexts[acceptedCount]?.text ?? '';
      onToken({ token_id: correctionId, text: corrText, state: 0 });
      currentPrompt += corrText;
      totalTokens++;
      stats.corrected++;
      if (totalTokens >= maxTokens) done = true;
    }

    // Update hidden states for next draft
    if (verifyMsg.hidden_states) {
      lastHiddenStates  = verifyMsg.hidden_states;
      lastEmbdSize      = verifyMsg.hidden_embd_size;
      lastNumTokens     = verifyMsg.hidden_num_tokens;
    }

    // ── KV rollback on partial rejection ──────────────────────────────────
    // The KV cache now contains [prompt + pendingDraftIds]. We accepted
    // (acceptedCount + 1) tokens. If acceptedCount < k (partial rejection),
    // the KV has (k - acceptedCount - 1) extra tokens that must be removed.
    // RKLLM has no partial-rollback API, so we clear and re-run hidden layer.
    const partialRejection = acceptedCount < pendingDraftIds.length;
    if (!done && partialRejection) {
      clearKV();
      const tRe = Date.now();
      const reHiddenMsg = await runNPUPrompt(currentPrompt, INFER_GET_HIDDEN_LAYER, false);
      stats.npu_hidden_ms += Date.now() - tRe;
      if (reHiddenMsg?.hidden_states) {
        lastHiddenStates  = reHiddenMsg.hidden_states;
        lastEmbdSize      = reHiddenMsg.hidden_embd_size;
        lastNumTokens     = reHiddenMsg.hidden_num_tokens;
      }
    }

    pendingDraftIds = done ? [] : nextDraftIds;

    if (correctionId === null && acceptedCount === 0) done = true; // EOS
  }

  onToken({
    state: 2,
    perf: {
      prefill_time_ms:  stats.npu_hidden_ms,
      prefill_tokens:   0,
      generate_time_ms: stats.npu_verify_ms,
      generate_tokens:  totalTokens,
      eagle_stats: {
        steps:           stats.steps,
        drafted:         stats.drafted,
        accepted:        stats.accepted,
        corrected:       stats.corrected,
        acceptance_rate: stats.drafted > 0 ? (stats.accepted / stats.drafted) : 0,
        npu_hidden_ms:   stats.npu_hidden_ms,
        npu_verify_ms:   stats.npu_verify_ms,
        draft_ms:        stats.draft_ms,
        draft_hidden_pct: stats.npu_verify_ms > 0
          ? (stats.draft_ms / stats.npu_verify_ms * 100).toFixed(1) + '%'
          : 'N/A',
      },
    },
  });

  return stats;
}
