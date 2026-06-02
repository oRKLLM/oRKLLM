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
