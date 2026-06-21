# [0.9.0](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0...v0.9.0) (2026-06-21)


### Bug Fixes

* **bench:** invoke backend abort endpoint on benchmark cancellation ([46aa985](https://github.com/oRKLLM/oRKLLM/commit/46aa9857d629eec3801c6c4312d954903285c009))
* **chat:** prevent duplicate message bubbles on reload during active inference ([c892898](https://github.com/oRKLLM/oRKLLM/commit/c89289826e41b35df5506ff931ef1a11d0aa3b45))


### Features

* **chat:** show animating dots in message bubble during prefill stage ([74a765f](https://github.com/oRKLLM/oRKLLM/commit/74a765f7a71e5024b8db9a0e09f035e4e3499bb5))
* **dashboard:** make hardware telemetry card responsive on mobile viewports ([1c4dafc](https://github.com/oRKLLM/oRKLLM/commit/1c4dafcab219a9816b7dfa39c571c8de8bf7809d))
* **eagle3:** add detailed Vulkan initialization error logging to VkEagleDraftHead::init ([7bdeb2d](https://github.com/oRKLLM/oRKLLM/commit/7bdeb2d0501e22e19539e2e1f3436169cbb487bd))
* refactor tables for responsive layouts and fix mobile viewport blowouts ([ce78821](https://github.com/oRKLLM/oRKLLM/commit/ce78821fc4822424e96238662678244673c30d66))
* **settings:** show directory paths of downloadable runtimes and libraries ([c96bfe4](https://github.com/oRKLLM/oRKLLM/commit/c96bfe45f6be8666db1460fa435151692d6c9684))
* **spec-decode:** support prefix-insensitive safetensors lookup and log dimension mismatch ([da534a5](https://github.com/oRKLLM/oRKLLM/commit/da534a5f895dbc48afd83543243e76b87d2ebcc9))

# [0.8.0](https://github.com/oRKLLM/oRKLLM/compare/v0.7.0...v0.8.0) (2026-06-20)


### Bug Fixes

* **addon:** align llama_model_params and llama_context_params ABI layouts ([cd95883](https://github.com/oRKLLM/oRKLLM/commit/cd9588308b3c51d0d6f14a2ebe649281b5688fa8))
* **addon:** allocate token buffer with correct capacity for llama state load ([5735601](https://github.com/oRKLLM/oRKLLM/commit/57356015c2f2ce86c9b8bddd0174ada7c3d4732d))
* **addon:** capture inferMode in lambda for RKLLM_INFER_GET_LOGITS mode ([117c223](https://github.com/oRKLLM/oRKLLM/commit/117c223a4b4d2e2e98f321ba901e129575cfc296))
* **admin:** allow empty prompt in infer-with-cache when loadCachePath set ([24bed01](https://github.com/oRKLLM/oRKLLM/commit/24bed01fea8859ac85023d7f7d8738437f6ea6d7))
* **api:** hide gguf reasoning on output when thinking is off ([ef5c1ca](https://github.com/oRKLLM/oRKLLM/commit/ef5c1ca0458c48ca2626a707b7bc33f443e1659c))
* **api:** set X-Accel-Buffering:no on SSE so streaming isn't proxy-buffered ([3803d37](https://github.com/oRKLLM/oRKLLM/commit/3803d378453ca075b95a4bd23e6803047335d34a))
* **api:** SSE heartbeat so long/silent decodes don't get dropped by proxy timeouts ([a1d04d9](https://github.com/oRKLLM/oRKLLM/commit/a1d04d975fa22b7b6f7323c2a7208c25ad4a2ef8))
* **autoload:** always attempt pinned model load on startup ([dae7ab6](https://github.com/oRKLLM/oRKLLM/commit/dae7ab6176b5dc9bb0af0d3d24af63678635f472))
* **autoload:** restore RAM pre-check + evict non-pinned model first ([e527671](https://github.com/oRKLLM/oRKLLM/commit/e527671625c10b459bd1c66d7d49a8eef82126bc))
* **bench:** bypass KV prefix cache so prefill_tps is always measured ([95e3697](https://github.com/oRKLLM/oRKLLM/commit/95e369787c20355953b731016bd1817a242cce7e))
* **bench:** fix ReferenceError — destructure no_cache from request body ([a1ca321](https://github.com/oRKLLM/oRKLLM/commit/a1ca321c0166e153dce65691b5241ee16c390692))
* **bench:** use server-reported token count for prefill tok/s ([442a5ac](https://github.com/oRKLLM/oRKLLM/commit/442a5ac398877fef651b619c841ff2b6dff55dd6))
* **cache,ui:** hot→cold overflow + Models page live status poll ([623cbb9](https://github.com/oRKLLM/oRKLLM/commit/623cbb90e35adc758f5053b80d32925cb4af470e))
* **cache:** disable prefix cache for recurrent gguf models; LFM2.5 settings toggle ([a2bf2af](https://github.com/oRKLLM/oRKLLM/commit/a2bf2affad0e0b9f09451f45385aeb03a0f0adde))
* **cache:** empty cache_dir falls back to default; migrate misplaced files ([1a3dbd5](https://github.com/oRKLLM/oRKLLM/commit/1a3dbd5d89765be88c65d373c688edb3fdeba756))
* **cache:** hot=0 writes to cold directly; hot→cold overflow instead of delete ([f5755ec](https://github.com/oRKLLM/oRKLLM/commit/f5755ec81117ac7a6b4ae6c48afe04100d9a1306))
* **cache:** key the prefix cache by the assistant turn so follow-ups resume ([15b9f3d](https://github.com/oRKLLM/oRKLLM/commit/15b9f3d7f22d957ee2cd7ae5561a4a00c5af2f8c))
* **chat:** abort the worker when the client disconnects mid-stream ([e12c093](https://github.com/oRKLLM/oRKLLM/commit/e12c093664350833f23105f2e5d34249e3348b12))
* **chat:** explicit POST /api/admin/abort so Stop works behind a reverse proxy ([cc9e319](https://github.com/oRKLLM/oRKLLM/commit/cc9e319f1d308057d1713489ee87f9ff928b5ee5))
* **chat:** fix SPA chat remount persistence and stream session recovery ([037f458](https://github.com/oRKLLM/oRKLLM/commit/037f458a81baa8c3c0febb8188873655e8d80520))
* **chat:** MCP toggle off now removes injected tool block ([d2a40ed](https://github.com/oRKLLM/oRKLLM/commit/d2a40ed3ab3cb10a8385591497e12f5d4c4dc251))
* **chat:** recover generating state from backend so Stop survives SSE drops ([007a2c7](https://github.com/oRKLLM/oRKLLM/commit/007a2c7dd3a203125bd31bf7d047de63c0d5516c))
* **chat:** stop nginx 504 HTML on cold model load + handle non-JSON errors ([d951e2d](https://github.com/oRKLLM/oRKLLM/commit/d951e2d5733a15d463af3683649369080f9c7f03))
* **chat:** use plain-text MCP block delimiters; add README affiliation disclaimer ([2989d17](https://github.com/oRKLLM/oRKLLM/commit/2989d171c11e154d16acdb28bfefe0d862daabb1))
* **chat:** wire llama abort callback so Stop interrupts an in-flight decode/prefill ([155bda8](https://github.com/oRKLLM/oRKLLM/commit/155bda8520d0fa33c8c1f4bb4b276e04f774d4d0))
* **ci:** fetch semantic-release Git notes before release ([66f664c](https://github.com/oRKLLM/oRKLLM/commit/66f664c39a75315d107d90a582ba08bbb4a32cc1))
* **ci:** make postinstall hook installer non-fatal when scripts/ is absent ([001d428](https://github.com/oRKLLM/oRKLLM/commit/001d4285c18ff8f7a87c81373e0a8d7ffab3595f))
* **ci:** serialize Release runs to stop the concurrent-release race ([78107d9](https://github.com/oRKLLM/oRKLLM/commit/78107d94d703c546e656159b974258d7c7a1638c)), closes [#pages](https://github.com/oRKLLM/oRKLLM/issues/pages)
* **dashboard:** hide system runtime row when library file is absent ([a19594f](https://github.com/oRKLLM/oRKLLM/commit/a19594fbf1bfc764e95df4b74cdc99407cc49649))
* **dashboard:** show effective RKLLM runtime (newest installed) instead of fallback path ([25cb94c](https://github.com/oRKLLM/oRKLLM/commit/25cb94c4f1dcd9d42b28da227d688b03526b0d76))
* **db:** replace better-sqlite3 fallback with pure-WASM node-sqlite3-wasm ([2c923dc](https://github.com/oRKLLM/oRKLLM/commit/2c923dc0797612e8d5a6ee54299d6882a7c0b3fc))
* **db:** self-heal stale node-sqlite3-wasm lock that crash-loops the service ([a61ebf4](https://github.com/oRKLLM/oRKLLM/commit/a61ebf4307e7f1608a6cce32091fc7b00bae3105))
* **deb:** declare libgomp1 dependency (required by librkllmrt.so) ([3c52f80](https://github.com/oRKLLM/oRKLLM/commit/3c52f800375b29cf489f14e910cc82e491b9ceed))
* **deb:** restart service on upgrade so new code loads ([0b38f12](https://github.com/oRKLLM/oRKLLM/commit/0b38f12f0d48b9d82dd8a2d65be754a329e675a8))
* **downloader:** fetch PyTorch-format Eagle-3 heads (pytorch_model.bin) ([edbe184](https://github.com/oRKLLM/oRKLLM/commit/edbe18480248b1f6272df1fd08bb1761ef03a0b5))
* **downloader:** nest downloads under owner/repo to avoid same-name collision ([fb0c5a4](https://github.com/oRKLLM/oRKLLM/commit/fb0c5a4809dd3c1b5b0fa0ba4d3425cef411ca9a))
* **e2e:** relax token_id assertion in prefillAndCache test for mock engine ([769f4b9](https://github.com/oRKLLM/oRKLLM/commit/769f4b944a592a20450c04d8c78b66d98ca0614d))
* **eagle3:** catch NPU errors and fall back gracefully instead of crashing request ([a0fe0e1](https://github.com/oRKLLM/oRKLLM/commit/a0fe0e18adb01e5a2618bdbc8fa4e40deae7db1d))
* **eagle3:** never let a dead worker crash the server ([6d487e6](https://github.com/oRKLLM/oRKLLM/commit/6d487e6d35eb32ccfab463f38c958e0fb0780d89))
* **eagle3:** resolve draft head path to absolute so the Vulkan draft can load ([b1a678c](https://github.com/oRKLLM/oRKLLM/commit/b1a678c9cfe96ae83ac8f1f8a61374c5208474b5))
* **eagle3:** resolve on hidden_states/logits instead of FINISH ([5aad2d1](https://github.com/oRKLLM/oRKLLM/commit/5aad2d1983f89411b7749d4464a3ace37ffe0e66))
* **eagle3:** return full perf object; guard Chat.vue perf display against undefined ([39fe808](https://github.com/oRKLLM/oRKLLM/commit/39fe8088d06b507e5121e82fdb14f1b9067e5151))
* **eagle3:** skip safetensors __metadata__ so the Vulkan draft head loads ([470628a](https://github.com/oRKLLM/oRKLLM/commit/470628af53871f462519d30459e34dfe7d96e804))
* **eagle3:** stop at end-of-text instead of running to max tokens ([c40e854](https://github.com/oRKLLM/oRKLLM/commit/c40e8540d01ffa12dc7b7a5c5dbd3eff85aa9ef2))
* **eagle3:** vulkan draft head is GGUF, not safetensors ([04e81aa](https://github.com/oRKLLM/oRKLLM/commit/04e81aa27018cbdd20ab4417e8724ff9ecae4ec1))
* **eagle3:** wire RKLLM_INPUT_TOKEN + keep_history; fix text emission; k=8 default ([dcb5349](https://github.com/oRKLLM/oRKLLM/commit/dcb53495f7198bee23ae81be1007a95e86090765))
* **experimental:** drop unsafe data-ptr weight cache; extract rk_prepare_B helper ([3863c83](https://github.com/oRKLLM/oRKLLM/commit/3863c83dea31fbc7b83693ba486f602ee387e6b7))
* **gguf:** apply the model's own chat template (non-ChatML models like LFM2) ([9367c81](https://github.com/oRKLLM/oRKLLM/commit/9367c81f47ff84824d07b4f5818dfc6452908658))
* **gguf:** honour max_new_tokens and per-request sampling on the llama path ([a6e8045](https://github.com/oRKLLM/oRKLLM/commit/a6e8045560ecdcc090cd38b27889a691ead777f7))
* **gguf:** honour the thinking toggle for llama/gguf models ([f97dbf4](https://github.com/oRKLLM/oRKLLM/commit/f97dbf46134fc895f729bbb90f685fec99192977))
* **gguf:** honour thinking-off on the chat-template path (LFM2 thought despite setting) ([4d04930](https://github.com/oRKLLM/oRKLLM/commit/4d0493010b3660bd5c2a4077dcf9d58fa2c085dd))
* **gguf:** reset recurrent memory between runs (LFM2 blank after first gen); pad chat input bar ([2a2c7fb](https://github.com/oRKLLM/oRKLLM/commit/2a2c7fbacdbc25f60fdbf66c33df7a007b459d31))
* **gguf:** suppress thinking for self-emitting reasoning models (LFM2) + diagnostic ([39fdf92](https://github.com/oRKLLM/oRKLLM/commit/39fdf925b6843e8371e2940dae486fad9ac9bfba))
* **kvcache_quant:** correct relative path to native addon (../build not ../../build) ([328511a](https://github.com/oRKLLM/oRKLLM/commit/328511aac083199173557224c8a50fb6c5721782))
* **kvcache_quant:** derive fixed_overhead dynamically per file ([b645f18](https://github.com/oRKLLM/oRKLLM/commit/b645f18f49c2b64c2226979646d52e2ce43cd6a4))
* **kvcache_quant:** use FP32 NEON arithmetic to avoid FP16 extension requirement ([23651aa](https://github.com/oRKLLM/oRKLLM/commit/23651aa4b81a596c3bba5e4eac0ae5c95ec18f47))
* **kvcache:** rebuild kvcache_quant_napi with Vulkan support on ARM64 ([a23761c](https://github.com/oRKLLM/oRKLLM/commit/a23761cf6582790201902ac15966c2323568fbce))
* **langfuse:** use @langfuse/tracing + @langfuse/otel (correct official SDK) ([146425f](https://github.com/oRKLLM/oRKLLM/commit/146425f8b0890686a4246c2d5e1b1aa22b6b8fcf))
* **langfuse:** use langfuse-node for trace/generation API ([0fff4f3](https://github.com/oRKLLM/oRKLLM/commit/0fff4f39d02f1b33fa5b2cdf322458162b1cf91a))
* **llama_sync:** wipe runtime dir before extract (clean install, no stale .so skew) ([60bdf42](https://github.com/oRKLLM/oRKLLM/commit/60bdf4240a7e3efe7d1ee0d08fb38b1094febd8b))
* **llama-napi:** add complete llama_sampler_chain_params definition ([8bc92b0](https://github.com/oRKLLM/oRKLLM/commit/8bc92b07aed86ab3aedf7218fcef3522ce659d6d))
* **llama-napi:** fix dlsym symbol names; rename Dashboard runtime card to Inference Engines ([c2bc029](https://github.com/oRKLLM/oRKLLM/commit/c2bc0292910728f5ebc83f3004e1910a4f559f88))
* **llama-napi:** fix llama_model_params and llama_context_params struct layouts ([ddb5afa](https://github.com/oRKLLM/oRKLLM/commit/ddb5afaa7a14d57e070b727382eea78f7b11d6e4))
* **llama-napi:** pass llama_vocab* (not llama_model*) to tokenize/tok2piece/is_eog ([f751b64](https://github.com/oRKLLM/oRKLLM/commit/f751b640be9f069efceafcf0dde57bb3775ae8da))
* **llama-runtime:** correct version-string fields (ork-driver showed '?') ([93ef15b](https://github.com/oRKLLM/oRKLLM/commit/93ef15b3042f87d22c5ecfb11b81c3f448e814b9))
* **llama-runtime:** extract symlinks in runtime bundles (libllama.so was stale) ([1478ab7](https://github.com/oRKLLM/oRKLLM/commit/1478ab730fb349b58ca769819c3b025f4c97ad5a))
* **llama:** default no-mmap for gguf to stop weight duplication on offload ([6ba957e](https://github.com/oRKLLM/oRKLLM/commit/6ba957e8bb01e34608001e0c6f8f8f003ff3fa1d))
* **llama:** suppress Eagle-3 for gguf models; clear KV cache before each run ([7a53ee1](https://github.com/oRKLLM/oRKLLM/commit/7a53ee1f0cc6eb4cf2921e6a2ca930c30d90e8aa))
* **load:** async model load (202 + status poll) so slow gguf swaps survive proxy timeouts ([d71e21b](https://github.com/oRKLLM/oRKLLM/commit/d71e21b464591591540945f96a148c2b8129ca40))
* **mcp:** compact tool catalogue so it fits the context window ([79ff5b9](https://github.com/oRKLLM/oRKLLM/commit/79ff5b997cafcdd8879091adc6af6c66cba9add9))
* **models:** auto-unload timeout now displays saved value after refresh ([0d93a47](https://github.com/oRKLLM/oRKLLM/commit/0d93a47c2fb6f72392f06a543ce08c86f420ae2c))
* **models:** clean error for non-JSON responses on download paths ([c3cedae](https://github.com/oRKLLM/oRKLLM/commit/c3cedaed498188252bbe8bf0f2faf2a712d0753c))
* **models:** fix manual Find Files (wrong response shape) + regression test ([cc0ff9d](https://github.com/oRKLLM/oRKLLM/commit/cc0ff9d9e194cfaca8a3846c9b2e3b784a09ea04))
* **models:** make Ctx Window / Max New Tokens values readable ([ef5e64c](https://github.com/oRKLLM/oRKLLM/commit/ef5e64cfd25b4763bedd8cce794943789cf3403c))
* **models:** only show the download file-picker for true multi-quant repos ([51129b5](https://github.com/oRKLLM/oRKLLM/commit/51129b5f61706d86b81115a8786155d78112d252))
* **models:** persist idle timeout to DB on save ([d47521d](https://github.com/oRKLLM/oRKLLM/commit/d47521d68bc4b446ecce541d6bb3dc2208e49fd9))
* **models:** surface eagle3 heads by dir name; add draft heads section to manager tab ([c1692e0](https://github.com/oRKLLM/oRKLLM/commit/c1692e06f141ea715504fb0e11cd950fe68195b8))
* **monitor:** count mmap'd model pages as used RAM ([cd357f0](https://github.com/oRKLLM/oRKLLM/commit/cd357f02cbd9bd3a9bb7244978219d217c686d25))
* **monitor:** NPU load is mean across all cores, not just Core0 ([713f2de](https://github.com/oRKLLM/oRKLLM/commit/713f2de9e3bd1dc804ee3e3003fad2b55183e78f))
* **monitor:** read Mali GPU load from the devfreq node, not absent debugfs paths ([68b587d](https://github.com/oRKLLM/oRKLLM/commit/68b587d7e03f32e4f327709e50db7f3864b682df))
* point canonical repo links at oRKLLM/oRKLLM (not the mafischer mirror) ([1357cbe](https://github.com/oRKLLM/oRKLLM/commit/1357cbe7d4794a87e54f791d0a9e3d520fa55ad4))
* **pool:** guard slot.worker null in onExit to prevent server crash on failed load ([7219740](https://github.com/oRKLLM/oRKLLM/commit/7219740003ca59721baf838a294fb15c501278eb))
* **pool:** keep model layers on the NPU — disable Vulkan unless TurboQuant KV ([4e7537b](https://github.com/oRKLLM/oRKLLM/commit/4e7537bb54c7ce93b79e956cc77e9cddab44b604))
* **pool:** null-safe load handshake + process-level guard so a swap race can't crash the server ([16dc629](https://github.com/oRKLLM/oRKLLM/commit/16dc629d9a42e781c5eed94792e59cf85822c451))
* **pool:** revert domain pinning — base_domain_id has no effect on RK3576 ([d683709](https://github.com/oRKLLM/oRKLLM/commit/d683709eff9906a7404af9aa86d01eaff7fa05a4))
* **pool:** scale model load timeout to file size (was a flat 60s) ([db14b60](https://github.com/oRKLLM/oRKLLM/commit/db14b60a02ba7b1d6588fb21cf55b0d90715f718))
* **pool:** set worker LD_LIBRARY_PATH so prebuilt libllama finds its ggml siblings ([c737406](https://github.com/oRKLLM/oRKLLM/commit/c7374062166d994bdcb062dfeefc832d39e7fa8d))
* **pool:** use advanced IPC serialization for worker fork ([0117ab3](https://github.com/oRKLLM/oRKLLM/commit/0117ab3321a1961dfe33b4614a0ea167c4d03ad4))
* **pool:** wire context length to load so prompts don't overflow a 2048 default ([c2612c6](https://github.com/oRKLLM/oRKLLM/commit/c2612c640efdfd4152b2021aecd7eb559694e110))
* **pwa:** deterministic update on refresh; credit llama.cpp + license gate ([b86ef19](https://github.com/oRKLLM/oRKLLM/commit/b86ef19bd0648c5ea3976664487498992cb2488b))
* **pwa:** guard SW version-check reload to prevent infinite loop ([d52563e](https://github.com/oRKLLM/oRKLLM/commit/d52563e726e8deca5cef6c380c9a038186430247))
* **pwa:** key SW reload guard to server version to survive multiple deploys in same tab session ([caa877f](https://github.com/oRKLLM/oRKLLM/commit/caa877f7cdabb2ef4c4e0a6f048ce0227cec254b))
* **release:** correct target_commitish on migrated releases — semantic-release should now find v0.8.0-alpha.1 ([ef11f6c](https://github.com/oRKLLM/oRKLLM/commit/ef11f6c50a740c04ccff14c4f3ac53aa6e2fb8c4))
* **routes:** remove accidentally committed scratch test files; gitignore test_*.js ([1c8e996](https://github.com/oRKLLM/oRKLLM/commit/1c8e9962b843dc19d1addb0af7fb8efa4e8d7ebd))
* **runtime_sync:** temp revert to mafischer mirror — oRKLLM CDN settling ([218b56b](https://github.com/oRKLLM/oRKLLM/commit/218b56b533cc3ca694920803e3ff87c4abdc30ad))
* **settings:** cap NPU pool-size slider at the chipset's core count ([a980e7a](https://github.com/oRKLLM/oRKLLM/commit/a980e7ad0cb11d6e1da90dc7bd6ce7eac9fee612))
* **settings:** poll prefix-cache stats so observability updates live ([f786211](https://github.com/oRKLLM/oRKLLM/commit/f78621179aa4595d70c5442fca55c343b06b0371))
* **spec-decode:** detect single-NPU deadlock and fall back to standard generate ([fcd898f](https://github.com/oRKLLM/oRKLLM/commit/fcd898f4bdd6ff137e2ee4f4febdb5823176e886))
* **spec-decode:** load draft with max_new_tokens=1; fix token verification logic ([c451b17](https://github.com/oRKLLM/oRKLLM/commit/c451b17421eaceba4fd658415f02ae53a630c7e4))
* **spec-decode:** rename 'dflash' to 'speculative' — applies to any draft model pairing ([192789a](https://github.com/oRKLLM/oRKLLM/commit/192789ad3cb253cbaad2c2d42a45be514f682d60))
* **spec-decode:** wait for state=2 after abort to flush IPC before next run ([d7b2f7f](https://github.com/oRKLLM/oRKLLM/commit/d7b2f7fde50ff564e1c285b32c0972bc57e36264))
* **tailscale:** bind serve to the node's current name (reset + wait) ([4afedd8](https://github.com/oRKLLM/oRKLLM/commit/4afedd890ac0005574c2b82c5ab474f82da23f5f))
* **thinking:** disable reasoning per-model via template, hide option when unsupported ([01c4e3a](https://github.com/oRKLLM/oRKLLM/commit/01c4e3ab486274d3c5bece15e809d89821d6c5b7))
* **thinking:** strip the empty <think></think> marker Qwen3 emits when reasoning is off ([f6fbdba](https://github.com/oRKLLM/oRKLLM/commit/f6fbdba66b34f32dbafad9be5c7ae849fc90e3c8))
* **thinking:** strip the empty think marker for all gguf output, not just when seeded ([6b6662f](https://github.com/oRKLLM/oRKLLM/commit/6b6662f16fe7cad3d6197578f4f0e60a98d77aff))
* **ui:** allow downloading and searching .gguf models via HuggingFace UI ([d2e4310](https://github.com/oRKLLM/oRKLLM/commit/d2e4310afab7454477ebefafe50e424066e68bd4))
* **ui:** correct GPU accelerated label — pq8 (polar INT8) uses Vulkan, pq4 is NEON-only ([853533b](https://github.com/oRKLLM/oRKLLM/commit/853533b3a7b87821f0b7e938733482d3f1d8538e))
* **ui:** fix Vue template syntax in Langfuse secret key toggle ([e64e0d5](https://github.com/oRKLLM/oRKLLM/commit/e64e0d501578b9f10b6feadb12d1473e4b150901))
* **ui:** persist Bench and Chat state across navigation via shared stores ([6a6a8d0](https://github.com/oRKLLM/oRKLLM/commit/6a6a8d0f9469c5e295a7caa7e1cff252fe76f9db))
* **ui:** replace fixed 15ms dequantise estimate with per-MB rate (~0.3 ms/MB) ([89d6fb9](https://github.com/oRKLLM/oRKLLM/commit/89d6fb9656bbf1144b8ba6b7170ef3cb0b918380))
* **ui:** restore native_mtp option; add Eagle-3 model selector for draft head ([2cd9e48](https://github.com/oRKLLM/oRKLLM/commit/2cd9e485b648aef62898e23736a0bfa9475caa7e))
* **ui:** truly centre navbar links using position:absolute + translateX(-50%) ([c4a8e3c](https://github.com/oRKLLM/oRKLLM/commit/c4a8e3cc33db43b41b1df76ab95275b68d99a5c5))
* **ui:** widen spec_draft_tokens text field to match other numeric inputs ([9492098](https://github.com/oRKLLM/oRKLLM/commit/94920981564378295fcfd851fb1bf9b0e771e230))
* **vulkan:** add memoryBarrierShared() in parallel reduction ([02567ec](https://github.com/oRKLLM/oRKLLM/commit/02567ecd651575b37a837fe9295dd3243a6176e7))
* **vulkan:** correct pack_fp16 mantissa formula in GLSL shader ([c9ea2e3](https://github.com/oRKLLM/oRKLLM/commit/c9ea2e32b3c284b731d1d9f7880671698c2d515f))
* **vulkan:** deploy polar quant with corrected GPU shader ([67511a3](https://github.com/oRKLLM/oRKLLM/commit/67511a37faae8ab63402cd36d97ae65f609f969d))
* **vulkan:** trigger alpha.16 release with corrected polar INT8 GPU shader ([6ca22e9](https://github.com/oRKLLM/oRKLLM/commit/6ca22e991914abed7b0689c394701e77b16ac06a))


### Features

* **admin:** add /api/admin/infer-with-cache for explicit cache path testing ([3b9838b](https://github.com/oRKLLM/oRKLLM/commit/3b9838bbe913552f8039859d128b348d451785c4))
* **bench:** add two-turn chat benchmark script ([2f9c6e5](https://github.com/oRKLLM/oRKLLM/commit/2f9c6e5e92de0eae313541f6c2d840b5fb58e55f))
* **bench:** delete individual runs + report spec decode on all paths ([611f8c0](https://github.com/oRKLLM/oRKLLM/commit/611f8c0a8343657f095057cac76861a9356b28f4))
* **bench:** persist benchmark runs + Previous Runs history table ([d457935](https://github.com/oRKLLM/oRKLLM/commit/d457935cd6ce7b038243bb94aff04d3a515f38c0))
* **bench:** record speculative-decode status per run ([026d2cd](https://github.com/oRKLLM/oRKLLM/commit/026d2cd2e83075a88d1791beda8f47db86e48ef7))
* **chat:** per-tool MCP picker that actually drives inference ([fe7db0f](https://github.com/oRKLLM/oRKLLM/commit/fe7db0f9a8b0a9804954ed9dc1eb325f9a0e38d0))
* **chat:** show prefill speed (t/s) alongside prefill latency and decode rate ([681fc01](https://github.com/oRKLLM/oRKLLM/commit/681fc0106fff7bf055e13d41446aec194a8db6a6))
* **ci:** move badge JSON to gh-pages/assets/ — drop GIST_TOKEN ([4ef2e97](https://github.com/oRKLLM/oRKLLM/commit/4ef2e977efd940510c9b1050f1eb0cbd24698100))
* **dashboard:** 3x4 telemetry gauge grid (restore Swap, add Disk Write + Disk Temp) ([2857d1c](https://github.com/oRKLLM/oRKLLM/commit/2857d1cfbbb835bd9ff7e2065089a8148fd621c1))
* **dashboard:** add disk temperature to the device table ([7f859a2](https://github.com/oRKLLM/oRKLLM/commit/7f859a2f7ece2a663d1d307abcb027ee204d5b04))
* **dashboard:** Inference Engines card with accelerator devices table ([2d2334a](https://github.com/oRKLLM/oRKLLM/commit/2d2334ae9e5e7f6274aa4ff548a50c0a70d1fd61))
* **dashboard:** show driver-in-use + version per compute device ([6ac36f5](https://github.com/oRKLLM/oRKLLM/commit/6ac36f52663072f953b0abd51760acf4427f254a))
* **dashboard:** show Mali GPU model + shader-core count in the Compute table ([e2f0a17](https://github.com/oRKLLM/oRKLLM/commit/e2f0a17eb6fb1f0f6b8bc4b8e39bab15af655efd))
* **eagle3:** convert PyTorch-format draft heads to safetensors in pure Node ([226c8c6](https://github.com/oRKLLM/oRKLLM/commit/226c8c6af8c49b01cd27f83525bdc35fe680d360))
* **eagle3:** downloader + UI cover all 3 head formats ([efa8db3](https://github.com/oRKLLM/oRKLLM/commit/efa8db3118bc3d188a7e2d77302509794fb2d842))
* **eagle3:** draft compute target cpu/npu/vulkan + format-flexible downloader ([e55ad58](https://github.com/oRKLLM/oRKLLM/commit/e55ad58769b4dbc3d14d76a3356649a20bb80b32))
* **eagle3:** Eagle-3 speculative decoding — pipelined NPU+Mali inference ([f4ae767](https://github.com/oRKLLM/oRKLLM/commit/f4ae767389842b6f065c40fd777651ede7b3e8bf))
* **eagle3:** generalize Vulkan draft head to any EAGLE-3 head (derived dims + F16) ([96dc0d7](https://github.com/oRKLLM/oRKLLM/commit/96dc0d718a7f882df7743c0c6c74b4bba000c9f3)), closes [#462](https://github.com/oRKLLM/oRKLLM/issues/462)
* **eagle3:** native Vulkan draft head + base-model embeddings + model library ([67f34ee](https://github.com/oRKLLM/oRKLLM/commit/67f34ee996729eccbbf1514f45ff472fe9c24846))
* **eagle3:** reproducible binary patch for the verify-crash (ggml soft_max mask asserts) ([51643f0](https://github.com/oRKLLM/oRKLLM/commit/51643f01f18b3e8d776aca65f09ef280da1d4eba))
* **experimental:** 3-way CPU/NPU/Mali-GPU benchmark — decode-on-GPU is worst ([210bd3d](https://github.com/oRKLLM/oRKLLM/commit/210bd3dfd4b377f185f763945f942b87ff5609d0))
* **experimental:** correct per-weight cache via tensor->extra + backend benchmark ([a346ce6](https://github.com/oRKLLM/oRKLLM/commit/a346ce63c2b7f0859257d2671083c4825d005730))
* **experimental:** env-gated min-M for RKNPU MUL_MAT (prefill-only offload policy) ([37309bb](https://github.com/oRKLLM/oRKLLM/commit/37309bb26de54e2bb9499c8267903dc3536d784e))
* **experimental:** ggml_backend_rknpu Milestone 2 — NPU matmul validated via rknn_matmul_api ([a8d06b5](https://github.com/oRKLLM/oRKLLM/commit/a8d06b506eee73d87d2ae79719a27c380cb78cae))
* **experimental:** ggml_backend_rknpu Milestone 4 — MUL_MAT runs on NPU inside ggml, correct ([76a4697](https://github.com/oRKLLM/oRKLLM/commit/76a469775be8d4193fdc3d567ff74511e75a2d92))
* **experimental:** ggml_backend_rknpu v1 — padding, batching, F16/F32 (181 NPU cases pass) ([7c256c1](https://github.com/oRKLLM/oRKLLM/commit/7c256c1bb3020306223ca6b86461b400dfe29322))
* **experimental:** ggml_backend_rknpu v2 — quantized weights via dequant->fp16 ([c12fae7](https://github.com/oRKLLM/oRKLLM/commit/c12fae74a7cf8b15c3f8e5068d90adb0e694eb4b))
* **experimental:** NPU matmul benchmark — the GEMV-vs-GEMM verdict ([3f93212](https://github.com/oRKLLM/oRKLLM/commit/3f932126996944480eeaaa6ec0c8ffe0bef0a8ae))
* **experimental:** NPU quant-dtype benchmark — int8 prefill 2.6x, weight-only int modes unsupported ([6288fdd](https://github.com/oRKLLM/oRKLLM/commit/6288fdde653d8dbad300e055cda74233ac992535))
* **experimental:** persistent rknn ctx+weight-mem cache (LRU) — prefill now 6x CPU ([19ff079](https://github.com/oRKLLM/oRKLLM/commit/19ff07968a66ef609d74d6299e25df10c6ece63f))
* **experimental:** start ggml_backend_rknpu — RKNPU DRM uapi + hardware-validated probe ([8726761](https://github.com/oRKLLM/oRKLLM/commit/8726761fa556006ef544526ac9141c3533eff8ff))
* **experimental:** stride-aware src1 (permuted/non-contiguous activations) ([2abfbb2](https://github.com/oRKLLM/oRKLLM/commit/2abfbb2c5c8a920fdc80e1a9b12f806802a61c6b))
* **experimental:** sustained-decode benchmark — burst ranking flips (GPU wins warm) ([6fa576e](https://github.com/oRKLLM/oRKLLM/commit/6fa576e2103a8b5206da9b784cde426585b2cd3b))
* **experimental:** write ggml_backend_rknpu — ggml backend offloading MUL_MAT to the NPU ([1144db6](https://github.com/oRKLLM/oRKLLM/commit/1144db659bccce73eedcba143260bbfa0736abef))
* **gguf:** wire penalties, mirostat, min_p + random seed; apply penalties regardless of force_sampling ([7d3c9f0](https://github.com/oRKLLM/oRKLLM/commit/7d3c9f01b63ffb7b529caa2e03511bdd114863f8))
* **help:** add Help & Learning page with concepts, glossary, and curated links ([660eea4](https://github.com/oRKLLM/oRKLLM/commit/660eea4934be15c8888c03d480f806d9866cb005))
* implement Eagle-3 speculative decoding for llama backend ([61c3399](https://github.com/oRKLLM/oRKLLM/commit/61c3399ecb270bdd69bf6e42aa33aaa1fe921d39))
* **kvcache:** add INT8 KV cache quantise/dequantise (kvcache_quant.js) ([962e8dd](https://github.com/oRKLLM/oRKLLM/commit/962e8dda338ed0e7298d6aa21ea6068f7c7370a3))
* **kvcache:** add NEON SIMD N-API addon for async KV cache quant/dequant ([b3593a9](https://github.com/oRKLLM/oRKLLM/commit/b3593a9e3d5eed3d692556a0ae891078c75b2ab2))
* **kvcache:** add polar INT8 and polar INT4 quantisation schemes ([3f4d655](https://github.com/oRKLLM/oRKLLM/commit/3f4d65526da72515dde010d395ad5ae5c1bf9a29))
* **kvcache:** KV cache compression — UI settings + automatic quantisation ([51b0101](https://github.com/oRKLLM/oRKLLM/commit/51b0101f5cc123d827eac5811acc93b283d23f4a))
* **kvcache:** Vulkan compute path for polar INT8 on Mali-G52 (panvk/Mesa) ([4c7bfa3](https://github.com/oRKLLM/oRKLLM/commit/4c7bfa32ab9fa7adbd429d5f182752eacaa172a3))
* **kv:** expose TurboQuant via the KV Cache Compression control, single-pass SSD blob ([8d57bee](https://github.com/oRKLLM/oRKLLM/commit/8d57bee90e5f888058f7cd64c08151d8657ba9a4))
* **langfuse:** instrument inference with Langfuse tracing (@langfuse/client v5) ([4086df7](https://github.com/oRKLLM/oRKLLM/commit/4086df7c607330a659dbd4441b439c93d7a059f4))
* **llama-runtime:** default mirror to oRKLLM/llama.cpp-rockchip ([898cd40](https://github.com/oRKLLM/oRKLLM/commit/898cd40d40a79974f2776c7b1dcbf0afe93385d9))
* **llama-runtime:** default to latest, label it, trim picker to 10 newest ([2f2c01b](https://github.com/oRKLLM/oRKLLM/commit/2f2c01b46cff66a9801d04c01b9dd67e7fd6fa28))
* **llama-runtime:** license-acceptance gate before download ([0efc627](https://github.com/oRKLLM/oRKLLM/commit/0efc627852a2ec7c37f02456b4a8175f3088e718))
* **llama-runtime:** tag-based latest, content-aware update detection, force re-sync ([0154b2a](https://github.com/oRKLLM/oRKLLM/commit/0154b2af53cc9741786526dc8cd70e120f41257e))
* **llama:** selective Vulkan mode (ggml_vk_set_mode) + per-load n_gpu_layers ([8553635](https://github.com/oRKLLM/oRKLLM/commit/855363501e6de5d406e94db5e5af7357810c0938))
* **llama:** wire KV-cache quantization (TurboQuant) into the gguf backend ([64722b4](https://github.com/oRKLLM/oRKLLM/commit/64722b4cc87ea130f429ecc6f5c5a277cc399d40))
* **mcp:** auth-type selector + structured auth headers + failure logging ([ebbb81c](https://github.com/oRKLLM/oRKLLM/commit/ebbb81c9ae4e75e08f04f34929c0861c9ec8a26a))
* **mcp:** inject available-tools instructions into system prompt from Chat ([989160f](https://github.com/oRKLLM/oRKLLM/commit/989160f0579e56fe55b1c351c3876303f20dcb21))
* **mcp:** manage MCP servers in Settings + tool use in inference ([2342bc6](https://github.com/oRKLLM/oRKLLM/commit/2342bc6692ac2c5d3857947556f7c8d1d96e9822))
* **mcp:** per-tool allow-list + token-cost indicator ([ba22755](https://github.com/oRKLLM/oRKLLM/commit/ba22755a8e57d543dd0f19b77eb4cffe6a47f49a))
* **mcp:** select-all master checkbox in the tool picker ([ecc5950](https://github.com/oRKLLM/oRKLLM/commit/ecc59506a194813ae8cf0541ea2b98037f41d055))
* **models:** GGUF quant picker; accurate llama load-failure error ([5e021e4](https://github.com/oRKLLM/oRKLLM/commit/5e021e4f31aaa08853181f53a8832d6cfd2f4762))
* **monitor:** CPU governor throttle warning (mirrors DRAM); confirm DRAM max is dynamic ([dd6ed20](https://github.com/oRKLLM/oRKLLM/commit/dd6ed20107a0c3562434fe1b44fc91530768577f))
* **npu:** dynamic core count — cap pool + pin one core per model ([7d501d2](https://github.com/oRKLLM/oRKLLM/commit/7d501d2861bb8a8da03b4089ba19630e277db872))
* **npu:** per-model NPU execution precision (ORK_QUANT) + hybrid toggle (ORK_HYBRID) ([28252f9](https://github.com/oRKLLM/oRKLLM/commit/28252f996cfca94aca2a25e48f87b275ac60d778))
* **perf:** auto-manage CPU+DDR governors when a model is loaded ([0eb92e4](https://github.com/oRKLLM/oRKLLM/commit/0eb92e4833c898c5016cb9d6c65bc341a7d493c9))
* **perf:** pin governors at startup, hold for service lifetime (survive reboot) ([3b754af](https://github.com/oRKLLM/oRKLLM/commit/3b754af928467746ce80d1521eaff410027ade14))
* **pool:** add prefillAndCache() — abort-after-first-token KV cache warming ([6060823](https://github.com/oRKLLM/oRKLLM/commit/6060823f752181e05a16ca0de46ca7f9ac0d83ea))
* **pool:** auto-assign NPU domain per slot for clean parallel execution ([e900f55](https://github.com/oRKLLM/oRKLLM/commit/e900f557b7c528a7b93562a5f017e486c3c5dbd2))
* **pool:** multi-worker NPU pool — concurrent inference without containers ([ba32b7e](https://github.com/oRKLLM/oRKLLM/commit/ba32b7ef88b03a365f7ba745be70dbc458906b10))
* **pwa:** installable Progressive Web App ([d01d57b](https://github.com/oRKLLM/oRKLLM/commit/d01d57b02b45f50aa988d95200d37abad13bcb1b))
* **pwa:** version check on load to force update when client is stale ([afb5660](https://github.com/oRKLLM/oRKLLM/commit/afb56604054b21378bac4059cfb4b62374278556))
* **runtime_sync:** configurable mirror list with fallthrough ([321ca42](https://github.com/oRKLLM/oRKLLM/commit/321ca4274bce69835f5572b2a09c52fecb1b5b53))
* **runtime:** dual-runtime support — serve .gguf via llama.cpp-rockchip ggml-ork N-API addon alongside .rkllm ([350670c](https://github.com/oRKLLM/oRKLLM/commit/350670c8a2f9fd813a812bda6aea01cf6fe945d8))
* **settings:** dynamic cache-limit ceilings — hot <=50% RAM, cold <=80% disk ([c65a89e](https://github.com/oRKLLM/oRKLLM/commit/c65a89e6d19b8e7179f580e0b6152f38c4882dad))
* **spec-decode:** speculative decoding infrastructure ([1977f3a](https://github.com/oRKLLM/oRKLLM/commit/1977f3a1af83369e55d803659bcf8a42e6ea698d))
* **spv:** opt-in Vulkan SPIR-V shader fetch + gate Eagle-3 vulkan draft ([12a1c1b](https://github.com/oRKLLM/oRKLLM/commit/12a1c1b463f9b247934cec36d28b4022d5d5d694))
* **spv:** pick/switch Vulkan shader release tag from Settings ([133572f](https://github.com/oRKLLM/oRKLLM/commit/133572fd6923c3d2760ee569dee6f85d6b2d25b8))
* **tailscale:** optional Serve management (Site Management → Remote Access) ([0d3f192](https://github.com/oRKLLM/oRKLLM/commit/0d3f1920c1a0036afc781fb409aaed57e053ba99))
* **telemetry:** colocate memory/thermal gauges + add Swap (fills 3x3 grid) ([46b6f51](https://github.com/oRKLLM/oRKLLM/commit/46b6f51daf661f5877f3ebb70a77ec41242ebf48))
* **telemetry:** CPU fan speed + RAM bandwidth gauges ([b12613b](https://github.com/oRKLLM/oRKLLM/commit/b12613b2f4d0b3dc449db7f596c1358d95f319c5))
* **telemetry:** live disk read/write throughput; replace swap gauge with disk-read ([4c4ea67](https://github.com/oRKLLM/oRKLLM/commit/4c4ea6730f9c1101cbb7e5370959db3c1e88b056))
* **telemetry:** read userspace-driven PWM fans (DietPi/Armbian) ([2ce13ac](https://github.com/oRKLLM/oRKLLM/commit/2ce13ac79a5ca88dde63d9c8ebc9eda2695782fa))
* **ui:** add Eagle-3 draft heads filter to HuggingFace model search ([2f6537d](https://github.com/oRKLLM/oRKLLM/commit/2f6537d249645e363608975fff31bd8422e89ebb))
* **ui:** dynamic browser tab title per page (Dashboard, Models, etc.) ([fb1e6e1](https://github.com/oRKLLM/oRKLLM/commit/fb1e6e1137fbb08361075ca2e28a3d41a3c08b4c))
* **ui:** HF search — scrollable container with infinite scroll pagination ([24b3e58](https://github.com/oRKLLM/oRKLLM/commit/24b3e5885a7ac8b4be790640e8ff98ecb80d6e77))
* **ui:** link the navbar version string to the GitHub repo ([db5ce5b](https://github.com/oRKLLM/oRKLLM/commit/db5ce5b5a7a1f237ca0f116a19b99f19d11ded5d))
* **ui:** move Langfuse tracing config to Site Management → Observability tab ([753fed8](https://github.com/oRKLLM/oRKLLM/commit/753fed86e625aa740a75c5b8e0d1d1260af39039))
* **ui:** responsive Bench + Settings layouts use wide-screen space ([0ac6b29](https://github.com/oRKLLM/oRKLLM/commit/0ac6b2927ff87df329a04b5d8c36cf6c712ab283))
* **ui:** responsive Models tab uses wide-screen space ([dd90868](https://github.com/oRKLLM/oRKLLM/commit/dd90868029daf994de157142a96b622eaa96be50))
* **ui:** three-state NPU status alert — grey/yellow+spinner/green ([b10786d](https://github.com/oRKLLM/oRKLLM/commit/b10786d43457c51c81eb046d6950def3235f93a7))
* **vulkan:** add Mali GPU shaders for min-max INT8 and polar INT4 ([4cafe28](https://github.com/oRKLLM/oRKLLM/commit/4cafe28a80b199fe448575315877639d75f8c0fc))

# [0.8.0-alpha.56](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.55...v0.8.0-alpha.56) (2026-06-11)


### Bug Fixes

* **models:** surface eagle3 heads by dir name; add draft heads section to manager tab ([c1692e0](https://github.com/oRKLLM/oRKLLM/commit/c1692e06f141ea715504fb0e11cd950fe68195b8))

# [0.8.0-alpha.55](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.54...v0.8.0-alpha.55) (2026-06-11)


### Bug Fixes

* **chat:** use plain-text MCP block delimiters; add README affiliation disclaimer ([2989d17](https://github.com/oRKLLM/oRKLLM/commit/2989d171c11e154d16acdb28bfefe0d862daabb1))


### Features

* **chat:** per-tool MCP picker that actually drives inference ([fe7db0f](https://github.com/oRKLLM/oRKLLM/commit/fe7db0f9a8b0a9804954ed9dc1eb325f9a0e38d0))

# [0.8.0-alpha.54](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.53...v0.8.0-alpha.54) (2026-06-11)


### Bug Fixes

* **eagle3:** vulkan draft head is GGUF, not safetensors ([04e81aa](https://github.com/oRKLLM/oRKLLM/commit/04e81aa27018cbdd20ab4417e8724ff9ecae4ec1))


### Features

* **eagle3:** downloader + UI cover all 3 head formats ([efa8db3](https://github.com/oRKLLM/oRKLLM/commit/efa8db3118bc3d188a7e2d77302509794fb2d842))

# [0.8.0-alpha.53](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.52...v0.8.0-alpha.53) (2026-06-11)


### Bug Fixes

* **pwa:** deterministic update on refresh; credit llama.cpp + license gate ([b86ef19](https://github.com/oRKLLM/oRKLLM/commit/b86ef19bd0648c5ea3976664487498992cb2488b))

# [0.8.0-alpha.52](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.51...v0.8.0-alpha.52) (2026-06-11)


### Features

* **spv:** opt-in Vulkan SPIR-V shader fetch + gate Eagle-3 vulkan draft ([12a1c1b](https://github.com/oRKLLM/oRKLLM/commit/12a1c1b463f9b247934cec36d28b4022d5d5d694))
* **spv:** pick/switch Vulkan shader release tag from Settings ([133572f](https://github.com/oRKLLM/oRKLLM/commit/133572fd6923c3d2760ee569dee6f85d6b2d25b8))

# [0.8.0-alpha.51](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.50...v0.8.0-alpha.51) (2026-06-11)


### Features

* **eagle3:** draft compute target cpu/npu/vulkan + format-flexible downloader ([e55ad58](https://github.com/oRKLLM/oRKLLM/commit/e55ad58769b4dbc3d14d76a3356649a20bb80b32))
* **npu:** dynamic core count — cap pool + pin one core per model ([7d501d2](https://github.com/oRKLLM/oRKLLM/commit/7d501d2861bb8a8da03b4089ba19630e277db872))

# [0.8.0-alpha.50](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.49...v0.8.0-alpha.50) (2026-06-11)


### Features

* **pwa:** version check on load to force update when client is stale ([afb5660](https://github.com/oRKLLM/oRKLLM/commit/afb56604054b21378bac4059cfb4b62374278556))

# [0.8.0-alpha.49](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.48...v0.8.0-alpha.49) (2026-06-11)


### Features

* **bench:** persist benchmark runs + Previous Runs history table ([d457935](https://github.com/oRKLLM/oRKLLM/commit/d457935cd6ce7b038243bb94aff04d3a515f38c0))

# [0.8.0-alpha.48](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.47...v0.8.0-alpha.48) (2026-06-11)


### Bug Fixes

* **tailscale:** bind serve to the node's current name (reset + wait) ([4afedd8](https://github.com/oRKLLM/oRKLLM/commit/4afedd890ac0005574c2b82c5ab474f82da23f5f))

# [0.8.0-alpha.47](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.46...v0.8.0-alpha.47) (2026-06-11)


### Features

* **pwa:** installable Progressive Web App ([d01d57b](https://github.com/oRKLLM/oRKLLM/commit/d01d57b02b45f50aa988d95200d37abad13bcb1b))
* **tailscale:** optional Serve management (Site Management → Remote Access) ([0d3f192](https://github.com/oRKLLM/oRKLLM/commit/0d3f1920c1a0036afc781fb409aaed57e053ba99))

# [0.8.0-alpha.46](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.45...v0.8.0-alpha.46) (2026-06-11)


### Features

* **mcp:** select-all master checkbox in the tool picker ([ecc5950](https://github.com/oRKLLM/oRKLLM/commit/ecc59506a194813ae8cf0541ea2b98037f41d055))

# [0.8.0-alpha.45](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.44...v0.8.0-alpha.45) (2026-06-11)


### Features

* **mcp:** per-tool allow-list + token-cost indicator ([ba22755](https://github.com/oRKLLM/oRKLLM/commit/ba22755a8e57d543dd0f19b77eb4cffe6a47f49a))

# [0.8.0-alpha.44](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.43...v0.8.0-alpha.44) (2026-06-11)


### Bug Fixes

* **mcp:** compact tool catalogue so it fits the context window ([79ff5b9](https://github.com/oRKLLM/oRKLLM/commit/79ff5b997cafcdd8879091adc6af6c66cba9add9))

# [0.8.0-alpha.43](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.42...v0.8.0-alpha.43) (2026-06-11)


### Bug Fixes

* **chat:** MCP toggle off now removes injected tool block ([d2a40ed](https://github.com/oRKLLM/oRKLLM/commit/d2a40ed3ab3cb10a8385591497e12f5d4c4dc251))

# [0.8.0-alpha.42](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.41...v0.8.0-alpha.42) (2026-06-11)


### Bug Fixes

* **deb:** restart service on upgrade so new code loads ([0b38f12](https://github.com/oRKLLM/oRKLLM/commit/0b38f12f0d48b9d82dd8a2d65be754a329e675a8))

# [0.8.0-alpha.41](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.40...v0.8.0-alpha.41) (2026-06-11)


### Features

* **mcp:** auth-type selector + structured auth headers + failure logging ([301e15e](https://github.com/oRKLLM/oRKLLM/commit/301e15ecf708501eda495cc4697cfba3b41f4b97))
* **mcp:** inject available-tools instructions into system prompt from Chat ([c8994d0](https://github.com/oRKLLM/oRKLLM/commit/c8994d0be7d9e7f3bdcb75f8c175c6c0752b2f73))

# [0.8.0-alpha.40](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.39...v0.8.0-alpha.40) (2026-06-11)


### Features

* **mcp:** manage MCP servers in Settings + tool use in inference ([e2c6e96](https://github.com/oRKLLM/oRKLLM/commit/e2c6e96ef1ad420eb221410c2fcfa8a7229c1308))

# [0.8.0-alpha.39](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.38...v0.8.0-alpha.39) (2026-06-11)


### Bug Fixes

* **deb:** declare libgomp1 dependency (required by librkllmrt.so) ([45db0fc](https://github.com/oRKLLM/oRKLLM/commit/45db0fc030a395978dca1534ebaa099da477930e))
* **ui:** persist Bench and Chat state across navigation via shared stores ([b975571](https://github.com/oRKLLM/oRKLLM/commit/b975571b360b9c5ea3991ae40b76f28d63e632d0))

# [0.8.0-alpha.38](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.37...v0.8.0-alpha.38) (2026-06-10)


### Bug Fixes

* **db:** replace better-sqlite3 fallback with pure-WASM node-sqlite3-wasm ([273619f](https://github.com/oRKLLM/oRKLLM/commit/273619f54420698c26bb9049b81206a5b588ef13))

# [0.8.0-alpha.37](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.36...v0.8.0-alpha.37) (2026-06-04)


### Bug Fixes

* **eagle3:** wire RKLLM_INPUT_TOKEN + keep_history; fix text emission; k=8 default ([dcb5349](https://github.com/oRKLLM/oRKLLM/commit/dcb53495f7198bee23ae81be1007a95e86090765))

# [0.8.0-alpha.36](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.35...v0.8.0-alpha.36) (2026-06-04)


### Bug Fixes

* **ui:** restore native_mtp option; add Eagle-3 model selector for draft head ([2cd9e48](https://github.com/oRKLLM/oRKLLM/commit/2cd9e485b648aef62898e23736a0bfa9475caa7e))

# [0.8.0-alpha.35](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.34...v0.8.0-alpha.35) (2026-06-04)


### Features

* **eagle3:** Eagle-3 speculative decoding — pipelined NPU+Mali inference ([f4ae767](https://github.com/oRKLLM/oRKLLM/commit/f4ae767389842b6f065c40fd777651ede7b3e8bf))

# [0.8.0-alpha.34](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.33...v0.8.0-alpha.34) (2026-06-03)


### Features

* **ui:** add Eagle-3 draft heads filter to HuggingFace model search ([2f6537d](https://github.com/oRKLLM/oRKLLM/commit/2f6537d249645e363608975fff31bd8422e89ebb))

# [0.8.0-alpha.33](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.32...v0.8.0-alpha.33) (2026-06-03)


### Bug Fixes

* **langfuse:** use @langfuse/tracing + @langfuse/otel (correct official SDK) ([146425f](https://github.com/oRKLLM/oRKLLM/commit/146425f8b0890686a4246c2d5e1b1aa22b6b8fcf))

# [0.8.0-alpha.32](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.31...v0.8.0-alpha.32) (2026-06-03)


### Bug Fixes

* **langfuse:** use langfuse-node for trace/generation API ([0fff4f3](https://github.com/oRKLLM/oRKLLM/commit/0fff4f39d02f1b33fa5b2cdf322458162b1cf91a))
* **ui:** fix Vue template syntax in Langfuse secret key toggle ([e64e0d5](https://github.com/oRKLLM/oRKLLM/commit/e64e0d501578b9f10b6feadb12d1473e4b150901))

# [0.8.0-alpha.31](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.30...v0.8.0-alpha.31) (2026-06-03)


### Features

* **ui:** move Langfuse tracing config to Site Management → Observability tab ([753fed8](https://github.com/oRKLLM/oRKLLM/commit/753fed86e625aa740a75c5b8e0d1d1260af39039))

# [0.8.0-alpha.30](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.29...v0.8.0-alpha.30) (2026-06-03)


### Bug Fixes

* **pool:** revert domain pinning — base_domain_id has no effect on RK3576 ([d683709](https://github.com/oRKLLM/oRKLLM/commit/d683709eff9906a7404af9aa86d01eaff7fa05a4))

# [0.8.0-alpha.29](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.28...v0.8.0-alpha.29) (2026-06-03)


### Features

* **pool:** auto-assign NPU domain per slot for clean parallel execution ([e900f55](https://github.com/oRKLLM/oRKLLM/commit/e900f557b7c528a7b93562a5f017e486c3c5dbd2))

# [0.8.0-alpha.28](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.27...v0.8.0-alpha.28) (2026-06-03)


### Features

* **pool:** multi-worker NPU pool — concurrent inference without containers ([ba32b7e](https://github.com/oRKLLM/oRKLLM/commit/ba32b7ef88b03a365f7ba745be70dbc458906b10))

# [0.8.0-alpha.27](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.26...v0.8.0-alpha.27) (2026-06-03)


### Bug Fixes

* **autoload:** restore RAM pre-check + evict non-pinned model first ([e527671](https://github.com/oRKLLM/oRKLLM/commit/e527671625c10b459bd1c66d7d49a8eef82126bc))

# [0.8.0-alpha.26](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.25...v0.8.0-alpha.26) (2026-06-03)


### Bug Fixes

* **cache:** empty cache_dir falls back to default; migrate misplaced files ([1a3dbd5](https://github.com/oRKLLM/oRKLLM/commit/1a3dbd5d89765be88c65d373c688edb3fdeba756))

# [0.8.0-alpha.25](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.24...v0.8.0-alpha.25) (2026-06-03)


### Bug Fixes

* **autoload:** always attempt pinned model load on startup ([dae7ab6](https://github.com/oRKLLM/oRKLLM/commit/dae7ab6176b5dc9bb0af0d3d24af63678635f472))

# [0.8.0-alpha.24](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.23...v0.8.0-alpha.24) (2026-06-03)


### Bug Fixes

* **ui:** truly centre navbar links using position:absolute + translateX(-50%) ([c4a8e3c](https://github.com/oRKLLM/oRKLLM/commit/c4a8e3cc33db43b41b1df76ab95275b68d99a5c5))

# [0.8.0-alpha.23](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.22...v0.8.0-alpha.23) (2026-06-03)


### Features

* **ui:** HF search — scrollable container with infinite scroll pagination ([24b3e58](https://github.com/oRKLLM/oRKLLM/commit/24b3e5885a7ac8b4be790640e8ff98ecb80d6e77))

# [0.8.0-alpha.22](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.21...v0.8.0-alpha.22) (2026-06-03)


### Features

* **langfuse:** instrument inference with Langfuse tracing (@langfuse/client v5) ([4086df7](https://github.com/oRKLLM/oRKLLM/commit/4086df7c607330a659dbd4441b439c93d7a059f4))

# [0.8.0-alpha.21](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.20...v0.8.0-alpha.21) (2026-06-03)


### Features

* **ui:** three-state NPU status alert — grey/yellow+spinner/green ([b10786d](https://github.com/oRKLLM/oRKLLM/commit/b10786d43457c51c81eb046d6950def3235f93a7))

# [0.8.0-alpha.20](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.19...v0.8.0-alpha.20) (2026-06-03)


### Features

* **ui:** dynamic browser tab title per page (Dashboard, Models, etc.) ([fb1e6e1](https://github.com/oRKLLM/oRKLLM/commit/fb1e6e1137fbb08361075ca2e28a3d41a3c08b4c))

# [0.8.0-alpha.19](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.18...v0.8.0-alpha.19) (2026-06-03)


### Bug Fixes

* **cache,ui:** hot→cold overflow + Models page live status poll ([623cbb9](https://github.com/oRKLLM/oRKLLM/commit/623cbb90e35adc758f5053b80d32925cb4af470e))
* **cache:** hot=0 writes to cold directly; hot→cold overflow instead of delete ([f5755ec](https://github.com/oRKLLM/oRKLLM/commit/f5755ec81117ac7a6b4ae6c48afe04100d9a1306))
* **spec-decode:** detect single-NPU deadlock and fall back to standard generate ([fcd898f](https://github.com/oRKLLM/oRKLLM/commit/fcd898f4bdd6ff137e2ee4f4febdb5823176e886))

# [0.8.0-alpha.18](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.17...v0.8.0-alpha.18) (2026-06-03)


### Bug Fixes

* **ui:** correct GPU accelerated label — pq8 (polar INT8) uses Vulkan, pq4 is NEON-only ([853533b](https://github.com/oRKLLM/oRKLLM/commit/853533b3a7b87821f0b7e938733482d3f1d8538e))
* **ui:** replace fixed 15ms dequantise estimate with per-MB rate (~0.3 ms/MB) ([89d6fb9](https://github.com/oRKLLM/oRKLLM/commit/89d6fb9656bbf1144b8ba6b7170ef3cb0b918380))


### Features

* **vulkan:** add Mali GPU shaders for min-max INT8 and polar INT4 ([4cafe28](https://github.com/oRKLLM/oRKLLM/commit/4cafe28a80b199fe448575315877639d75f8c0fc))

# [0.8.0-alpha.17](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.16...v0.8.0-alpha.17) (2026-06-03)


### Bug Fixes

* **ui:** widen spec_draft_tokens text field to match other numeric inputs ([9492098](https://github.com/oRKLLM/oRKLLM/commit/94920981564378295fcfd851fb1bf9b0e771e230))

# [0.8.0-alpha.16](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.15...v0.8.0-alpha.16) (2026-06-03)


### Bug Fixes

* **ci:** fetch semantic-release Git notes before release ([66f664c](https://github.com/oRKLLM/oRKLLM/commit/66f664c39a75315d107d90a582ba08bbb4a32cc1))
* **release:** correct target_commitish on migrated releases — semantic-release should now find v0.8.0-alpha.1 ([ef11f6c](https://github.com/oRKLLM/oRKLLM/commit/ef11f6c50a740c04ccff14c4f3ac53aa6e2fb8c4))
* **runtime_sync:** temp revert to mafischer mirror — oRKLLM CDN settling ([218b56b](https://github.com/oRKLLM/oRKLLM/commit/218b56b533cc3ca694920803e3ff87c4abdc30ad))
* **vulkan:** add memoryBarrierShared() in parallel reduction ([02567ec](https://github.com/oRKLLM/oRKLLM/commit/02567ecd651575b37a837fe9295dd3243a6176e7))
* **vulkan:** correct pack_fp16 mantissa formula in GLSL shader ([c9ea2e3](https://github.com/oRKLLM/oRKLLM/commit/c9ea2e32b3c284b731d1d9f7880671698c2d515f))
* **vulkan:** deploy polar quant with corrected GPU shader ([67511a3](https://github.com/oRKLLM/oRKLLM/commit/67511a37faae8ab63402cd36d97ae65f609f969d))
* **vulkan:** trigger alpha.16 release with corrected polar INT8 GPU shader ([6ca22e9](https://github.com/oRKLLM/oRKLLM/commit/6ca22e991914abed7b0689c394701e77b16ac06a))


### Features

* **ci:** move badge JSON to gh-pages/assets/ — drop GIST_TOKEN ([4ef2e97](https://github.com/oRKLLM/oRKLLM/commit/4ef2e977efd940510c9b1050f1eb0cbd24698100))
* **kvcache:** KV cache compression — UI settings + automatic quantisation ([51b0101](https://github.com/oRKLLM/oRKLLM/commit/51b0101f5cc123d827eac5811acc93b283d23f4a))
* **runtime_sync:** configurable mirror list with fallthrough ([321ca42](https://github.com/oRKLLM/oRKLLM/commit/321ca4274bce69835f5572b2a09c52fecb1b5b53))

# [0.8.0-alpha.1](https://github.com/oRKLLM/oRKLLM/compare/v0.7.0...v0.8.0-alpha.1) (2026-06-03)


### Bug Fixes

* **addon:** capture inferMode in lambda for RKLLM_INFER_GET_LOGITS mode ([117c223](https://github.com/oRKLLM/oRKLLM/commit/117c223a4b4d2e2e98f321ba901e129575cfc296))
* **admin:** allow empty prompt in infer-with-cache when loadCachePath set ([24bed01](https://github.com/oRKLLM/oRKLLM/commit/24bed01fea8859ac85023d7f7d8738437f6ea6d7))
* **e2e:** relax token_id assertion in prefillAndCache test for mock engine ([769f4b9](https://github.com/oRKLLM/oRKLLM/commit/769f4b944a592a20450c04d8c78b66d98ca0614d))
* **kvcache_quant:** correct relative path to native addon (../build not ../../build) ([328511a](https://github.com/oRKLLM/oRKLLM/commit/328511aac083199173557224c8a50fb6c5721782))
* **kvcache_quant:** derive fixed_overhead dynamically per file ([b645f18](https://github.com/oRKLLM/oRKLLM/commit/b645f18f49c2b64c2226979646d52e2ce43cd6a4))
* **kvcache_quant:** use FP32 NEON arithmetic to avoid FP16 extension requirement ([23651aa](https://github.com/oRKLLM/oRKLLM/commit/23651aa4b81a596c3bba5e4eac0ae5c95ec18f47))
* **kvcache:** rebuild kvcache_quant_napi with Vulkan support on ARM64 ([a23761c](https://github.com/oRKLLM/oRKLLM/commit/a23761cf6582790201902ac15966c2323568fbce))
* **release:** correct target_commitish on migrated releases — semantic-release should now find v0.8.0-alpha.1 ([ef11f6c](https://github.com/oRKLLM/oRKLLM/commit/ef11f6c50a740c04ccff14c4f3ac53aa6e2fb8c4))
* **runtime_sync:** temp revert to mafischer mirror — oRKLLM CDN settling ([218b56b](https://github.com/oRKLLM/oRKLLM/commit/218b56b533cc3ca694920803e3ff87c4abdc30ad))
* **spec-decode:** load draft with max_new_tokens=1; fix token verification logic ([c451b17](https://github.com/oRKLLM/oRKLLM/commit/c451b17421eaceba4fd658415f02ae53a630c7e4))
* **spec-decode:** rename 'dflash' to 'speculative' — applies to any draft model pairing ([192789a](https://github.com/oRKLLM/oRKLLM/commit/192789ad3cb253cbaad2c2d42a45be514f682d60))
* **spec-decode:** wait for state=2 after abort to flush IPC before next run ([d7b2f7f](https://github.com/oRKLLM/oRKLLM/commit/d7b2f7fde50ff564e1c285b32c0972bc57e36264))
* **vulkan:** add memoryBarrierShared() in parallel reduction ([02567ec](https://github.com/oRKLLM/oRKLLM/commit/02567ecd651575b37a837fe9295dd3243a6176e7))
* **vulkan:** correct pack_fp16 mantissa formula in GLSL shader ([c9ea2e3](https://github.com/oRKLLM/oRKLLM/commit/c9ea2e32b3c284b731d1d9f7880671698c2d515f))
* **vulkan:** deploy polar quant with corrected GPU shader ([67511a3](https://github.com/oRKLLM/oRKLLM/commit/67511a37faae8ab63402cd36d97ae65f609f969d))
* **vulkan:** trigger alpha.16 release with corrected polar INT8 GPU shader ([6ca22e9](https://github.com/oRKLLM/oRKLLM/commit/6ca22e991914abed7b0689c394701e77b16ac06a))


### Features

* **admin:** add /api/admin/infer-with-cache for explicit cache path testing ([3b9838b](https://github.com/oRKLLM/oRKLLM/commit/3b9838bbe913552f8039859d128b348d451785c4))
* **ci:** move badge JSON to gh-pages/assets/ — drop GIST_TOKEN ([4ef2e97](https://github.com/oRKLLM/oRKLLM/commit/4ef2e977efd940510c9b1050f1eb0cbd24698100))
* **kvcache:** add INT8 KV cache quantise/dequantise (kvcache_quant.js) ([962e8dd](https://github.com/oRKLLM/oRKLLM/commit/962e8dda338ed0e7298d6aa21ea6068f7c7370a3))
* **kvcache:** add NEON SIMD N-API addon for async KV cache quant/dequant ([b3593a9](https://github.com/oRKLLM/oRKLLM/commit/b3593a9e3d5eed3d692556a0ae891078c75b2ab2))
* **kvcache:** add polar INT8 and polar INT4 quantisation schemes ([3f4d655](https://github.com/oRKLLM/oRKLLM/commit/3f4d65526da72515dde010d395ad5ae5c1bf9a29))
* **kvcache:** KV cache compression — UI settings + automatic quantisation ([51b0101](https://github.com/oRKLLM/oRKLLM/commit/51b0101f5cc123d827eac5811acc93b283d23f4a))
* **kvcache:** Vulkan compute path for polar INT8 on Mali-G52 (panvk/Mesa) ([4c7bfa3](https://github.com/oRKLLM/oRKLLM/commit/4c7bfa32ab9fa7adbd429d5f182752eacaa172a3))
* **pool:** add prefillAndCache() — abort-after-first-token KV cache warming ([6060823](https://github.com/oRKLLM/oRKLLM/commit/6060823f752181e05a16ca0de46ca7f9ac0d83ea))
* **runtime_sync:** configurable mirror list with fallthrough ([321ca42](https://github.com/oRKLLM/oRKLLM/commit/321ca4274bce69835f5572b2a09c52fecb1b5b53))
* **spec-decode:** speculative decoding infrastructure ([1977f3a](https://github.com/oRKLLM/oRKLLM/commit/1977f3a1af83369e55d803659bcf8a42e6ea698d))

# [0.8.0-alpha.2](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.1...v0.8.0-alpha.2) (2026-06-03)


### Features

* **kvcache:** KV cache compression — UI settings + automatic quantisation ([51b0101](https://github.com/oRKLLM/oRKLLM/commit/51b0101f5cc123d827eac5811acc93b283d23f4a))

# [0.8.0-alpha.1](https://github.com/oRKLLM/oRKLLM/compare/v0.7.0...v0.8.0-alpha.1) (2026-06-03)


### Bug Fixes

* **addon:** capture inferMode in lambda for RKLLM_INFER_GET_LOGITS mode ([117c223](https://github.com/oRKLLM/oRKLLM/commit/117c223a4b4d2e2e98f321ba901e129575cfc296))
* **admin:** allow empty prompt in infer-with-cache when loadCachePath set ([24bed01](https://github.com/oRKLLM/oRKLLM/commit/24bed01fea8859ac85023d7f7d8738437f6ea6d7))
* **e2e:** relax token_id assertion in prefillAndCache test for mock engine ([769f4b9](https://github.com/oRKLLM/oRKLLM/commit/769f4b944a592a20450c04d8c78b66d98ca0614d))
* **kvcache_quant:** correct relative path to native addon (../build not ../../build) ([328511a](https://github.com/oRKLLM/oRKLLM/commit/328511aac083199173557224c8a50fb6c5721782))
* **kvcache_quant:** derive fixed_overhead dynamically per file ([b645f18](https://github.com/oRKLLM/oRKLLM/commit/b645f18f49c2b64c2226979646d52e2ce43cd6a4))
* **kvcache_quant:** use FP32 NEON arithmetic to avoid FP16 extension requirement ([23651aa](https://github.com/oRKLLM/oRKLLM/commit/23651aa4b81a596c3bba5e4eac0ae5c95ec18f47))
* **kvcache:** rebuild kvcache_quant_napi with Vulkan support on ARM64 ([a23761c](https://github.com/oRKLLM/oRKLLM/commit/a23761cf6582790201902ac15966c2323568fbce))
* **release:** correct target_commitish on migrated releases — semantic-release should now find v0.8.0-alpha.1 ([ef11f6c](https://github.com/oRKLLM/oRKLLM/commit/ef11f6c50a740c04ccff14c4f3ac53aa6e2fb8c4))
* **runtime_sync:** temp revert to mafischer mirror — oRKLLM CDN settling ([218b56b](https://github.com/oRKLLM/oRKLLM/commit/218b56b533cc3ca694920803e3ff87c4abdc30ad))
* **spec-decode:** load draft with max_new_tokens=1; fix token verification logic ([c451b17](https://github.com/oRKLLM/oRKLLM/commit/c451b17421eaceba4fd658415f02ae53a630c7e4))
* **spec-decode:** rename 'dflash' to 'speculative' — applies to any draft model pairing ([192789a](https://github.com/oRKLLM/oRKLLM/commit/192789ad3cb253cbaad2c2d42a45be514f682d60))
* **spec-decode:** wait for state=2 after abort to flush IPC before next run ([d7b2f7f](https://github.com/oRKLLM/oRKLLM/commit/d7b2f7fde50ff564e1c285b32c0972bc57e36264))
* **vulkan:** add memoryBarrierShared() in parallel reduction ([02567ec](https://github.com/oRKLLM/oRKLLM/commit/02567ecd651575b37a837fe9295dd3243a6176e7))
* **vulkan:** correct pack_fp16 mantissa formula in GLSL shader ([c9ea2e3](https://github.com/oRKLLM/oRKLLM/commit/c9ea2e32b3c284b731d1d9f7880671698c2d515f))
* **vulkan:** deploy polar quant with corrected GPU shader ([67511a3](https://github.com/oRKLLM/oRKLLM/commit/67511a37faae8ab63402cd36d97ae65f609f969d))
* **vulkan:** trigger alpha.16 release with corrected polar INT8 GPU shader ([6ca22e9](https://github.com/oRKLLM/oRKLLM/commit/6ca22e991914abed7b0689c394701e77b16ac06a))


### Features

* **admin:** add /api/admin/infer-with-cache for explicit cache path testing ([3b9838b](https://github.com/oRKLLM/oRKLLM/commit/3b9838bbe913552f8039859d128b348d451785c4))
* **ci:** move badge JSON to gh-pages/assets/ — drop GIST_TOKEN ([4ef2e97](https://github.com/oRKLLM/oRKLLM/commit/4ef2e977efd940510c9b1050f1eb0cbd24698100))
* **kvcache:** add INT8 KV cache quantise/dequantise (kvcache_quant.js) ([962e8dd](https://github.com/oRKLLM/oRKLLM/commit/962e8dda338ed0e7298d6aa21ea6068f7c7370a3))
* **kvcache:** add NEON SIMD N-API addon for async KV cache quant/dequant ([b3593a9](https://github.com/oRKLLM/oRKLLM/commit/b3593a9e3d5eed3d692556a0ae891078c75b2ab2))
* **kvcache:** add polar INT8 and polar INT4 quantisation schemes ([3f4d655](https://github.com/oRKLLM/oRKLLM/commit/3f4d65526da72515dde010d395ad5ae5c1bf9a29))
* **kvcache:** Vulkan compute path for polar INT8 on Mali-G52 (panvk/Mesa) ([4c7bfa3](https://github.com/oRKLLM/oRKLLM/commit/4c7bfa32ab9fa7adbd429d5f182752eacaa172a3))
* **pool:** add prefillAndCache() — abort-after-first-token KV cache warming ([6060823](https://github.com/oRKLLM/oRKLLM/commit/6060823f752181e05a16ca0de46ca7f9ac0d83ea))
* **runtime_sync:** configurable mirror list with fallthrough ([321ca42](https://github.com/oRKLLM/oRKLLM/commit/321ca4274bce69835f5572b2a09c52fecb1b5b53))
* **spec-decode:** speculative decoding infrastructure ([1977f3a](https://github.com/oRKLLM/oRKLLM/commit/1977f3a1af83369e55d803659bcf8a42e6ea698d))

# [0.8.0-alpha.2](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.1...v0.8.0-alpha.2) (2026-06-03)


### Bug Fixes

* **vulkan:** correct pack_fp16 mantissa formula in GLSL shader ([c9ea2e3](https://github.com/oRKLLM/oRKLLM/commit/c9ea2e32b3c284b731d1d9f7880671698c2d515f))
* **vulkan:** deploy polar quant with corrected GPU shader ([67511a3](https://github.com/oRKLLM/oRKLLM/commit/67511a37faae8ab63402cd36d97ae65f609f969d))

# [0.8.0-alpha.2](https://github.com/oRKLLM/oRKLLM/compare/v0.8.0-alpha.1...v0.8.0-alpha.2) (2026-06-03)


### Bug Fixes

* **vulkan:** correct pack_fp16 mantissa formula in GLSL shader ([c9ea2e3](https://github.com/oRKLLM/oRKLLM/commit/c9ea2e32b3c284b731d1d9f7880671698c2d515f))

# [0.8.0-alpha.1](https://github.com/oRKLLM/oRKLLM/compare/v0.7.0...v0.8.0-alpha.1) (2026-06-03)


### Bug Fixes

* **addon:** capture inferMode in lambda for RKLLM_INFER_GET_LOGITS mode ([117c223](https://github.com/oRKLLM/oRKLLM/commit/117c223a4b4d2e2e98f321ba901e129575cfc296))
* **admin:** allow empty prompt in infer-with-cache when loadCachePath set ([24bed01](https://github.com/oRKLLM/oRKLLM/commit/24bed01fea8859ac85023d7f7d8738437f6ea6d7))
* **e2e:** relax token_id assertion in prefillAndCache test for mock engine ([769f4b9](https://github.com/oRKLLM/oRKLLM/commit/769f4b944a592a20450c04d8c78b66d98ca0614d))
* **kvcache_quant:** correct relative path to native addon (../build not ../../build) ([328511a](https://github.com/oRKLLM/oRKLLM/commit/328511aac083199173557224c8a50fb6c5721782))
* **kvcache_quant:** derive fixed_overhead dynamically per file ([b645f18](https://github.com/oRKLLM/oRKLLM/commit/b645f18f49c2b64c2226979646d52e2ce43cd6a4))
* **kvcache_quant:** use FP32 NEON arithmetic to avoid FP16 extension requirement ([23651aa](https://github.com/oRKLLM/oRKLLM/commit/23651aa4b81a596c3bba5e4eac0ae5c95ec18f47))
* **kvcache:** rebuild kvcache_quant_napi with Vulkan support on ARM64 ([a23761c](https://github.com/oRKLLM/oRKLLM/commit/a23761cf6582790201902ac15966c2323568fbce))
* **release:** correct target_commitish on migrated releases — semantic-release should now find v0.8.0-alpha.1 ([ef11f6c](https://github.com/oRKLLM/oRKLLM/commit/ef11f6c50a740c04ccff14c4f3ac53aa6e2fb8c4))
* **runtime_sync:** temp revert to mafischer mirror — oRKLLM CDN settling ([218b56b](https://github.com/oRKLLM/oRKLLM/commit/218b56b533cc3ca694920803e3ff87c4abdc30ad))
* **spec-decode:** load draft with max_new_tokens=1; fix token verification logic ([c451b17](https://github.com/oRKLLM/oRKLLM/commit/c451b17421eaceba4fd658415f02ae53a630c7e4))
* **spec-decode:** rename 'dflash' to 'speculative' — applies to any draft model pairing ([192789a](https://github.com/oRKLLM/oRKLLM/commit/192789ad3cb253cbaad2c2d42a45be514f682d60))
* **spec-decode:** wait for state=2 after abort to flush IPC before next run ([d7b2f7f](https://github.com/oRKLLM/oRKLLM/commit/d7b2f7fde50ff564e1c285b32c0972bc57e36264))
* **vulkan:** add memoryBarrierShared() in parallel reduction ([02567ec](https://github.com/oRKLLM/oRKLLM/commit/02567ecd651575b37a837fe9295dd3243a6176e7))


### Features

* **admin:** add /api/admin/infer-with-cache for explicit cache path testing ([3b9838b](https://github.com/oRKLLM/oRKLLM/commit/3b9838bbe913552f8039859d128b348d451785c4))
* **ci:** move badge JSON to gh-pages/assets/ — drop GIST_TOKEN ([4ef2e97](https://github.com/oRKLLM/oRKLLM/commit/4ef2e977efd940510c9b1050f1eb0cbd24698100))
* **kvcache:** add INT8 KV cache quantise/dequantise (kvcache_quant.js) ([962e8dd](https://github.com/oRKLLM/oRKLLM/commit/962e8dda338ed0e7298d6aa21ea6068f7c7370a3))
* **kvcache:** add NEON SIMD N-API addon for async KV cache quant/dequant ([b3593a9](https://github.com/oRKLLM/oRKLLM/commit/b3593a9e3d5eed3d692556a0ae891078c75b2ab2))
* **kvcache:** add polar INT8 and polar INT4 quantisation schemes ([3f4d655](https://github.com/oRKLLM/oRKLLM/commit/3f4d65526da72515dde010d395ad5ae5c1bf9a29))
* **kvcache:** Vulkan compute path for polar INT8 on Mali-G52 (panvk/Mesa) ([4c7bfa3](https://github.com/oRKLLM/oRKLLM/commit/4c7bfa32ab9fa7adbd429d5f182752eacaa172a3))
* **pool:** add prefillAndCache() — abort-after-first-token KV cache warming ([6060823](https://github.com/oRKLLM/oRKLLM/commit/6060823f752181e05a16ca0de46ca7f9ac0d83ea))
* **runtime_sync:** configurable mirror list with fallthrough ([321ca42](https://github.com/oRKLLM/oRKLLM/commit/321ca4274bce69835f5572b2a09c52fecb1b5b53))
* **spec-decode:** speculative decoding infrastructure ([1977f3a](https://github.com/oRKLLM/oRKLLM/commit/1977f3a1af83369e55d803659bcf8a42e6ea698d))

# [0.8.0-alpha.1](https://github.com/oRKLLM/oRKLLM/compare/v0.7.0...v0.8.0-alpha.1) (2026-06-03)


### Bug Fixes

* **addon:** capture inferMode in lambda for RKLLM_INFER_GET_LOGITS mode ([117c223](https://github.com/oRKLLM/oRKLLM/commit/117c223a4b4d2e2e98f321ba901e129575cfc296))
* **admin:** allow empty prompt in infer-with-cache when loadCachePath set ([24bed01](https://github.com/oRKLLM/oRKLLM/commit/24bed01fea8859ac85023d7f7d8738437f6ea6d7))
* **e2e:** relax token_id assertion in prefillAndCache test for mock engine ([769f4b9](https://github.com/oRKLLM/oRKLLM/commit/769f4b944a592a20450c04d8c78b66d98ca0614d))
* **kvcache_quant:** correct relative path to native addon (../build not ../../build) ([328511a](https://github.com/oRKLLM/oRKLLM/commit/328511aac083199173557224c8a50fb6c5721782))
* **kvcache_quant:** derive fixed_overhead dynamically per file ([b645f18](https://github.com/oRKLLM/oRKLLM/commit/b645f18f49c2b64c2226979646d52e2ce43cd6a4))
* **kvcache_quant:** use FP32 NEON arithmetic to avoid FP16 extension requirement ([23651aa](https://github.com/oRKLLM/oRKLLM/commit/23651aa4b81a596c3bba5e4eac0ae5c95ec18f47))
* **kvcache:** rebuild kvcache_quant_napi with Vulkan support on ARM64 ([a23761c](https://github.com/oRKLLM/oRKLLM/commit/a23761cf6582790201902ac15966c2323568fbce))
* **spec-decode:** load draft with max_new_tokens=1; fix token verification logic ([c451b17](https://github.com/oRKLLM/oRKLLM/commit/c451b17421eaceba4fd658415f02ae53a630c7e4))
* **spec-decode:** rename 'dflash' to 'speculative' — applies to any draft model pairing ([192789a](https://github.com/oRKLLM/oRKLLM/commit/192789ad3cb253cbaad2c2d42a45be514f682d60))
* **spec-decode:** wait for state=2 after abort to flush IPC before next run ([d7b2f7f](https://github.com/oRKLLM/oRKLLM/commit/d7b2f7fde50ff564e1c285b32c0972bc57e36264))


### Features

* **admin:** add /api/admin/infer-with-cache for explicit cache path testing ([3b9838b](https://github.com/oRKLLM/oRKLLM/commit/3b9838bbe913552f8039859d128b348d451785c4))
* **kvcache:** add INT8 KV cache quantise/dequantise (kvcache_quant.js) ([962e8dd](https://github.com/oRKLLM/oRKLLM/commit/962e8dda338ed0e7298d6aa21ea6068f7c7370a3))
* **kvcache:** add NEON SIMD N-API addon for async KV cache quant/dequant ([b3593a9](https://github.com/oRKLLM/oRKLLM/commit/b3593a9e3d5eed3d692556a0ae891078c75b2ab2))
* **kvcache:** add polar INT8 and polar INT4 quantisation schemes ([3f4d655](https://github.com/oRKLLM/oRKLLM/commit/3f4d65526da72515dde010d395ad5ae5c1bf9a29))
* **kvcache:** Vulkan compute path for polar INT8 on Mali-G52 (panvk/Mesa) ([4c7bfa3](https://github.com/oRKLLM/oRKLLM/commit/4c7bfa32ab9fa7adbd429d5f182752eacaa172a3))
* **pool:** add prefillAndCache() — abort-after-first-token KV cache warming ([6060823](https://github.com/oRKLLM/oRKLLM/commit/6060823f752181e05a16ca0de46ca7f9ac0d83ea))
* **spec-decode:** speculative decoding infrastructure ([1977f3a](https://github.com/oRKLLM/oRKLLM/commit/1977f3a1af83369e55d803659bcf8a42e6ea698d))

# [0.8.0-alpha.1](https://github.com/oRKLLM/oRKLLM/compare/v0.7.0...v0.8.0-alpha.1) (2026-06-03)


### Bug Fixes

* **addon:** capture inferMode in lambda for RKLLM_INFER_GET_LOGITS mode ([117c223](https://github.com/oRKLLM/oRKLLM/commit/117c223a4b4d2e2e98f321ba901e129575cfc296))
* **admin:** allow empty prompt in infer-with-cache when loadCachePath set ([24bed01](https://github.com/oRKLLM/oRKLLM/commit/24bed01fea8859ac85023d7f7d8738437f6ea6d7))
* **e2e:** relax token_id assertion in prefillAndCache test for mock engine ([769f4b9](https://github.com/oRKLLM/oRKLLM/commit/769f4b944a592a20450c04d8c78b66d98ca0614d))
* **kvcache_quant:** correct relative path to native addon (../build not ../../build) ([328511a](https://github.com/oRKLLM/oRKLLM/commit/328511aac083199173557224c8a50fb6c5721782))
* **kvcache_quant:** derive fixed_overhead dynamically per file ([b645f18](https://github.com/oRKLLM/oRKLLM/commit/b645f18f49c2b64c2226979646d52e2ce43cd6a4))
* **kvcache_quant:** use FP32 NEON arithmetic to avoid FP16 extension requirement ([23651aa](https://github.com/oRKLLM/oRKLLM/commit/23651aa4b81a596c3bba5e4eac0ae5c95ec18f47))
* **kvcache:** rebuild kvcache_quant_napi with Vulkan support on ARM64 ([a23761c](https://github.com/oRKLLM/oRKLLM/commit/a23761cf6582790201902ac15966c2323568fbce))
* **spec-decode:** load draft with max_new_tokens=1; fix token verification logic ([c451b17](https://github.com/oRKLLM/oRKLLM/commit/c451b17421eaceba4fd658415f02ae53a630c7e4))
* **spec-decode:** rename 'dflash' to 'speculative' — applies to any draft model pairing ([192789a](https://github.com/oRKLLM/oRKLLM/commit/192789ad3cb253cbaad2c2d42a45be514f682d60))
* **spec-decode:** wait for state=2 after abort to flush IPC before next run ([d7b2f7f](https://github.com/oRKLLM/oRKLLM/commit/d7b2f7fde50ff564e1c285b32c0972bc57e36264))


### Features

* **admin:** add /api/admin/infer-with-cache for explicit cache path testing ([3b9838b](https://github.com/oRKLLM/oRKLLM/commit/3b9838bbe913552f8039859d128b348d451785c4))
* **kvcache:** add INT8 KV cache quantise/dequantise (kvcache_quant.js) ([962e8dd](https://github.com/oRKLLM/oRKLLM/commit/962e8dda338ed0e7298d6aa21ea6068f7c7370a3))
* **kvcache:** add NEON SIMD N-API addon for async KV cache quant/dequant ([b3593a9](https://github.com/oRKLLM/oRKLLM/commit/b3593a9e3d5eed3d692556a0ae891078c75b2ab2))
* **kvcache:** add polar INT8 and polar INT4 quantisation schemes ([3f4d655](https://github.com/oRKLLM/oRKLLM/commit/3f4d65526da72515dde010d395ad5ae5c1bf9a29))
* **kvcache:** Vulkan compute path for polar INT8 on Mali-G52 (panvk/Mesa) ([4c7bfa3](https://github.com/oRKLLM/oRKLLM/commit/4c7bfa32ab9fa7adbd429d5f182752eacaa172a3))
* **pool:** add prefillAndCache() — abort-after-first-token KV cache warming ([6060823](https://github.com/oRKLLM/oRKLLM/commit/6060823f752181e05a16ca0de46ca7f9ac0d83ea))
* **spec-decode:** speculative decoding infrastructure ([1977f3a](https://github.com/oRKLLM/oRKLLM/commit/1977f3a1af83369e55d803659bcf8a42e6ea698d))

# [0.8.0-alpha.15](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.14...v0.8.0-alpha.15) (2026-06-03)


### Bug Fixes

* **kvcache:** rebuild kvcache_quant_napi with Vulkan support on ARM64 ([a23761c](https://github.com/mafischer/oRKLLM/commit/a23761cf6582790201902ac15966c2323568fbce))

# [0.8.0-alpha.14](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.13...v0.8.0-alpha.14) (2026-06-03)


### Features

* **kvcache:** Vulkan compute path for polar INT8 on Mali-G52 (panvk/Mesa) ([4c7bfa3](https://github.com/mafischer/oRKLLM/commit/4c7bfa32ab9fa7adbd429d5f182752eacaa172a3))

# [0.8.0-alpha.13](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.12...v0.8.0-alpha.13) (2026-06-03)


### Features

* **kvcache:** add polar INT8 and polar INT4 quantisation schemes ([3f4d655](https://github.com/mafischer/oRKLLM/commit/3f4d65526da72515dde010d395ad5ae5c1bf9a29))

# [0.8.0-alpha.12](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.11...v0.8.0-alpha.12) (2026-06-03)


### Bug Fixes

* **kvcache_quant:** use FP32 NEON arithmetic to avoid FP16 extension requirement ([23651aa](https://github.com/mafischer/oRKLLM/commit/23651aa4b81a596c3bba5e4eac0ae5c95ec18f47))

# [0.8.0-alpha.11](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.10...v0.8.0-alpha.11) (2026-06-03)


### Bug Fixes

* **kvcache_quant:** correct relative path to native addon (../build not ../../build) ([328511a](https://github.com/mafischer/oRKLLM/commit/328511aac083199173557224c8a50fb6c5721782))

# [0.8.0-alpha.10](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.9...v0.8.0-alpha.10) (2026-06-03)


### Features

* **kvcache:** add NEON SIMD N-API addon for async KV cache quant/dequant ([b3593a9](https://github.com/mafischer/oRKLLM/commit/b3593a9e3d5eed3d692556a0ae891078c75b2ab2))

# [0.8.0-alpha.9](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.8...v0.8.0-alpha.9) (2026-06-03)


### Bug Fixes

* **kvcache_quant:** derive fixed_overhead dynamically per file ([b645f18](https://github.com/mafischer/oRKLLM/commit/b645f18f49c2b64c2226979646d52e2ce43cd6a4))

# [0.8.0-alpha.8](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.7...v0.8.0-alpha.8) (2026-06-03)


### Features

* **kvcache:** add INT8 KV cache quantise/dequantise (kvcache_quant.js) ([962e8dd](https://github.com/mafischer/oRKLLM/commit/962e8dda338ed0e7298d6aa21ea6068f7c7370a3))

# [0.8.0-alpha.7](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.6...v0.8.0-alpha.7) (2026-06-03)


### Bug Fixes

* **admin:** allow empty prompt in infer-with-cache when loadCachePath set ([24bed01](https://github.com/mafischer/oRKLLM/commit/24bed01fea8859ac85023d7f7d8738437f6ea6d7))

# [0.8.0-alpha.6](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.5...v0.8.0-alpha.6) (2026-06-03)


### Bug Fixes

* **e2e:** relax token_id assertion in prefillAndCache test for mock engine ([769f4b9](https://github.com/mafischer/oRKLLM/commit/769f4b944a592a20450c04d8c78b66d98ca0614d))


### Features

* **admin:** add /api/admin/infer-with-cache for explicit cache path testing ([3b9838b](https://github.com/mafischer/oRKLLM/commit/3b9838bbe913552f8039859d128b348d451785c4))

# [0.8.0-alpha.5](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.4...v0.8.0-alpha.5) (2026-06-03)


### Features

* **pool:** add prefillAndCache() — abort-after-first-token KV cache warming ([6060823](https://github.com/mafischer/oRKLLM/commit/6060823f752181e05a16ca0de46ca7f9ac0d83ea))

# [0.8.0-alpha.4](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.3...v0.8.0-alpha.4) (2026-06-03)


### Bug Fixes

* **spec-decode:** wait for state=2 after abort to flush IPC before next run ([d7b2f7f](https://github.com/mafischer/oRKLLM/commit/d7b2f7fde50ff564e1c285b32c0972bc57e36264))

# [0.8.0-alpha.3](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.2...v0.8.0-alpha.3) (2026-06-02)


### Bug Fixes

* **spec-decode:** load draft with max_new_tokens=1; fix token verification logic ([c451b17](https://github.com/mafischer/oRKLLM/commit/c451b17421eaceba4fd658415f02ae53a630c7e4))

# [0.8.0-alpha.2](https://github.com/mafischer/oRKLLM/compare/v0.8.0-alpha.1...v0.8.0-alpha.2) (2026-06-02)


### Bug Fixes

* **spec-decode:** rename 'dflash' to 'speculative' — applies to any draft model pairing ([192789a](https://github.com/mafischer/oRKLLM/commit/192789ad3cb253cbaad2c2d42a45be514f682d60))

# [0.8.0-alpha.1](https://github.com/mafischer/oRKLLM/compare/v0.7.0...v0.8.0-alpha.1) (2026-06-02)


### Bug Fixes

* **addon:** capture inferMode in lambda for RKLLM_INFER_GET_LOGITS mode ([117c223](https://github.com/mafischer/oRKLLM/commit/117c223a4b4d2e2e98f321ba901e129575cfc296))


### Features

* **spec-decode:** speculative decoding infrastructure ([1977f3a](https://github.com/mafischer/oRKLLM/commit/1977f3a1af83369e55d803659bcf8a42e6ea698d))

# [0.7.0-alpha.34](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.33...v0.7.0-alpha.34) (2026-06-02)


### Bug Fixes

* **addon:** add enable_thinking to stub RKLLMParam for x86 CI compilation ([8e5bfe3](https://github.com/mafischer/oRKLLM/commit/8e5bfe34dcaa41bbd80bf13306ed6ebbd4224d87))
* **ci:** switch to license-checker-rseidelsohn — maintained fork, no deprecated dependency warnings ([0182d6c](https://github.com/mafischer/oRKLLM/commit/0182d6c7f80ae940862305a230569d1bdf98a512))
* **monitor:** cache TBW alongside diskLayout so it's available on first metrics tick ([5ba7d11](https://github.com/mafischer/oRKLLM/commit/5ba7d11c59ab9d6ef52f7a803ace59faa1e31e69))
* **tests:** use scoped locator for dialog fields — text= is not a CSS selector ([5c353b2](https://github.com/mafischer/oRKLLM/commit/5c353b255fec8cd9aa960eb945754271878466f0))


### Features

* **ci:** add ClamAV binary signature scan of .deb before APT publish ([5d688cd](https://github.com/mafischer/oRKLLM/commit/5d688cd22a836301f064dffb0503981f94405030))
* **ci:** add production dependency license check ([59b751a](https://github.com/mafischer/oRKLLM/commit/59b751a8951e929387a6b3ce62b548b9341119ba))
* **ci:** Node.js version matrix — test against 20, 22, 24 in parallel ([8429680](https://github.com/mafischer/oRKLLM/commit/8429680f858bf061f9974c6670885640f6c23e42))
* **model-settings:** expand per-model settings to oMLX parity ([eb63fe3](https://github.com/mafischer/oRKLLM/commit/eb63fe355bcd7aae4be8a5847be540fd5b069655))
* **naming:** unified model naming convention — single format for repo and file ([9eeb121](https://github.com/mafischer/oRKLLM/commit/9eeb121dba102fad8b67d779c0f4aa2393e1ffe7))


### Reverts

* remove ClamAV scan from release workflow ([4b29f59](https://github.com/mafischer/oRKLLM/commit/4b29f59e6de5bd70a4d6ff731ecf37d30ff51a58))

# [0.7.0](https://github.com/mafischer/oRKLLM/compare/v0.6.0...v0.7.0) (2026-06-02)


### Bug Fixes

* **addon:** add enable_thinking to stub RKLLMParam for x86 CI compilation ([8e5bfe3](https://github.com/mafischer/oRKLLM/commit/8e5bfe34dcaa41bbd80bf13306ed6ebbd4224d87))
* **cache:** raise sliding context window max to 32768 tokens, default 8192 ([e37eb10](https://github.com/mafischer/oRKLLM/commit/e37eb106276396d50f3c4864f579cedc5aaf732f))
* **chat:** anchor layout to fixed viewport to prevent mobile browser chrome shifting ([36c9d68](https://github.com/mafischer/oRKLLM/commit/36c9d686d35d9a4d2f84e551060a7250a3a7e338))
* **chat:** improve LLM response bubble contrast in dark and light themes ([a793047](https://github.com/mafischer/oRKLLM/commit/a793047bc14754c471dee17dce29c3aee6afdb03))
* **chat:** pass no args to sendMessage from DOM events to avoid Event being treated as queued text ([f27a24d](https://github.com/mafischer/oRKLLM/commit/f27a24d929b2961e410ef08a617e0006ecd5f8ff))
* **chat:** persist partial assistant response on page navigation using sendBeacon ([d9dfba7](https://github.com/mafischer/oRKLLM/commit/d9dfba738fd2818904a7eb682f471365649e45e0))
* **chat:** pin input bar to bottom, only message history scrolls ([08315bc](https://github.com/mafischer/oRKLLM/commit/08315bccfebc2a4cd8594221ed4131c4ff497d91))
* **chat:** prevent queued message duplicating in chat history ([a2aad1c](https://github.com/mafischer/oRKLLM/commit/a2aad1c9830a18f670c306a3531d38f307e0ec77))
* **chat:** shorten input placeholder to fit mobile layout ([76e9d3c](https://github.com/mafischer/oRKLLM/commit/76e9d3c6275acf6c8966fa179438fbfdc35195b0))
* **ci:** exclude node_modules/npm from Trivy scan — vulnerabilities are in npm's own bundled deps, not our app ([160e471](https://github.com/mafischer/oRKLLM/commit/160e47170fbd87aa3cdf3cd7db3d4cd78c2cb8a9))
* **ci:** remove overbroad .cache skip from Trivy, keep only node_modules/npm ([1010273](https://github.com/mafischer/oRKLLM/commit/101027385d38737fb30ce6a07384fa01387b11e3))
* **ci:** switch to license-checker-rseidelsohn — maintained fork, no deprecated dependency warnings ([0182d6c](https://github.com/mafischer/oRKLLM/commit/0182d6c7f80ae940862305a230569d1bdf98a512))
* correct runtime_sync.js import path in runtimes endpoint (./→../) ([4649bbe](https://github.com/mafischer/oRKLLM/commit/4649bbe76332a73a9979019d644167b74ba5a5ba))
* **dashboard:** display cache sizes in GB when >= 1024 MB ([15f08a2](https://github.com/mafischer/oRKLLM/commit/15f08a22c6ef8d08516248b45490df72804ed3df))
* **dashboard:** use r.file not r.filename for runtime versions table ([011ee88](https://github.com/mafischer/oRKLLM/commit/011ee881606c801a0d33dfefa558001f78d390d2))
* **downloader:** encode repo ID path segments separately to preserve slash separator ([ff472ba](https://github.com/mafischer/oRKLLM/commit/ff472baf7c736718735a46532b4d5180c26ca74a))
* **downloader:** restore download queue on mount and tab switch ([c64d423](https://github.com/mafischer/oRKLLM/commit/c64d4232a9c39e06c464820633ef4d595cea0175))
* **monitor:** cache diskLayout() — refresh every 30s instead of every 1s WebSocket tick ([692db04](https://github.com/mafischer/oRKLLM/commit/692db049a03b5ef702f58b30057daa6d2186e775))
* **monitor:** cache TBW alongside diskLayout so it's available on first metrics tick ([5ba7d11](https://github.com/mafischer/oRKLLM/commit/5ba7d11c59ab9d6ef52f7a803ace59faa1e31e69))
* **monitor:** parse smartctl stdout even on non-zero exit; use absolute path /usr/sbin/smartctl ([db440c6](https://github.com/mafischer/oRKLLM/commit/db440c6e03b049a7623bde72601a8307c67eec5a))
* **nav:** replace version chip with inline text, tighten spacing ([cc8bc34](https://github.com/mafischer/oRKLLM/commit/cc8bc3477a8aaa19f014d52f62b7cd9f47b64f2a))
* **nav:** toggle drawers on button tap instead of always opening ([3ef974c](https://github.com/mafischer/oRKLLM/commit/3ef974c2b5c26a2579386595b0e7033de1a7b805))
* **nav:** use primary color for version text at reduced opacity ([5e12601](https://github.com/mafischer/oRKLLM/commit/5e12601114fc1cbbfd073546d6de5f483c723464))
* **pool:** improve error messages when rkllm_init fails — platform mismatch vs version mismatch ([624ecd2](https://github.com/mafischer/oRKLLM/commit/624ecd22ad2480c2b4746e814156e1a61778590e))
* regenerate package-lock.json after @fastify/static upgrade to 9.1.3 ([075cf64](https://github.com/mafischer/oRKLLM/commit/075cf64c88748dc0c13fa96b7a2eae77ac4e5f26))
* **search:** read platform from /proc/device-tree/compatible; pass as dedicated param ([cd201d0](https://github.com/mafischer/oRKLLM/commit/cd201d087652cbfca1d658c02e252648e01af6f6))
* **search:** show repo storage size with harddisk icon inline with downloads and likes ([df9c0a7](https://github.com/mafischer/oRKLLM/commit/df9c0a721ff9e502c9ba13c96b069ba3dc680554))
* **search:** single generic 'Compatible chipset' filter with dynamic platform name ([e08b3f7](https://github.com/mafischer/oRKLLM/commit/e08b3f7e5c2c6037f3dfa5ba7ae179241c7359f7))
* **security:** skip node_modules/npm in Trivy — bundled deps unreachable via overrides ([49dfa6c](https://github.com/mafischer/oRKLLM/commit/49dfa6ccfd490a08d100721caae12bad943d3d50))
* **security:** upgrade @fastify/static to 9.1.3; opt into Node.js 24 for actions ([dca14ef](https://github.com/mafischer/oRKLLM/commit/dca14efe9c367127c7c58db73caeab2ea04fe1ad))
* sync package-lock.json with @fastify/static@9.1.3 upgrade ([3c49ce8](https://github.com/mafischer/oRKLLM/commit/3c49ce8b24be17fd4dda3a9f27b59ac494e3bc02))
* **tests:** check href on v-list-item directly — it IS the anchor element ([0732a17](https://github.com/mafischer/oRKLLM/commit/0732a17017fde5d28faba07b7918e3d89ef02df1))
* **tests:** correct dynamic import paths and flaky test assertions ([f788a87](https://github.com/mafischer/oRKLLM/commit/f788a876c9615fdeee87caf384cc9c7667d3abda))
* **tests:** fix strict mode NPU locator and grant clipboard permission for snackbar test ([182f082](https://github.com/mafischer/oRKLLM/commit/182f0828891730a0170323ad6f9928c5165aab0e))
* **tests:** replace playground test with cache observability + runtime versions test ([84ee069](https://github.com/mafischer/oRKLLM/commit/84ee0695a51b68c7a0cb9858ae07167cacd69c2c))
* **tests:** scope sidebar delete assertion to specific item not total count ([14c24ec](https://github.com/mafischer/oRKLLM/commit/14c24ecb2eb59b8e8f6b998813a9f47adf58fd3c))
* **tests:** scope telemetry gauge label assertions to Hardware Telemetry card ([df36244](https://github.com/mafischer/oRKLLM/commit/df362448e453ae074161ff90c71822c6c95936dc))
* **tests:** update downloader tab test — HF token field moved to Settings ([a7c7030](https://github.com/mafischer/oRKLLM/commit/a7c7030f25f75e326fdb2532a88dfafccd8cc447))
* **tests:** update version assertions from v-chip to inline span ([9bdfdc7](https://github.com/mafischer/oRKLLM/commit/9bdfdc786e77f507a99806da0a9b28ff8bed10e5))
* **tests:** use .v-navigation-drawer--right to select user drawer ([2c07c9f](https://github.com/mafischer/oRKLLM/commit/2c07c9f3d3e3391917d2a260ad735455d3bbc10b))
* **tests:** use inert attribute and correct viewport timing for drawer toggle tests ([c6cbbc9](https://github.com/mafischer/oRKLLM/commit/c6cbbc9f990683d92a211d3097e4547c8c00e51c))
* **tests:** use scoped locator for dialog fields — text= is not a CSS selector ([5c353b2](https://github.com/mafischer/oRKLLM/commit/5c353b255fec8cd9aa960eb945754271878466f0))
* **tests:** use v-navigation-drawer--active class to assert drawer open/closed state ([fc23145](https://github.com/mafischer/oRKLLM/commit/fc23145742bf0c96dd9828f3d8177cd5f53f6c02))
* **ui:** hamburger opens drawer, oRKLLM text navigates to dashboard on mobile ([e0ef600](https://github.com/mafischer/oRKLLM/commit/e0ef600215ac4771eee6c92ea60a5caf294398ec))
* **ui:** hide version chip in mobile navbar, show in user drawer footer ([e13df1e](https://github.com/mafischer/oRKLLM/commit/e13df1e2efdacd2a56609e3e4c3afd4f37524a90))
* **ui:** logo opens mobile nav drawer instead of separate hamburger button ([46b337b](https://github.com/mafischer/oRKLLM/commit/46b337bc6ba6c005980640da548a1f9ec2711116))
* **ui:** responsive navbar for mobile screens ([d91a14f](https://github.com/mafischer/oRKLLM/commit/d91a14fbb76b78034f35160a67a1f5e90dcf720f))


### Features

* **bench:** add model selector dropdown like Chat page ([d5bbaf1](https://github.com/mafischer/oRKLLM/commit/d5bbaf152b16715ab20ef6c9d77c8004bad69835))
* **chat:** add mobile history access via bottom sheet ([1c04205](https://github.com/mafischer/oRKLLM/commit/1c042059c22d8f3efbff07955992e4914dad2760))
* **chat:** allow typing and queueing messages during generation ([f5dc89c](https://github.com/mafischer/oRKLLM/commit/f5dc89c45ce53b7451ee583d5659df28ceb9b2b4))
* **chat:** persist conversations grouped by model with history sidebar ([cee56cb](https://github.com/mafischer/oRKLLM/commit/cee56cb34b09f2117bfedb44a96d5be027def46a))
* **ci:** add ClamAV binary signature scan of .deb before APT publish ([5d688cd](https://github.com/mafischer/oRKLLM/commit/5d688cd22a836301f064dffb0503981f94405030))
* **ci:** add production dependency license check ([59b751a](https://github.com/mafischer/oRKLLM/commit/59b751a8951e929387a6b3ce62b548b9341119ba))
* **ci:** automated beta promotion after 48h stability window ([b01c259](https://github.com/mafischer/oRKLLM/commit/b01c259b7cdc62f6680d23371d180b23f9579848))
* **ci:** Node.js version matrix — test against 20, 22, 24 in parallel ([8429680](https://github.com/mafischer/oRKLLM/commit/8429680f858bf061f9974c6670885640f6c23e42))
* **dashboard:** add % / units toggle to Hardware Telemetry card ([96ff7dc](https://github.com/mafischer/oRKLLM/commit/96ff7dcc1c569e18304979b922f8ed910153094e))
* **dashboard:** add disk table with device name, type, size and SMART status below telemetry gauges ([1f2dd1c](https://github.com/mafischer/oRKLLM/commit/1f2dd1cc88682f6998fe22341be4733f6e98fc5d))
* **dashboard:** add TBW (total bytes written) to disk table from NVMe SMART data ([df6165f](https://github.com/mafischer/oRKLLM/commit/df6165f377101708d8b44a21f8015f2ab3b44ce5))
* **dashboard:** replace inference playground with cache observability and RKLLM runtime versions ([a9899a9](https://github.com/mafischer/oRKLLM/commit/a9899a91838633397e60ae3e9e575f16a2a14dae))
* **deb:** add smartmontools dependency and PATH with /usr/sbin for SMART disk status ([790c14d](https://github.com/mafischer/oRKLLM/commit/790c14ded7d4d71400a9b9e1f837b80a56647704))
* **downloader:** Download button fetches all repo files and starts all downloads immediately ([86eeef4](https://github.com/mafischer/oRKLLM/commit/86eeef459c2060185fd9c56b2e029788d7dc1fa8))
* **downloader:** full download queue with progress, speed, file picker ([a8ab0df](https://github.com/mafischer/oRKLLM/commit/a8ab0df20467e4b1af25cb994360e58cf47cb212))
* **downloader:** restore HF token field in download form for ad-hoc override ([2adb186](https://github.com/mafischer/oRKLLM/commit/2adb186d60727019afd7152700bf16fd9fa51413))
* **downloader:** save files to models/{repoName}/ and group queue by repo ([d355b86](https://github.com/mafischer/oRKLLM/commit/d355b862471ccf626f0262239b006c16bd282c84))
* **github:** bug report issue template with version field ([061fe2f](https://github.com/mafischer/oRKLLM/commit/061fe2fa7c4429cf07eafebfc72109d4396f2521))
* **github:** bug report issue template with version field ([7245dc4](https://github.com/mafischer/oRKLLM/commit/7245dc4e9aebe3d962cc0678dd3012fe90ae6952))
* **model-settings:** expand per-model settings to oMLX parity ([eb63fe3](https://github.com/mafischer/oRKLLM/commit/eb63fe355bcd7aae4be8a5847be540fd5b069655))
* **models:** add pin toggle to prevent active model from idle-unloading ([a67726e](https://github.com/mafischer/oRKLLM/commit/a67726e90749bd40bb63a33c96779bad63d539f8))
* **models:** recursive scan supports subdirectory models; wildcard routes for settings/delete ([64ba54e](https://github.com/mafischer/oRKLLM/commit/64ba54e018428f2c426f5e43183275fe6f882f9b))
* **models:** show model weight size in HF search and collection results ([2a77eba](https://github.com/mafischer/oRKLLM/commit/2a77ebadcd0e8c65e20fb5bbe52e4a8c75e77e63))
* **naming:** unified model naming convention — single format for repo and file ([9eeb121](https://github.com/mafischer/oRKLLM/commit/9eeb121dba102fad8b67d779c0f4aa2393e1ffe7))
* **nav:** add Contribute button to user drawer linking to GitHub ([fcb35b9](https://github.com/mafischer/oRKLLM/commit/fcb35b91ac4000e76b3ff76114eb3d9951f391f7))
* **pool:** persist pinned model across restarts with auto-load on startup ([5c5983b](https://github.com/mafischer/oRKLLM/commit/5c5983ba93aaed0586256c46c1db13ccb294ea32))
* **proxy:** support comma-separated list of trusted proxy IPs/CIDRs ([014447a](https://github.com/mafischer/oRKLLM/commit/014447a8dd0a2463d87dc1fd782b83144fb04866))
* **release:** add APT distribution channels (stable/beta/alpha) ([d205864](https://github.com/mafischer/oRKLLM/commit/d205864df08292fe2f3a0ee3839b33e6fa1a7fc9))
* **runtime:** auto-discover and retry rkllm runtimes by version ([3ef14ae](https://github.com/mafischer/oRKLLM/commit/3ef14ae67c41f122aebf26f989f30a2ce6852274))
* **runtime:** read embedded version from librkllmrt.so via strings ([fcb3ca3](https://github.com/mafischer/oRKLLM/commit/fcb3ca3d41475c28fe254205e1f2fe8924a36639))
* **runtimes:** auto-download rkllm runtimes with setup opt-in ([7f56775](https://github.com/mafischer/oRKLLM/commit/7f5677514ebb4c057b40216a5b3a7d26bcbf723a))
* **runtime:** show JIT download progress dialog when runtime is fetched during model load ([c28658b](https://github.com/mafischer/oRKLLM/commit/c28658b9abd22afad5064b3e170550ef76364a4a))
* **runtimes:** opt-out flow, model scan version persistence, API 422 on missing runtime ([147dc9f](https://github.com/mafischer/oRKLLM/commit/147dc9f9c0cbd4ba5306137433447cabdbca07ea))
* **search:** auto-detect SoC platform and add to HF search query ([2846349](https://github.com/mafischer/oRKLLM/commit/28463497d8dd645175c18d7de78565df5bf24037))
* **settings:** trigger immediate runtime sync when auto-download is enabled ([e2b8353](https://github.com/mafischer/oRKLLM/commit/e2b835314f17d66515af4e83971cfacb59bb3005))
* **telemetry:** add GPU and disk utilization to hardware telemetry ([e56b34d](https://github.com/mafischer/oRKLLM/commit/e56b34da40a9e81b0139bc93937d11f6429fd680))
* **ux:** replace all browser alert() popups with Vuetify v-snackbar ([31af206](https://github.com/mafischer/oRKLLM/commit/31af206cf937b6cf2aff6ef184eca26785406f86))


### Reverts

* remove ClamAV scan from release workflow ([4b29f59](https://github.com/mafischer/oRKLLM/commit/4b29f59e6de5bd70a4d6ff731ecf37d30ff51a58))

# [0.7.0-alpha.33](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.32...v0.7.0-alpha.33) (2026-06-02)


### Bug Fixes

* **monitor:** parse smartctl stdout even on non-zero exit; use absolute path /usr/sbin/smartctl ([db440c6](https://github.com/mafischer/oRKLLM/commit/db440c6e03b049a7623bde72601a8307c67eec5a))

# [0.7.0-alpha.32](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.31...v0.7.0-alpha.32) (2026-06-01)


### Features

* **dashboard:** add TBW (total bytes written) to disk table from NVMe SMART data ([df6165f](https://github.com/mafischer/oRKLLM/commit/df6165f377101708d8b44a21f8015f2ab3b44ce5))
* **deb:** add smartmontools dependency and PATH with /usr/sbin for SMART disk status ([790c14d](https://github.com/mafischer/oRKLLM/commit/790c14ded7d4d71400a9b9e1f837b80a56647704))

# [0.7.0-alpha.31](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.30...v0.7.0-alpha.31) (2026-06-01)


### Bug Fixes

* **monitor:** cache diskLayout() — refresh every 30s instead of every 1s WebSocket tick ([692db04](https://github.com/mafischer/oRKLLM/commit/692db049a03b5ef702f58b30057daa6d2186e775))

# [0.7.0-alpha.30](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.29...v0.7.0-alpha.30) (2026-06-01)


### Bug Fixes

* **ci:** exclude node_modules/npm from Trivy scan — vulnerabilities are in npm's own bundled deps, not our app ([160e471](https://github.com/mafischer/oRKLLM/commit/160e47170fbd87aa3cdf3cd7db3d4cd78c2cb8a9))
* **ci:** remove overbroad .cache skip from Trivy, keep only node_modules/npm ([1010273](https://github.com/mafischer/oRKLLM/commit/101027385d38737fb30ce6a07384fa01387b11e3))
* **security:** skip node_modules/npm in Trivy — bundled deps unreachable via overrides ([49dfa6c](https://github.com/mafischer/oRKLLM/commit/49dfa6ccfd490a08d100721caae12bad943d3d50))

# [0.7.0-alpha.29](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.28...v0.7.0-alpha.29) (2026-06-01)


### Bug Fixes

* **dashboard:** display cache sizes in GB when >= 1024 MB ([15f08a2](https://github.com/mafischer/oRKLLM/commit/15f08a22c6ef8d08516248b45490df72804ed3df))
* **search:** show repo storage size with harddisk icon inline with downloads and likes ([df9c0a7](https://github.com/mafischer/oRKLLM/commit/df9c0a721ff9e502c9ba13c96b069ba3dc680554))


### Features

* **dashboard:** add disk table with device name, type, size and SMART status below telemetry gauges ([1f2dd1c](https://github.com/mafischer/oRKLLM/commit/1f2dd1cc88682f6998fe22341be4733f6e98fc5d))

# [0.7.0-alpha.28](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.27...v0.7.0-alpha.28) (2026-06-01)


### Bug Fixes

* regenerate package-lock.json after @fastify/static upgrade to 9.1.3 ([075cf64](https://github.com/mafischer/oRKLLM/commit/075cf64c88748dc0c13fa96b7a2eae77ac4e5f26))
* sync package-lock.json with @fastify/static@9.1.3 upgrade ([3c49ce8](https://github.com/mafischer/oRKLLM/commit/3c49ce8b24be17fd4dda3a9f27b59ac494e3bc02))
* **tests:** fix strict mode NPU locator and grant clipboard permission for snackbar test ([182f082](https://github.com/mafischer/oRKLLM/commit/182f0828891730a0170323ad6f9928c5165aab0e))

# [0.7.0-alpha.27](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.26...v0.7.0-alpha.27) (2026-06-01)


### Bug Fixes

* **search:** read platform from /proc/device-tree/compatible; pass as dedicated param ([cd201d0](https://github.com/mafischer/oRKLLM/commit/cd201d087652cbfca1d658c02e252648e01af6f6))

# [0.7.0-alpha.26](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.25...v0.7.0-alpha.26) (2026-06-01)


### Features

* **dashboard:** add % / units toggle to Hardware Telemetry card ([96ff7dc](https://github.com/mafischer/oRKLLM/commit/96ff7dcc1c569e18304979b922f8ed910153094e))

# [0.7.0-alpha.25](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.24...v0.7.0-alpha.25) (2026-06-01)


### Features

* **ux:** replace all browser alert() popups with Vuetify v-snackbar ([31af206](https://github.com/mafischer/oRKLLM/commit/31af206cf937b6cf2aff6ef184eca26785406f86))

# [0.7.0-alpha.24](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.23...v0.7.0-alpha.24) (2026-06-01)


### Bug Fixes

* **pool:** improve error messages when rkllm_init fails — platform mismatch vs version mismatch ([624ecd2](https://github.com/mafischer/oRKLLM/commit/624ecd22ad2480c2b4746e814156e1a61778590e))
* **search:** single generic 'Compatible chipset' filter with dynamic platform name ([e08b3f7](https://github.com/mafischer/oRKLLM/commit/e08b3f7e5c2c6037f3dfa5ba7ae179241c7359f7))


### Features

* **search:** auto-detect SoC platform and add to HF search query ([2846349](https://github.com/mafischer/oRKLLM/commit/28463497d8dd645175c18d7de78565df5bf24037))

# [0.7.0-alpha.23](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.22...v0.7.0-alpha.23) (2026-06-01)


### Bug Fixes

* correct runtime_sync.js import path in runtimes endpoint (./→../) ([4649bbe](https://github.com/mafischer/oRKLLM/commit/4649bbe76332a73a9979019d644167b74ba5a5ba))


### Features

* **runtime:** show JIT download progress dialog when runtime is fetched during model load ([c28658b](https://github.com/mafischer/oRKLLM/commit/c28658b9abd22afad5064b3e170550ef76364a4a))
* **settings:** trigger immediate runtime sync when auto-download is enabled ([e2b8353](https://github.com/mafischer/oRKLLM/commit/e2b835314f17d66515af4e83971cfacb59bb3005))

# [0.7.0-alpha.22](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.21...v0.7.0-alpha.22) (2026-06-01)


### Bug Fixes

* **dashboard:** use r.file not r.filename for runtime versions table ([011ee88](https://github.com/mafischer/oRKLLM/commit/011ee881606c801a0d33dfefa558001f78d390d2))
* **downloader:** restore download queue on mount and tab switch ([c64d423](https://github.com/mafischer/oRKLLM/commit/c64d4232a9c39e06c464820633ef4d595cea0175))


### Features

* **downloader:** save files to models/{repoName}/ and group queue by repo ([d355b86](https://github.com/mafischer/oRKLLM/commit/d355b862471ccf626f0262239b006c16bd282c84))
* **models:** recursive scan supports subdirectory models; wildcard routes for settings/delete ([64ba54e](https://github.com/mafischer/oRKLLM/commit/64ba54e018428f2c426f5e43183275fe6f882f9b))

# [0.7.0-alpha.21](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.20...v0.7.0-alpha.21) (2026-06-01)


### Bug Fixes

* **cache:** raise sliding context window max to 32768 tokens, default 8192 ([e37eb10](https://github.com/mafischer/oRKLLM/commit/e37eb106276396d50f3c4864f579cedc5aaf732f))


### Features

* **downloader:** Download button fetches all repo files and starts all downloads immediately ([86eeef4](https://github.com/mafischer/oRKLLM/commit/86eeef459c2060185fd9c56b2e029788d7dc1fa8))

# [0.7.0-alpha.20](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.19...v0.7.0-alpha.20) (2026-06-01)


### Bug Fixes

* **nav:** replace version chip with inline text, tighten spacing ([cc8bc34](https://github.com/mafischer/oRKLLM/commit/cc8bc3477a8aaa19f014d52f62b7cd9f47b64f2a))
* **nav:** use primary color for version text at reduced opacity ([5e12601](https://github.com/mafischer/oRKLLM/commit/5e12601114fc1cbbfd073546d6de5f483c723464))
* **tests:** update version assertions from v-chip to inline span ([9bdfdc7](https://github.com/mafischer/oRKLLM/commit/9bdfdc786e77f507a99806da0a9b28ff8bed10e5))

# [0.7.0-alpha.19](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.18...v0.7.0-alpha.19) (2026-06-01)


### Bug Fixes

* **tests:** check href on v-list-item directly — it IS the anchor element ([0732a17](https://github.com/mafischer/oRKLLM/commit/0732a17017fde5d28faba07b7918e3d89ef02df1))
* **tests:** replace playground test with cache observability + runtime versions test ([84ee069](https://github.com/mafischer/oRKLLM/commit/84ee0695a51b68c7a0cb9858ae07167cacd69c2c))


### Features

* **dashboard:** replace inference playground with cache observability and RKLLM runtime versions ([a9899a9](https://github.com/mafischer/oRKLLM/commit/a9899a91838633397e60ae3e9e575f16a2a14dae))

# [0.7.0-alpha.18](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.17...v0.7.0-alpha.18) (2026-06-01)


### Bug Fixes

* **downloader:** encode repo ID path segments separately to preserve slash separator ([ff472ba](https://github.com/mafischer/oRKLLM/commit/ff472baf7c736718735a46532b4d5180c26ca74a))

# [0.7.0-alpha.17](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.16...v0.7.0-alpha.17) (2026-06-01)


### Bug Fixes

* **security:** upgrade @fastify/static to 9.1.3; opt into Node.js 24 for actions ([dca14ef](https://github.com/mafischer/oRKLLM/commit/dca14efe9c367127c7c58db73caeab2ea04fe1ad))


### Features

* **github:** bug report issue template with version field ([061fe2f](https://github.com/mafischer/oRKLLM/commit/061fe2fa7c4429cf07eafebfc72109d4396f2521))

# [0.7.0-alpha.16](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.15...v0.7.0-alpha.16) (2026-06-01)


### Bug Fixes

* **tests:** update downloader tab test — HF token field moved to Settings ([a7c7030](https://github.com/mafischer/oRKLLM/commit/a7c7030f25f75e326fdb2532a88dfafccd8cc447))


### Features

* **downloader:** full download queue with progress, speed, file picker ([a8ab0df](https://github.com/mafischer/oRKLLM/commit/a8ab0df20467e4b1af25cb994360e58cf47cb212))
* **downloader:** restore HF token field in download form for ad-hoc override ([2adb186](https://github.com/mafischer/oRKLLM/commit/2adb186d60727019afd7152700bf16fd9fa51413))
* **nav:** add Contribute button to user drawer linking to GitHub ([fcb35b9](https://github.com/mafischer/oRKLLM/commit/fcb35b91ac4000e76b3ff76114eb3d9951f391f7))

# [0.7.0-alpha.15](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.14...v0.7.0-alpha.15) (2026-06-01)


### Features

* **models:** show model weight size in HF search and collection results ([2a77eba](https://github.com/mafischer/oRKLLM/commit/2a77ebadcd0e8c65e20fb5bbe52e4a8c75e77e63))

# [0.7.0-alpha.14](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.13...v0.7.0-alpha.14) (2026-06-01)


### Bug Fixes

* **nav:** toggle drawers on button tap instead of always opening ([3ef974c](https://github.com/mafischer/oRKLLM/commit/3ef974c2b5c26a2579386595b0e7033de1a7b805))
* **tests:** correct dynamic import paths and flaky test assertions ([f788a87](https://github.com/mafischer/oRKLLM/commit/f788a876c9615fdeee87caf384cc9c7667d3abda))
* **tests:** scope telemetry gauge label assertions to Hardware Telemetry card ([df36244](https://github.com/mafischer/oRKLLM/commit/df362448e453ae074161ff90c71822c6c95936dc))
* **tests:** use inert attribute and correct viewport timing for drawer toggle tests ([c6cbbc9](https://github.com/mafischer/oRKLLM/commit/c6cbbc9f990683d92a211d3097e4547c8c00e51c))
* **tests:** use v-navigation-drawer--active class to assert drawer open/closed state ([fc23145](https://github.com/mafischer/oRKLLM/commit/fc23145742bf0c96dd9828f3d8177cd5f53f6c02))


### Features

* **runtime:** auto-discover and retry rkllm runtimes by version ([3ef14ae](https://github.com/mafischer/oRKLLM/commit/3ef14ae67c41f122aebf26f989f30a2ce6852274))
* **runtime:** read embedded version from librkllmrt.so via strings ([fcb3ca3](https://github.com/mafischer/oRKLLM/commit/fcb3ca3d41475c28fe254205e1f2fe8924a36639))
* **runtimes:** auto-download rkllm runtimes with setup opt-in ([7f56775](https://github.com/mafischer/oRKLLM/commit/7f5677514ebb4c057b40216a5b3a7d26bcbf723a))
* **runtimes:** opt-out flow, model scan version persistence, API 422 on missing runtime ([147dc9f](https://github.com/mafischer/oRKLLM/commit/147dc9f9c0cbd4ba5306137433447cabdbca07ea))
* **telemetry:** add GPU and disk utilization to hardware telemetry ([e56b34d](https://github.com/mafischer/oRKLLM/commit/e56b34da40a9e81b0139bc93937d11f6429fd680))

# [0.7.0-alpha.13](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.12...v0.7.0-alpha.13) (2026-06-01)


### Features

* **pool:** persist pinned model across restarts with auto-load on startup ([5c5983b](https://github.com/mafischer/oRKLLM/commit/5c5983ba93aaed0586256c46c1db13ccb294ea32))

# [0.7.0-alpha.12](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.11...v0.7.0-alpha.12) (2026-06-01)


### Bug Fixes

* **chat:** prevent queued message duplicating in chat history ([a2aad1c](https://github.com/mafischer/oRKLLM/commit/a2aad1c9830a18f670c306a3531d38f307e0ec77))

# [0.7.0-alpha.11](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.10...v0.7.0-alpha.11) (2026-05-31)


### Bug Fixes

* **chat:** persist partial assistant response on page navigation using sendBeacon ([d9dfba7](https://github.com/mafischer/oRKLLM/commit/d9dfba738fd2818904a7eb682f471365649e45e0))

# [0.7.0-alpha.10](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.9...v0.7.0-alpha.10) (2026-05-31)


### Features

* **chat:** add mobile history access via bottom sheet ([1c04205](https://github.com/mafischer/oRKLLM/commit/1c042059c22d8f3efbff07955992e4914dad2760))

# [0.7.0-alpha.9](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.8...v0.7.0-alpha.9) (2026-05-31)


### Bug Fixes

* **tests:** scope sidebar delete assertion to specific item not total count ([14c24ec](https://github.com/mafischer/oRKLLM/commit/14c24ecb2eb59b8e8f6b998813a9f47adf58fd3c))


### Features

* **chat:** persist conversations grouped by model with history sidebar ([cee56cb](https://github.com/mafischer/oRKLLM/commit/cee56cb34b09f2117bfedb44a96d5be027def46a))

# [0.7.0-alpha.8](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.7...v0.7.0-alpha.8) (2026-05-31)


### Features

* **models:** add pin toggle to prevent active model from idle-unloading ([a67726e](https://github.com/mafischer/oRKLLM/commit/a67726e90749bd40bb63a33c96779bad63d539f8))

# [0.7.0-alpha.7](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.6...v0.7.0-alpha.7) (2026-05-31)


### Bug Fixes

* **chat:** anchor layout to fixed viewport to prevent mobile browser chrome shifting ([36c9d68](https://github.com/mafischer/oRKLLM/commit/36c9d686d35d9a4d2f84e551060a7250a3a7e338))
* **chat:** pass no args to sendMessage from DOM events to avoid Event being treated as queued text ([f27a24d](https://github.com/mafischer/oRKLLM/commit/f27a24d929b2961e410ef08a617e0006ecd5f8ff))


### Features

* **chat:** allow typing and queueing messages during generation ([f5dc89c](https://github.com/mafischer/oRKLLM/commit/f5dc89c45ce53b7451ee583d5659df28ceb9b2b4))

# [0.7.0-alpha.6](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.5...v0.7.0-alpha.6) (2026-05-31)


### Bug Fixes

* **chat:** improve LLM response bubble contrast in dark and light themes ([a793047](https://github.com/mafischer/oRKLLM/commit/a793047bc14754c471dee17dce29c3aee6afdb03))

# [0.7.0-alpha.5](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.4...v0.7.0-alpha.5) (2026-05-31)


### Bug Fixes

* **chat:** shorten input placeholder to fit mobile layout ([76e9d3c](https://github.com/mafischer/oRKLLM/commit/76e9d3c6275acf6c8966fa179438fbfdc35195b0))

# [0.7.0-alpha.4](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.3...v0.7.0-alpha.4) (2026-05-30)


### Features

* **proxy:** support comma-separated list of trusted proxy IPs/CIDRs ([014447a](https://github.com/mafischer/oRKLLM/commit/014447a8dd0a2463d87dc1fd782b83144fb04866))

# [0.7.0-alpha.3](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.2...v0.7.0-alpha.3) (2026-05-30)


### Features

* **release:** add APT distribution channels (stable/beta/alpha) ([d205864](https://github.com/mafischer/oRKLLM/commit/d205864df08292fe2f3a0ee3839b33e6fa1a7fc9))

# [0.7.0-alpha.2](https://github.com/mafischer/oRKLLM/compare/v0.7.0-alpha.1...v0.7.0-alpha.2) (2026-05-30)


### Bug Fixes

* **chat:** pin input bar to bottom, only message history scrolls ([08315bc](https://github.com/mafischer/oRKLLM/commit/08315bccfebc2a4cd8594221ed4131c4ff497d91))
* **tests:** use .v-navigation-drawer--right to select user drawer ([2c07c9f](https://github.com/mafischer/oRKLLM/commit/2c07c9f3d3e3391917d2a260ad735455d3bbc10b))
* **ui:** hamburger opens drawer, oRKLLM text navigates to dashboard on mobile ([e0ef600](https://github.com/mafischer/oRKLLM/commit/e0ef600215ac4771eee6c92ea60a5caf294398ec))
* **ui:** hide version chip in mobile navbar, show in user drawer footer ([e13df1e](https://github.com/mafischer/oRKLLM/commit/e13df1e2efdacd2a56609e3e4c3afd4f37524a90))
* **ui:** logo opens mobile nav drawer instead of separate hamburger button ([46b337b](https://github.com/mafischer/oRKLLM/commit/46b337bc6ba6c005980640da548a1f9ec2711116))
* **ui:** responsive navbar for mobile screens ([d91a14f](https://github.com/mafischer/oRKLLM/commit/d91a14fbb76b78034f35160a67a1f5e90dcf720f))


### Features

* **bench:** add model selector dropdown like Chat page ([d5bbaf1](https://github.com/mafischer/oRKLLM/commit/d5bbaf152b16715ab20ef6c9d77c8004bad69835))

# [0.7.0-alpha.1](https://github.com/mafischer/oRKLLM/compare/v0.6.0...v0.7.0-alpha.1) (2026-05-30)


### Features

* **ci:** automated beta promotion after 48h stability window ([b01c259](https://github.com/mafischer/oRKLLM/commit/b01c259b7cdc62f6680d23371d180b23f9579848))
* **github:** bug report issue template with version field ([7245dc4](https://github.com/mafischer/oRKLLM/commit/7245dc4e9aebe3d962cc0678dd3012fe90ae6952))

# [0.6.0](https://github.com/mafischer/oRKLLM/compare/v0.5.1...v0.6.0) (2026-05-30)


### Bug Fixes

* **auth:** don't overwrite local password accounts during OIDC provisioning ([cf9ea45](https://github.com/mafischer/oRKLLM/commit/cf9ea45b9a2d8308b990935d702f6575aa632573))
* **auth:** handle UNIQUE constraint on username during OIDC auto-provision ([4e26281](https://github.com/mafischer/oRKLLM/commit/4e262819e5bb2a5ec90dacb2cdb24737b56d39b3))
* **auth:** import missing dbGetUserByUsername in auth/routes.js ([ce64f7a](https://github.com/mafischer/oRKLLM/commit/ce64f7a96593e769e74912fede58520916139fd3))
* **auth:** link OIDC identity to existing username, update auth_provider to oidc ([9c1c80f](https://github.com/mafischer/oRKLLM/commit/9c1c80f9abffc6ee056bcaa539cd9b449999e284))
* **auth:** log full OIDC error cause for debugging ([9623206](https://github.com/mafischer/oRKLLM/commit/9623206f82a8bd1b9818a03830ba472ffde0f7d6))
* **auth:** migrate openid-client from v4 to v6 API ([8555db6](https://github.com/mafischer/oRKLLM/commit/8555db61aaf10776ea89bd28d02a809112978c60))
* **auth:** reconstruct OIDC callback URL from registered redirectUri to preserve port ([2ef05fd](https://github.com/mafischer/oRKLLM/commit/2ef05fd5c139f770a5809a5d35d10c46825d5cee))
* **auth:** remove nonce from OIDC flow — PKCE is sufficient for public clients ([07dc293](https://github.com/mafischer/oRKLLM/commit/07dc29328ebb8934a9eb282b628cf5fed4bf7fc7))
* **auth:** skip nonce check in OIDC callback if cookie not present ([1ac7170](https://github.com/mafischer/oRKLLM/commit/1ac71709ed726acf56455d48a13364548a269ef9))
* **ci:** add image tag so docker compose uses pre-built Keycloak image ([1f34021](https://github.com/mafischer/oRKLLM/commit/1f340217c2f1d3c44a5c8e24e0baba59df1523bd))
* **ci:** HTTPS on nginx via self-signed cert, redirect URI from LIVE_BASE_URL ([94a436c](https://github.com/mafischer/oRKLLM/commit/94a436c8e7fd39a791db0dc44427c8b490f1ff8b))
* **ci:** use 'orkllm' realm instead of 'master' for Keycloak import ([5b988f9](https://github.com/mafischer/oRKLLM/commit/5b988f9f121662cd9940f04070acebeb2b81aa5f))
* **ci:** use 127.0.0.1:18000 as OIDC redirect URI in CI to avoid state cookie mismatch ([81ac833](https://github.com/mafischer/oRKLLM/commit/81ac8338a6b0a923e368e72372d1c749271b3de0))
* **ci:** use start-dev for Keycloak, bake realm into image, fix wait step ([12844de](https://github.com/mafischer/oRKLLM/commit/12844de36b186a8d588035f08a21fa6b605fb221))
* **test:sso:** update local npm script to use orkllm realm URL ([3e1a10a](https://github.com/mafischer/oRKLLM/commit/3e1a10aedf56dc4bd7417b5f9a111fe04edea164))
* **tests:** after OIDC callback navigate to test server root before polling auth-status ([63d3aa4](https://github.com/mafischer/oRKLLM/commit/63d3aa45c8ea89d1aab1dc9c67bf020d58e14eb1))
* **tests:** derive OIDC redirect URI protocol from ORKLLM_TEST_REDIRECT_BASE ([cda9790](https://github.com/mafischer/oRKLLM/commit/cda9790a5276b03b51506de896eb66f4a37d4e3c))
* **tests:** ensure local auth enabled before login; skip SSO if server unreachable ([57842ab](https://github.com/mafischer/oRKLLM/commit/57842ab347e584002ec734e0222bc176488080c2))
* **tests:** login before DELETE in SSO finally blocks; docs: require doc review on commits ([b13de22](https://github.com/mafischer/oRKLLM/commit/b13de22ad177184e50579157b05ff46fd6b13f0a))
* **tests:** make live server URL configurable via ORKLLM_TEST_LIVE_URL env var ([f00f5f5](https://github.com/mafischer/oRKLLM/commit/f00f5f512ac201259462e32510984f3590834d78))
* **tests:** read admin credentials from env in all spec files ([a0455b0](https://github.com/mafischer/oRKLLM/commit/a0455b099e3cc514e6773acd79a2a3d9de570f0d))
* **tests:** remove hardcoded URL assertion in ssoLogin, poll auth-status instead ([6eb723f](https://github.com/mafischer/oRKLLM/commit/6eb723fef892ef76cf851ebc2a61dd4e3d2b2d33))
* **tests:** suppress Keycloak VERIFY_PROFILE and isolate SSO test cleanup ([ad046e8](https://github.com/mafischer/oRKLLM/commit/ad046e8284e7530cfe9634eccd317e2fac7b1bef))
* **tests:** use API login in rbac tests to avoid Vuetify form timing issues ([84ae7d1](https://github.com/mafischer/oRKLLM/commit/84ae7d1f317f8609816a350a20fa3a28b28c1c7d))
* **tests:** use API login in SSO test finally blocks to bypass OIDC redirect ([c47adb0](https://github.com/mafischer/oRKLLM/commit/c47adb00cf57764a63912b26a93b3e164efb228c))
* **tests:** verify OIDC provider is deleted after SSO admin test finally block ([cccfade](https://github.com/mafischer/oRKLLM/commit/cccfade6977807ecf6fff82d755db72f74973d8b))


### Features

* **ci:** use Keycloak container for SSO E2E tests — identical in CI and locally ([0c00b96](https://github.com/mafischer/oRKLLM/commit/0c00b96c596648d23754d7a0d8b2d600cfa7e67a))
* DB migrations, trusted proxy, mock OIDC SSO tests in CI ([e213722](https://github.com/mafischer/oRKLLM/commit/e21372200e9d54e456fcc328bfa5b6146fbe88d4))
* **release:** add beta and alpha pre-release channels ([a3adcd9](https://github.com/mafischer/oRKLLM/commit/a3adcd91c4ed48464bad10d1546d9117ec1a7151))
* **test:** docker-compose.test.yml for identical SSO test environment locally and in CI ([ac43882](https://github.com/mafischer/oRKLLM/commit/ac43882f00bba3d08588c0155ab8d55c6644e2e2))

## [0.5.1](https://github.com/mafischer/oRKLLM/compare/v0.5.0...v0.5.1) (2026-05-29)


### Bug Fixes

* **auth:** PKCE support for public OIDC clients (no client secret) ([a76b945](https://github.com/mafischer/oRKLLM/commit/a76b945204356b3f0564691b642fdca3698bea67))

# [0.5.0](https://github.com/mafischer/oRKLLM/compare/v0.4.0...v0.5.0) (2026-05-29)


### Features

* **auth:** OIDC/SAML federated auth, multi-user RBAC, site management UI ([5ffbfe2](https://github.com/mafischer/oRKLLM/commit/5ffbfe2a2a2e1ea0affbfa568132865839ac1793))

# [0.4.0](https://github.com/mafischer/oRKLLM/compare/v0.3.1...v0.4.0) (2026-05-28)


### Features

* **cache:** tiered SSD prefix cache and sliding context window ([fe6f678](https://github.com/mafischer/oRKLLM/commit/fe6f67883cc4b3b49efa7c9515dbdb541cc42e56))

## [0.3.1](https://github.com/mafischer/oRKLLM/compare/v0.3.0...v0.3.1) (2026-05-28)


### Bug Fixes

* **models:** resolve short HF collection URLs by searching owner collections ([c47f048](https://github.com/mafischer/oRKLLM/commit/c47f0480500ea8102bdb0c33773ea721c7a28b58))

# [0.3.0](https://github.com/mafischer/oRKLLM/compare/v0.2.1...v0.3.0) (2026-05-28)


### Features

* **models:** HuggingFace model search and collection browser ([e829102](https://github.com/mafischer/oRKLLM/commit/e8291026a8e4e78cd533c632d96293d9021abe81))

## [0.2.1](https://github.com/mafischer/oRKLLM/compare/v0.2.0...v0.2.1) (2026-05-28)


### Bug Fixes

* **ui:** consistent white background in light theme ([1ee1f3a](https://github.com/mafischer/oRKLLM/commit/1ee1f3ac19ff6797fe9d594c360506035a51bcf1))

# [0.2.0](https://github.com/mafischer/oRKLLM/compare/v0.1.4...v0.2.0) (2026-05-28)


### Features

* **ui:** add navbar, Models/Logs/Bench/Chat pages, HF token setting; full E2E coverage ([f3d5be9](https://github.com/mafischer/oRKLLM/commit/f3d5be92edb4aedb1e23c3e538701918c2f08c1c))


### Performance Improvements

* **build:** code-split frontend by route with manualChunks ([60495ce](https://github.com/mafischer/oRKLLM/commit/60495cec444c0414ec1dabfa3e0890f6cdff2980))

## [0.1.4](https://github.com/mafischer/oRKLLM/compare/v0.1.3...v0.1.4) (2026-05-28)


### Bug Fixes

* **addon:** fix RKLLMParam layout and null img string crash for rkllm 1.2.3 ([16c20ac](https://github.com/mafischer/oRKLLM/commit/16c20acad64d4035cb708bf5c07ea6932b160dab))

## [0.1.3](https://github.com/mafischer/oRKLLM/compare/v0.1.2...v0.1.3) (2026-05-28)


### Bug Fixes

* **addon:** correct RKLLMParam struct to match rkllm 1.2.3 API ([5077c18](https://github.com/mafischer/oRKLLM/commit/5077c182159a63793b636759acac97b88937ab30))

## [0.1.2](https://github.com/mafischer/oRKLLM/compare/v0.1.1...v0.1.2) (2026-05-28)


### Bug Fixes

* **db:** read ORKLLM_DB_PATH env var (matches systemd unit) ([9fd5b57](https://github.com/mafischer/oRKLLM/commit/9fd5b57aa0015d25e3c3382035e996a302f159e8))

## [0.1.1](https://github.com/mafischer/oRKLLM/compare/v0.1.0...v0.1.1) (2026-05-28)


### Bug Fixes

* **release:** rebuild frontend after version bump so app version is correct ([44ba942](https://github.com/mafischer/oRKLLM/commit/44ba942b07b66a9ca24d7f5f7972c160ac0dfcf0))

# [0.1.0](https://github.com/mafischer/oRKLLM/compare/v0.0.0...v0.1.0) (2026-05-28)


### Bug Fixes

* **apt:** correct Filename paths in APT Packages index ([a0580f0](https://github.com/mafischer/oRKLLM/commit/a0580f00a86e528f5378c6bc99eb327dc499f709))
* **ci:** force push gh-pages to prevent race condition on concurrent releases ([d03e261](https://github.com/mafischer/oRKLLM/commit/d03e2616b9609634ea7fbc5bafaeb2d72457fdf9)), closes [#pages](https://github.com/mafischer/oRKLLM/issues/pages)
* **ui:** make version chip visible against navbar gradient ([81f1a26](https://github.com/mafischer/oRKLLM/commit/81f1a26295f7e09009d79c1cf8879f53e60393ed))
* **worker:** hard error on ARM64 when RKLLM library fails to load ([92059a4](https://github.com/mafischer/oRKLLM/commit/92059a456c786e06c5edff05df03951c90911cb6))


### Features

* **ui:** light/dark theme toggle in user menu, persisted to localStorage ([f2cc175](https://github.com/mafischer/oRKLLM/commit/f2cc175230608b6ffcf39335fcd1c36f9a1c74dc))
* **ui:** slide-out user menu drawer and theme toggle regression tests ([5aa185f](https://github.com/mafischer/oRKLLM/commit/5aa185f88d5aab1a7e86f487965c41484cc37de5))

# Changelog
