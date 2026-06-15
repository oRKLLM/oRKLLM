<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page fill-height">
    <v-container fluid class="pt-6 px-6 page-container">

      <!-- Header -->
      <div class="mb-6">
        <div class="text-h5 font-weight-bold mb-1 d-flex align-center">
          <v-icon start color="primary">mdi-lifebuoy</v-icon>
          Help &amp; Learning
        </div>
        <div class="text-caption text-grey">
          Core concepts for running LLMs on your own hardware, plus curated links to go deeper.
        </div>
      </div>

      <!-- Quick start: jump to the parts of oRKLLM you'll use -->
      <v-card class="glass-card pa-5 mb-6">
        <div class="text-h6 font-weight-bold mb-1 d-flex align-center">
          <v-icon start color="primary" size="20">mdi-rocket-launch-outline</v-icon>
          Quick start
        </div>
        <div class="text-caption text-grey mb-4">A typical first run, in four steps.</div>
        <v-row dense>
          <v-col v-for="(step, i) in quickStart" :key="step.to" cols="12" sm="6" md="3">
            <v-card
              variant="tonal"
              class="pa-4 h-100 quick-card"
              :to="step.to"
              link
            >
              <div class="d-flex align-center mb-2">
                <v-avatar size="26" color="primary" class="mr-2 text-caption font-weight-bold">{{ i + 1 }}</v-avatar>
                <v-icon size="20" color="primary">{{ step.icon }}</v-icon>
              </div>
              <div class="text-body-2 font-weight-bold">{{ step.title }}</div>
              <div class="text-caption text-grey mt-1">{{ step.desc }}</div>
            </v-card>
          </v-col>
        </v-row>
      </v-card>

      <!-- Core concepts, grouped into expandable sections -->
      <div v-for="group in concepts" :key="group.category" class="mb-6">
        <div class="text-subtitle-1 font-weight-bold mb-2 d-flex align-center">
          <v-icon start :color="group.color" size="20">{{ group.icon }}</v-icon>
          {{ group.category }}
        </div>
        <v-expansion-panels variant="accordion" class="glass-card concept-panels">
          <v-expansion-panel v-for="item in group.items" :key="item.title">
            <v-expansion-panel-title>
              <span class="font-weight-medium">{{ item.title }}</span>
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <div class="text-body-2 concept-body" v-html="item.body"></div>
              <a
                v-if="item.link"
                :href="item.link.url"
                target="_blank"
                rel="noopener"
                class="text-primary text-caption d-inline-flex align-center mt-2"
              >
                {{ item.link.label || 'Learn more' }}
                <v-icon size="13" class="ml-1">mdi-open-in-new</v-icon>
              </a>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </div>

      <!-- Curated external resources -->
      <div class="text-subtitle-1 font-weight-bold mb-2 d-flex align-center">
        <v-icon start color="cyan" size="20">mdi-link-variant</v-icon>
        Further reading &amp; resources
      </div>
      <v-row>
        <v-col v-for="group in resources" :key="group.category" cols="12" md="6">
          <v-card class="glass-card pa-4 mb-2 h-100">
            <div class="text-body-1 font-weight-bold mb-3 d-flex align-center">
              <v-icon start :color="group.color" size="18">{{ group.icon }}</v-icon>
              {{ group.category }}
            </div>
            <v-list density="compact" bg-color="transparent" class="pa-0">
              <v-list-item
                v-for="link in group.items"
                :key="link.url"
                :href="link.url"
                target="_blank"
                rel="noopener"
                class="px-2 rounded link-item"
              >
                <template #prepend>
                  <v-icon size="18" color="grey">mdi-open-in-new</v-icon>
                </template>
                <v-list-item-title class="text-body-2">{{ link.title }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">{{ link.desc }}</v-list-item-subtitle>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>
      </v-row>

      <!-- Glossary — every term in the oRKLLM ecosystem, searchable -->
      <div class="text-subtitle-1 font-weight-bold mb-2 mt-8 d-flex align-center">
        <v-icon start color="amber" size="20">mdi-book-alphabet</v-icon>
        Glossary
      </div>
      <v-card class="glass-card pa-5 mb-6">
        <v-text-field
          v-model="glossarySearch"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          placeholder="Search terms…"
          prepend-inner-icon="mdi-magnify"
          class="mb-4"
          style="max-width: 360px;"
        ></v-text-field>

        <div v-if="filteredGlossary.length === 0" class="text-body-2 text-grey text-center py-4">
          No terms match “{{ glossarySearch }}”.
        </div>

        <v-row v-else dense>
          <v-col
            v-for="entry in filteredGlossary"
            :key="entry.term"
            cols="12"
            md="6"
          >
            <div class="glossary-entry py-2">
              <div class="d-flex align-center flex-wrap" style="gap: 6px;">
                <span class="text-body-2 font-weight-bold">{{ entry.term }}</span>
                <v-chip v-if="entry.tag" size="x-small" :color="entry.tag === 'oRKLLM' ? 'primary' : 'grey'" variant="tonal">{{ entry.tag }}</v-chip>
              </div>
              <div class="text-caption text-grey mt-1" v-html="entry.def"></div>
            </div>
          </v-col>
        </v-row>
      </v-card>

      <div class="text-center text-caption text-grey my-6">
        Spotted something out of date or have a resource to add?
        <a href="https://github.com/oRKLLM/oRKLLM/issues" target="_blank" rel="noopener" class="text-primary">Open an issue</a>.
      </div>

    </v-container>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

export default {
  name: 'Help',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme',
    glossarySearch: '',

    // Comprehensive glossary of the oRKLLM ecosystem + general LLM concepts.
    // tag 'oRKLLM' marks a project-specific feature; 'concept' a general term.
    glossary: [
      { term: 'Admin Console', tag: 'oRKLLM', def: 'The web UI you’re using now — Dashboard, Models, Chat, Bench, Settings, Logs, and Site Management.' },
      { term: 'APT channel', tag: 'oRKLLM', def: 'Release track for the Debian package: <code>stable</code> (main), <code>beta</code> (soak), and <code>alpha</code> (cutting-edge). Pin one in your apt sources.' },
      { term: 'Base model', tag: 'oRKLLM', def: 'An unconverted (safetensors) model. oRKLLM uses it to supply token embeddings to an EAGLE-3 draft head.' },
      { term: 'Benchmark', tag: 'oRKLLM', def: 'The Bench page measures TTFT, prefill tok/s, and generation tok/s for a model. Bypasses the prefix cache to measure raw prefill.' },
      { term: 'Context window', tag: 'concept', def: 'Maximum tokens (prompt + reply) the model can consider at once. Set per model as <i>Ctx Window</i>.' },
      { term: 'Decode', tag: 'concept', def: 'The generation phase — producing the reply one token at a time. Memory-bandwidth-bound; reported as generation tok/s.' },
      { term: 'Draft model / head', tag: 'concept', def: 'A small fast model (or lightweight head) that proposes tokens for speculative decoding, verified by the main model.' },
      { term: 'EAGLE-3', tag: 'concept', def: 'A speculative-decoding method whose draft head reuses the base model’s embeddings. oRKLLM can run it on the Mali GPU.' },
      { term: 'Embeddings', tag: 'concept', def: 'Vector representations of tokens/text. Exposed via <code>/v1/embeddings</code>; also shared with EAGLE-3 draft heads.' },
      { term: 'Frequency penalty', tag: 'concept', def: 'Sampling penalty that scales with how often a token has already been used, reducing repetition.' },
      { term: 'GGUF', tag: 'concept', def: 'The quantized model format used by llama.cpp (e.g. Q4_K_M, Q8_0). Served by oRKLLM’s open llama runtime.' },
      { term: 'ggml-ork', tag: 'oRKLLM', def: 'The Rockchip NPU backend for llama.cpp that lets GGUF models run on the NPU via ork-driver.' },
      { term: 'Idle timeout', tag: 'oRKLLM', def: 'How long a model stays loaded with no activity before auto-unloading to free NPU memory. Disabled by pinning.' },
      { term: 'Inference', tag: 'concept', def: 'Running a model to produce output (prefill + decode), as opposed to training it.' },
      { term: 'KV cache', tag: 'concept', def: 'Cached key/value tensors from already-processed tokens so the model doesn’t recompute them each step.' },
      { term: 'librkllmrt.so', tag: 'oRKLLM', def: 'Rockchip’s closed-source RKLLM runtime that drives <code>.rkllm</code> models on the NPU. Version-matched to each model.' },
      { term: 'llama.cpp', tag: 'concept', def: 'The open inference engine behind oRKLLM’s GGUF runtime (with a Rockchip NPU backend).' },
      { term: 'Mali GPU', tag: 'concept', def: 'The GPU in Rockchip SoCs (Mali-G52 on RK3576, G610 on RK3588). Used for Vulkan compute, e.g. the EAGLE-3 draft.' },
      { term: 'MCP', tag: 'oRKLLM', def: 'Model Context Protocol — connect external tools (search, files, APIs) the model can call. Added in Settings; picked per chat.' },
      { term: 'Mirostat', tag: 'concept', def: 'An adaptive sampling scheme that targets a constant output "surprise" (perplexity) instead of fixed top-k/top-p.' },
      { term: 'Mock engine', tag: 'oRKLLM', def: 'A pure-JS fake inference engine auto-enabled on non-ARM/non-Linux hosts so the UI runs without a board.' },
      { term: 'NPU', tag: 'concept', def: 'Neural Processing Unit — a dedicated matrix-math accelerator in the SoC that runs quantized models efficiently.' },
      { term: 'ork-driver', tag: 'oRKLLM', def: 'oRKLLM’s from-scratch open userspace NPU driver (a separate project), aiming to replace the closed runtime.' },
      { term: 'Pinning', tag: 'oRKLLM', def: 'Keeping a model loaded so the idle timeout never unloads it; the pinned model also auto-loads on startup.' },
      { term: 'Prefill', tag: 'concept', def: 'The phase that processes the whole prompt in parallel to build model state before generation. Compute-bound.' },
      { term: 'Prefix cache', tag: 'oRKLLM', def: 'A tiered SSD cache of conversation KV state so a follow-up sharing the same prefix skips re-prefilling it.' },
      { term: 'Presence penalty', tag: 'concept', def: 'Sampling penalty applied once a token has appeared at all, encouraging new topics.' },
      { term: 'Quantization', tag: 'concept', def: 'Storing weights at lower precision (4/8-bit) to shrink the model and speed up inference, with a small accuracy cost.' },
      { term: 'Repetition penalty', tag: 'concept', def: 'Lowers the probability of tokens that already appeared (1.0 = off, ~1.1 typical) to curb looping.' },
      { term: 'RK3576 / RK3588', tag: 'concept', def: 'Rockchip SoCs oRKLLM targets — ~6 TOPS NPUs (RK3576: 2 cores; RK3588: 3 cores).' },
      { term: 'RKLLM', tag: 'oRKLLM', def: 'Rockchip’s LLM stack and the <code>.rkllm</code> model format produced by rkllm-toolkit.' },
      { term: 'rkllm-toolkit', tag: 'concept', def: 'Rockchip’s Python SDK (x86) that converts HuggingFace models into <code>.rkllm</code> files.' },
      { term: 'Runtime version matching', tag: 'oRKLLM', def: 'Each <code>.rkllm</code> is built for a specific runtime version; oRKLLM reads it from the filename and auto-selects/downloads the right <code>librkllmrt.so</code>.' },
      { term: 'Sampling', tag: 'concept', def: 'Choosing the next token from the model’s probability distribution, shaped by temperature/top-k/top-p/penalties.' },
      { term: 'Single-active-model lock', tag: 'oRKLLM', def: 'Only one model occupies NPU memory at a time; loading another swaps the current one out.' },
      { term: 'Speculative decoding', tag: 'concept', def: 'Guessing several tokens ahead with a small draft model and verifying them in one pass for a speedup with identical output.' },
      { term: 'SSE streaming', tag: 'concept', def: 'Server-Sent Events — how oRKLLM streams tokens to the client as they’re generated.' },
      { term: 'System prompt', tag: 'concept', def: 'Instructions prepended to a conversation that set the model’s role, tone, and constraints.' },
      { term: 'Tailscale', tag: 'oRKLLM', def: 'Optional remote access — publishes oRKLLM over HTTPS to your own tailnet devices only, no public ports.' },
      { term: 'Temperature', tag: 'concept', def: 'Sampling randomness control — low is focused/deterministic, high is creative/varied.' },
      { term: 'Thinking mode', tag: 'concept', def: 'A model emitting a hidden <code>&lt;think&gt;</code> reasoning block before its answer (e.g. Qwen3). Toggled per model.' },
      { term: 'Token', tag: 'concept', def: 'The unit a model reads/writes — a chunk of text roughly ¾ of a word.' },
      { term: 'top-k', tag: 'concept', def: 'Sampling that keeps only the k most likely next tokens before choosing.' },
      { term: 'top-p (nucleus)', tag: 'concept', def: 'Sampling that keeps the smallest set of tokens whose probabilities sum to p (e.g. 0.9).' },
      { term: 'TOPS', tag: 'concept', def: 'Tera-Operations Per Second — a measure of NPU throughput (RK3576/RK3588 ≈ 6 TOPS).' },
      { term: 'TTFT', tag: 'concept', def: 'Time To First Token — latency from request to the first streamed token (dominated by prefill).' },
      { term: 'Vulkan', tag: 'concept', def: 'The GPU compute API oRKLLM uses on the Mali GPU for KV-cache quantisation and the EAGLE-3 draft head.' },
      { term: 'w4a16 / w8a8', tag: 'concept', def: 'RKLLM quantization formats — 4-bit or 8-bit weights. 4-bit is the usual sweet spot on a 6-TOPS NPU.' },
    ],

    quickStart: [
      { to: '/models',   icon: 'mdi-download-outline', title: 'Get a model', desc: 'Search HuggingFace and download a model built for your chipset (RK3576/RK3588).' },
      { to: '/models',   icon: 'mdi-chip',             title: 'Load it',      desc: 'Load a model into the NPU. Only one runs at a time; loading swaps it in.' },
      { to: '/chat',     icon: 'mdi-chat-outline',     title: 'Chat',         desc: 'Talk to the model with streaming responses and conversation history.' },
      { to: '/bench',    icon: 'mdi-speedometer',      title: 'Benchmark',    desc: 'Measure prefill and generation speed to compare models and settings.' },
    ],

    concepts: [
      {
        category: 'LLM fundamentals',
        icon: 'mdi-school-outline',
        color: 'primary',
        items: [
          {
            title: 'Tokens & the context window',
            body: `Models read and write <b>tokens</b> — chunks of text roughly ¾ of a word each. The <b>context window</b> is the maximum number of tokens the model can consider at once (prompt + reply combined). When a conversation grows past the window, the oldest turns are trimmed (a "sliding window"). A larger context lets the model remember more but uses more memory and is slower. In oRKLLM you set this per model as <i>Ctx Window</i> in model settings.`,
          },
          {
            title: 'Prefill vs. decode (generation)',
            body: `Inference has two phases. <b>Prefill</b> processes your whole prompt in parallel to build the model's internal state — it's compute-heavy and reported as "prefill tok/s". <b>Decode</b> then produces the reply one token at a time, each depending on the last — it's memory-bandwidth-bound and reported as "generation tok/s". This is why a long prompt has a pause (prefill) before words start streaming, and why memory speed matters so much for generation.`,
          },
          {
            title: 'Sampling: temperature, top-p, top-k',
            body: `At each step the model produces a probability for every possible next token; <b>sampling</b> picks one. <b>Temperature</b> scales randomness — low (0.1–0.5) is focused and repetitive, high (0.8–1.2) is creative and varied. <b>Top-k</b> keeps only the k most likely tokens; <b>top-p</b> (nucleus) keeps the smallest set whose probabilities sum to p (e.g. 0.9). Lower values = safer/more deterministic, higher = more diverse. Tune these in model settings.`,
          },
          {
            title: 'Repetition, presence & frequency penalties',
            body: `These discourage the model from looping. <b>Repetition penalty</b> (1.0 = off, ~1.1 typical) lowers the odds of tokens that already appeared. <b>Frequency penalty</b> scales with how often a token was used; <b>presence penalty</b> applies once a token has appeared at all. Use small values — too high makes text incoherent. (On the GGUF/llama runtime these are honoured per request; see your model's settings.)`,
          },
          {
            title: 'Thinking / reasoning mode',
            body: `Some models (e.g. Qwen3) can emit a hidden <b>&lt;think&gt;…&lt;/think&gt;</b> block where they reason step-by-step before answering. This improves hard tasks (math, logic) at the cost of extra tokens and latency. oRKLLM exposes a <i>Thinking</i> toggle per model — off by default. Turn it on for reasoning-heavy work, off for quick chat.`,
          },
          {
            title: 'Getting better answers (prompting, hallucination, RAG)',
            body: `LLMs predict <i>plausible</i> text, so they can <b>hallucinate</b> — state false things confidently. To get better results: write clear, specific prompts (<b>prompt engineering</b>); include a few worked examples (<b>few-shot</b>); ask for step-by-step reasoning (<b>chain-of-thought</b>) on hard problems; and lower the temperature for factual work. To ground answers in real data, put sources directly in the prompt — the idea behind <b>RAG</b> (retrieval-augmented generation) — or connect tools via MCP so the model can look things up instead of guessing.`,
          },
          {
            title: 'Prompting vs. fine-tuning vs. RAG',
            body: `Three ways to make a model fit your needs. <b>Prompting</b> steers a model at request time (cheapest, instant). <b>RAG</b> feeds it relevant external documents so answers stay factual and current without retraining. <b>Fine-tuning</b> further trains the base model on your data to bake in a style or domain — most powerful but the heaviest, and it happens off-device (oRKLLM runs the resulting model, it doesn’t train). Start with prompting, add RAG/tools for facts, fine-tune only when you need consistent voice or behaviour.`,
            link: { url: 'https://arxiv.org/abs/2005.11401', label: 'Paper: Retrieval-Augmented Generation (Lewis et al.)' },
          },
        ],
      },
      {
        category: 'Running models efficiently',
        icon: 'mdi-tune',
        color: 'teal',
        items: [
          {
            title: 'Quantization (w4a16, w8a8, Q4_K, Q8_0)',
            body: `<b>Quantization</b> shrinks a model by storing weights at lower precision, trading a little accuracy for much less memory and faster inference. <b>w4a16 / w8a8</b> are RKLLM formats (4- or 8-bit weights). <b>Q4_K_M / Q8_0</b> are GGUF formats from the llama.cpp world. Smaller (4-bit) = faster and lighter but slightly less accurate; 8-bit is closer to the original. On a 6–TOPS NPU, 4-bit quants are usually the sweet spot.`,
          },
          {
            title: 'The KV cache & prefix caching',
            body: `As the model processes tokens it stores intermediate "keys and values" — the <b>KV cache</b> — so it doesn't recompute earlier tokens. oRKLLM goes further with a <b>prefix cache</b>: it saves the KV state of a conversation to SSD, so the next turn that shares the same prefix skips re-prefilling it entirely. That's why a follow-up message in a long chat starts replying almost instantly. (Benchmarks bypass this to measure raw prefill speed.)`,
          },
          {
            title: 'Speculative decoding & EAGLE-3',
            body: `Decoding one token at a time underuses the hardware. <b>Speculative decoding</b> uses a small fast "draft" model to guess several tokens ahead, which the main model then verifies in one pass — accepting the correct guesses for a speedup with identical output. <b>EAGLE-3</b> is an advanced variant where the draft is a lightweight head sharing the base model's embeddings. oRKLLM can run an EAGLE-3 draft on the Mali GPU concurrently with NPU verification.`,
            link: { url: 'https://github.com/SafeAILab/EAGLE', label: 'SafeAILab/EAGLE — method & weights' },
          },
          {
            title: 'Pinning, idle timeout & single-model lock',
            body: `Only one model fits in NPU memory at a time, so loading a new model unloads the current one. A model auto-unloads after an <b>idle timeout</b> to free memory; <b>pinning</b> keeps it resident (and reloads it on restart). If you switch models often, expect a short load pause on each swap — larger GGUF models load more slowly than RKLLM ones.`,
          },
        ],
      },
      {
        category: 'Self-hosting on Rockchip',
        icon: 'mdi-server',
        color: 'deep-purple',
        items: [
          {
            title: 'What the NPU is (RK3576 / RK3588)',
            body: `Rockchip SoCs include an <b>NPU</b> (Neural Processing Unit) — a dedicated matrix-math accelerator separate from the CPU and GPU. The RK3576 has a ~6 TOPS NPU (2 cores); the RK3588 ~6 TOPS across 3 cores. It runs quantized models far more efficiently (per watt) than the CPU. oRKLLM serializes inference onto the NPU and shows its live load on the Dashboard.`,
          },
          {
            title: 'Two runtimes: RKLLM vs. llama.cpp (GGUF)',
            body: `oRKLLM serves two model formats. <b>.rkllm</b> files run on Rockchip's closed <code>librkllmrt.so</code> runtime (fastest, but models must be converted with rkllm-toolkit). <b>.gguf</b> files run on an open llama.cpp build with a Rockchip NPU backend — more models available, fully open, but currently slower. The backend is chosen automatically by file extension; each model shows a runtime chip on the Models page.`,
          },
          {
            title: 'Model naming & runtime versions',
            body: `RKLLM models are version-locked to the runtime that built them. oRKLLM reads the version from the filename (e.g. <code>…-v1.2.3-RKLLM.rkllm</code>) and auto-selects or downloads the matching <code>librkllmrt.so</code>. Following the naming convention <code>Family-Params-Variant-Chipset-Quant-Algo-vVersion-RKLLM</code> makes models discoverable and lets the chipset filter surface ones built for your board.`,
          },
          {
            title: 'Connecting clients & remote access',
            body: `oRKLLM exposes an <b>OpenAI-compatible API</b> (<code>/v1/chat/completions</code>, <code>/v1/models</code>, <code>/v1/embeddings</code>), so tools like Open WebUI or any OpenAI SDK can point at it directly. For access away from home, the optional Tailscale integration (Site Management → Remote Access) publishes it over HTTPS to just your own devices — no ports opened to the public internet.`,
          },
          {
            title: 'MCP tools',
            body: `The <b>Model Context Protocol (MCP)</b> lets a model call external tools (web search, file access, APIs). Add MCP servers in Settings, then enable tools globally or pick them per-chat. oRKLLM runs a prompt-driven tool-use loop, so even models without native function-calling can use tools: it parses the model's tool requests, runs them, and feeds the results back until it answers.`,
          },
          {
            title: 'How much memory does a model need?',
            body: `Rockchip boards share one pool of system RAM across CPU, GPU and NPU — there's no separate VRAM. A model needs roughly its <b>file size</b> in RAM for weights, plus the <b>KV cache</b> (grows with context length), plus headroom for the OS. At 4-bit quantization that's about <b>0.5–0.7 GB per billion parameters</b>: a 4B model ≈ 2–3 GB, an 8B ≈ 4–5 GB, before context. oRKLLM checks for ~1.2× the model size in free RAM before auto-loading a pinned model. Choose a quant/size that leaves room for your context window.`,
          },
        ],
      },
      {
        category: 'Enterprise & operations',
        icon: 'mdi-office-building-outline',
        color: 'indigo',
        items: [
          {
            title: 'Authentication & SSO (OIDC / SAML)',
            body: `Beyond local accounts, oRKLLM federates identity through <b>OIDC</b> (OpenID Connect, with PKCE for public clients) and <b>SAML 2.0</b> — so you can sign in with Keycloak, Google, Azure AD/Entra, Okta, etc. Configure providers in Site Management → Auth Providers. This centralises identity, enables company-wide login policy, and removes per-app passwords.`,
          },
          {
            title: 'Role-based access control (RBAC)',
            body: `Users are <b>admin</b> (full access incl. Site Management) or <b>user</b> (everything else). Roles can be driven from your IdP: an OIDC <code>groups</code> claim (or SAML attribute) maps <code>/orkllm</code> → user and <code>/orkllm/admin</code> → admin, so access follows your directory automatically.`,
          },
          {
            title: 'Audit logging & compliance',
            body: `Enterprise platforms keep an <b>audit log</b> of security-relevant events (logins, config changes) for accountability and standards like SOC 2 / ISO 27001 / GDPR. oRKLLM records auth and admin events viewable in Site Management → Audit Log. Because it runs entirely on your own hardware, data never leaves the device — the strongest form of the <b>air-gapped / on-prem</b> deployment regulated industries require.`,
          },
          {
            title: 'Reverse proxies & trusted proxy',
            body: `Running behind nginx, Caddy, or a tunnel is standard for TLS, routing, and rate-limiting. Set <b>Trusted Proxy</b> (an IP, CIDR, or list) so oRKLLM honours <code>X-Forwarded-*</code> headers correctly — needed for OIDC redirect URIs and accurate client IPs. Model loads are async (the API returns immediately and the UI polls) so long loads survive a proxy's read timeout.`,
          },
          {
            title: 'Observability & guardrails',
            body: `<b>Observability</b> means seeing what the system is doing — oRKLLM streams live hardware telemetry (CPU/NPU/GPU/RAM/temp), a real-time log terminal, and per-request serving stats; larger platforms add Prometheus/OpenTelemetry metrics and tracing. <b>Guardrails</b> are policies that filter or constrain inputs/outputs (safety, PII redaction, allowed topics) — typically layered in front of the model via the system prompt or an external policy service.`,
          },
        ],
      },
      {
        category: 'Research frontier',
        icon: 'mdi-flask-outline',
        color: 'pink',
        items: [
          {
            title: 'Mixture of Experts (MoE)',
            body: `Instead of one dense network, an <b>MoE</b> model has many smaller "expert" sub-networks and a <b>router</b> that activates only a few per token. This gives a huge total parameter count while keeping per-token compute (and cost) low — e.g. a model with 35B total but only ~3B active. Great for capability-per-FLOP; the catch is memory (all experts must be resident) and routing imbalance.`,
            link: { url: 'https://huggingface.co/blog/moe', label: 'Hugging Face: Mixture of Experts explained' },
          },
          {
            title: 'Attention efficiency (FlashAttention, paged & sparse attention)',
            body: `The attention mechanism is the main cost of long prompts. <b>FlashAttention</b> reorders the math to cut memory traffic; <b>paged attention</b> manages the KV cache like virtual memory; <b>sparse / sliding-window attention</b> attends to a subset of tokens. Together these are why modern engines handle long contexts far more cheaply than a naïve implementation.`,
            link: { url: 'https://arxiv.org/abs/2205.14135', label: 'Paper: FlashAttention (Dao et al.)' },
          },
          {
            title: 'Long context & its limits',
            body: `Context windows have grown to hundreds of thousands of tokens via techniques like <b>RoPE scaling</b> and <b>YaRN</b> (which stretch a model's positional encoding past its trained length). But bigger isn't free: models suffer "<b>lost in the middle</b>", where facts buried mid-context are recalled worse than those at the start or end — so placement and retrieval (RAG) still matter.`,
            link: { url: 'https://arxiv.org/abs/2307.03172', label: 'Paper: Lost in the Middle (Liu et al.)' },
          },
          {
            title: 'State-space models (Mamba) & hybrids',
            body: `<b>State-space models</b> (SSMs) like Mamba process sequences in linear time instead of attention's quadratic cost, making them efficient at very long contexts. Recent models use <b>hybrid</b> designs that alternate SSM and attention layers to get both efficiency and attention's recall.`,
            link: { url: 'https://arxiv.org/abs/2312.00752', label: 'Paper: Mamba (Gu & Dao)' },
          },
          {
            title: 'Test-time compute & reasoning',
            body: `Rather than scaling the model, <b>test-time compute</b> spends more effort <i>per query</i> — letting the model reason longer (chain-of-thought), sample multiple solutions, or self-verify before answering. This is the engine behind "reasoning" models and oRKLLM's thinking mode: trade latency and tokens for accuracy on hard problems.`,
            link: { url: 'https://arxiv.org/abs/2201.11903', label: 'Paper: Chain-of-Thought prompting (Wei et al.)' },
          },
          {
            title: 'Distillation, LoRA & efficient adaptation',
            body: `<b>Distillation</b> trains a small "student" model to mimic a larger "teacher", capturing much of its ability at a fraction of the size — ideal for edge devices. <b>LoRA</b> (Low-Rank Adaptation) fine-tunes a model by training tiny adapter matrices instead of all weights, making customisation cheap. Both produce smaller/specialised models that you'd then quantize and run on the NPU.`,
            link: { url: 'https://arxiv.org/abs/2106.09685', label: 'Paper: LoRA (Hu et al.)' },
          },
          {
            title: 'Multimodal & vision-language models (VLMs)',
            body: `<b>VLMs</b> accept images (and sometimes audio) alongside text — describing pictures, reading documents, answering visual questions. They pair a vision encoder with the language model. Support on the NPU depends on the runtime exposing the vision path; see the oRKLLM wiki for current status.`,
            link: { url: 'https://github.com/oRKLLM/oRKLLM/wiki', label: 'oRKLLM Wiki: hardware & model support' },
          },
        ],
      },
    ],

    resources: [
      {
        category: 'oRKLLM project',
        icon: 'mdi-book-open-variant',
        color: 'primary',
        items: [
          { title: 'oRKLLM Wiki', desc: 'Hardware research, NPU optimisation, Eagle-3 findings', url: 'https://github.com/oRKLLM/oRKLLM/wiki' },
          { title: 'oRKLLM on GitHub', desc: 'Source, releases, and issue tracker', url: 'https://github.com/oRKLLM/oRKLLM' },
          { title: 'rkllm-runtimes mirror', desc: 'Versioned librkllmrt.so downloads', url: 'https://github.com/oRKLLM/rkllm-runtimes' },
        ],
      },
      {
        category: 'Models & conversion',
        icon: 'mdi-cube-outline',
        color: 'teal',
        items: [
          { title: 'Hugging Face', desc: 'Find models — filter by the rkllm / rk3588 tags', url: 'https://huggingface.co/models?other=rkllm' },
          { title: 'rknn-llm (rkllm-toolkit)', desc: 'Rockchip’s SDK for converting models to .rkllm', url: 'https://github.com/airockchip/rknn-llm' },
          { title: 'GGUF format explained', desc: 'The quantized format used by the llama runtime', url: 'https://huggingface.co/docs/hub/gguf' },
        ],
      },
      {
        category: 'Inference engines',
        icon: 'mdi-engine-outline',
        color: 'deep-purple',
        items: [
          { title: 'llama.cpp', desc: 'The open inference engine behind the GGUF runtime', url: 'https://github.com/ggml-org/llama.cpp' },
          { title: 'EAGLE / EAGLE-3', desc: 'The speculative-decoding method oRKLLM implements', url: 'https://github.com/SafeAILab/EAGLE' },
          { title: 'ork-driver', desc: 'oRKLLM’s open userspace NPU driver project', url: 'https://github.com/oRKLLM/ork-driver' },
        ],
      },
      {
        category: 'Using your endpoint',
        icon: 'mdi-api',
        color: 'cyan',
        items: [
          { title: 'Open WebUI', desc: 'A full chat UI you can point at your oRKLLM endpoint', url: 'https://github.com/open-webui/open-webui' },
          { title: 'Model Context Protocol', desc: 'The open standard for connecting tools to models', url: 'https://modelcontextprotocol.io' },
          { title: 'OpenAI API reference', desc: 'The request/response format oRKLLM is compatible with', url: 'https://platform.openai.com/docs/api-reference/chat' },
        ],
      },
    ],
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    filteredGlossary() {
      const q = (this.glossarySearch || '').trim().toLowerCase();
      const list = q
        ? this.glossary.filter(e =>
            e.term.toLowerCase().includes(q) || e.def.toLowerCase().includes(q))
        : this.glossary.slice();
      return list.sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
    },
  },
  mounted() {
    this.fetchAuth();
  },
  methods: {
    async fetchAuth() {
      try {
        const res = await fetch('/api/admin/auth-status');
        const data = await res.json();
        if (data.user) this.user = data.user;
        else if (data.username) this.user = { username: data.username, role: 'admin', authProvider: 'local' };
      } catch (e) {}
    },
    toggleTheme() {
      const next = this.isDark ? 'customLightTheme' : 'customDarkTheme';
      this.themeName = next;
      localStorage.setItem('orkllm-theme', next);
      try {
        this.$vuetify.theme.global.name.value = next;
      } catch {
        this.$vuetify.theme.global.name = next;
      }
    },
    async logout() {
      try {
        await fetch('/api/admin/logout', { method: 'POST' });
        this.$router.push('/login');
      } catch (e) {}
    },
  },
};
</script>

