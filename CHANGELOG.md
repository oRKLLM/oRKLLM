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
