# [0.7.0](https://github.com/mafischer/oRKLLM/compare/v0.6.0...v0.7.0) (2026-06-01)


### Features

* **github:** bug report issue template with version field ([061fe2f](https://github.com/mafischer/oRKLLM/commit/061fe2fa7c4429cf07eafebfc72109d4396f2521))

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