<style scoped>
.bg-slate-page {
  background: #0B0F19 !important;
}
.v-theme--customLightTheme .bg-slate-page {
  background: #F1F5F9 !important;
}
.page-container {
  max-width: 1100px;
  margin-inline: auto;
}

.glass-card {
  background: rgba(17, 24, 39, 0.7) !important;
  backdrop-filter: blur(16px);
  border: 1px solid rgba(139, 92, 246, 0.15) !important;
  border-radius: 12px !important;
}
.v-theme--customLightTheme .glass-card {
  background: rgba(255, 255, 255, 0.85) !important;
  border: 1px solid rgba(124, 58, 237, 0.2) !important;
}

.concept-panels {
  overflow: hidden;
}
.concept-body {
  line-height: 1.65;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.85;
}
.concept-body :deep(code) {
  background: rgba(124, 58, 237, 0.12);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.85em;
}
.quick-card {
  transition: transform 0.15s ease;
}
.quick-card:hover {
  transform: translateY(-2px);
}
.link-item:hover {
  background: rgba(124, 58, 237, 0.08);
}
.glossary-entry {
  border-bottom: 1px solid rgba(139, 92, 246, 0.08);
}
.glossary-entry :deep(code) {
  background: rgba(124, 58, 237, 0.12);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.85em;
}
</style>
