# oRKLLM

[![CI](https://github.com/mafischer/oRKLLM/actions/workflows/ci.yml/badge.svg)](https://github.com/mafischer/oRKLLM/actions/workflows/ci.yml)
[![Release](https://github.com/mafischer/oRKLLM/actions/workflows/release.yml/badge.svg)](https://github.com/mafischer/oRKLLM/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/mafischer/oRKLLM?logo=github)](https://github.com/mafischer/oRKLLM/releases/latest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/github/license/mafischer/oRKLLM)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-RK3576%20%7C%20RK3588-blueviolet?logo=linux)](https://github.com/mafischer/oRKLLM)
[![Tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mafischer/1da454f93b1363fff7f67f731e579a2f/raw/orkllm-tests.json)](https://github.com/mafischer/oRKLLM/actions/workflows/ci.yml)
[![Vulnerabilities](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mafischer/1da454f93b1363fff7f67f731e579a2f/raw/orkllm-vulns.json)](https://github.com/mafischer/oRKLLM/security/code-scanning)

```
              )       (
             ( \     / )          ██████╗ ██████╗ ██╗  ██╗██╗     ██╗     ███╗   ███╗
              \_\   /_/          ██╔═══██╗██╔══██╗██║ ██╔╝██║     ██║     ████╗ ████║
            .-----------.        ██║   ██║██████╔╝█████╔╝ ██║     ██║     ██╔████╔██║
           /  [*]   [*]  \       ██║   ██║██╔══██╗██╔═██╗ ██║     ██║     ██║╚██╔╝██║
          |    \  ω  /    |      ╚██████╔╝██║  ██║██║  ██╗███████╗███████╗██║ ╚═╝ ██║
           \  .-------.  /        ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚═╝
          _/\/  #####  \/\_
         /  /   #####   \  \      Pronounced "ORC-EL-EL-EM"
        / ,/    #####    \, \     OpenAI-compatible LLM inference for Rockchip NPU.
       | / |  .-------.  | \ |    No cloud. No nonsense. Just efficient NPU inference.
       |/  '--[=======]--'  \|
       |       |     |       |
        \   ,  |     |  ,   /
         \  \. |     | ./  /
          '--' |     | '--'
               |     |
              / \   / \
             '   '-'   '
```

oRKLLM is an energy-efficient, OpenAI API-compatible local LLM inference server and premium admin console designed specifically for Rockchip NPU-powered platforms (such as the **RK3576** found in the NanoPi M5 and **RK3588** series SBCs).

Inspired by [jundot/oMLX](https://github.com/jundot/omlx) (which does the same for Apple Silicon), oRKLLM is adaptively re-engineered to run on the Rockchip RKLLM runtime (`librkllmrt.so`) with its unique hardware and concurrency constraints.

---

## 🚀 Key Features

* **OpenAI API Compatibility**: Drop-in `/v1/chat/completions`, `/v1/models`, and `/v1/embeddings` endpoints — works with Open WebUI, Claude Code, and any OpenAI-compatible client.
* **Full Admin Console**: Built with **Vue 3** and **Vuetify 3** — six dedicated pages:
  * **Dashboard** — live CPU/NPU/GPU/RAM/Disk/Temperature gauges, serving stats, prefix cache observability, RKLLM runtime versions
  * **Models** — local model manager, HuggingFace search, collection browser, direct downloader
  * **Settings** — inference defaults, HF token, prefix cache config, trusted proxy
  * **Logs** — full-page real-time log terminal over WebSocket
  * **Bench** — inference benchmark (TTFT, prefill tok/s, generation tok/s)
  * **Chat** — full streaming chat UI with conversation history sidebar (grouped by model), message queueing during inference, system prompt, model selector, and parameter controls
* **Conversation History**: Chat sessions persisted in SQLite grouped by model. Collapsible sidebar on desktop, bottom-sheet on mobile. Partial responses saved via `sendBeacon` on page navigation.
* **Pin Model**: Pin the active model to prevent idle auto-unload. Pin state persists across server restarts and triggers automatic model load on startup when sufficient RAM is available.
* **Multi-User Auth & RBAC**: Local accounts or federated SSO via OIDC/SAML (Keycloak, Google, Azure AD). Two roles: `admin` and `user`. Site Management UI for user CRUD, auth provider config, and audit log.
* **OIDC / SAML SSO**: Standard Flow with PKCE for public clients (no secret required). Group-to-role mapping from IdP claims. Routes at `/auth/oidc/*` and `/auth/saml/*`.
* **HuggingFace Integration**: Search the HF Hub, browse collections (e.g. `huggingface.co/collections/Qwen/qwen3-...`), download `.rkllm` models directly from the admin console. Search results show parameter count (e.g. `8B params`) and storage size.
* **Prefix KV Cache**: Tiered SSD hot/cold LRU cache saves KV state between conversation turns, skipping re-prefill of repeated prefixes. Sliding context window prevents NPU OOM on long conversations.
* **Process-Isolated Execution**: Inference engine runs in a dedicated child process. Model unload/swap terminates the process, guaranteeing full NPU driver memory cleanup.
* **Smart Resource Management**: Single active model lock, auto-swap, configurable idle timeout, pin-to-keep-loaded.
* **Runtime Version Auto-Matching & Auto-Download**: oRKLLM reads the embedded version from each `librkllmrt.so` (via `strings`), matches it against the version in the model filename, and retries all candidates until one succeeds — caching the winner per model. On first setup, opt in to automatically download all versioned runtimes from [mafischer/rkllm-runtimes](https://github.com/mafischer/rkllm-runtimes) (Apache 2.0). Opted-out users are prompted with a disclaimer dialog in the UI; API callers receive HTTP 422 `RUNTIME_MISSING` with the required version. Toggle in Settings after setup.
* **APT Distribution Channels**: Three channels — `stable` (main), `beta`, `alpha` — with separate `dists/<channel>/` directories on gh-pages. Users pin to their preferred channel.
* **Trusted Proxy**: Supports `true`, single IP/CIDR, or comma-separated list (SAN-style) passed directly to Fastify's `trustProxy`.
* **Database Migrations**: PRAGMA user_version migration runner — schema changes (v1–v3) apply automatically on startup, safe across upgrades from any previous version.
* **Seamless Mock Fallback**: On non-ARM64/non-Linux platforms, oRKLLM falls back to a JS mock engine — rapid UI development on macOS/Windows without a board.
* **Dynamic N-API Bindings**: C++ addon uses `dlopen`/`dlsym` — no compile-time dependency on `librkllmrt.so`.
* **Secure Auth**: PBKDF2-HMAC-SHA256 password hashing, signed session cookies (`userId|username|role|expires|HMAC`), backward-compatible with single-user installs.

---

## 🛠️ Architecture & Tech Stack

```mermaid
graph TD
    Client[HTTP Client / Open WebUI] -->|REST API| Fastify[Fastify Server]
    Fastify -->|Admin SPA| Admin[Vue 3 / Vuetify Admin]
    Fastify -->|OpenAI Routes| API[OpenAI API Router]

    API -->|Queue Request| Pool[Engine Pool & Resource Manager]
    Pool -->|Spawn / Message| Worker[Worker Process]
    Worker -->|N-API Addon| Addon[orkllm_napi.node]
    Addon -->|Dynamic dlopen| C_API[librkllmrt.so C API]
    C_API -->|NPU Driver| NPU[Rockchip NPU Hardware]

    Admin -->|WebSocket Telemetry| Monitor[Telemetry Monitor]
    Monitor -->|/sys/kernel/debug/rknpu| Linux[Linux Kernel]
```

| Layer | Technology |
| :--- | :--- |
| **API Server** | Node.js + Fastify (ES Modules) |
| **Native Bindings** | C++ N-API addon (`node-addon-api`) with `dlopen`/`dlsym` |
| **Mock Fallback** | Pure JS mock engine (auto-enabled on non-ARM64/non-Linux) |
| **Frontend** | Vue 3 + Vuetify 3 SPA, built with Vite, route-based code splitting |
| **Database** | SQLite via `node:sqlite` (Node ≥22.5) or `better-sqlite3` (Node 20) |
| **Auth** | Local PBKDF2 + OIDC (PKCE) + SAML 2.0 |
| **Testing** | Playwright E2E (59 tests across 3 spec files), mock OIDC service container in CI |

---

## 📦 Installing from a Release Package (Ubuntu / Armbian ARM64)

Pre-built `.deb` packages for ARM64 are available via the oRKLLM APT repository or directly from the [GitHub Releases page](https://github.com/mafischer/oRKLLM/releases).

### Option A — APT repository (recommended)

Three channels are available:

| Channel | Branch | Description |
| :--- | :--- | :--- |
| `stable` | `main` | Production releases — recommended for most users |
| `beta` | `beta` | Release candidates promoted from alpha after 48 h with no bug reports |
| `alpha` | `alpha` | Cutting-edge development builds |

```bash
# Trust the oRKLLM signing key
curl -fsSL https://mafischer.github.io/oRKLLM/orkllm.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/orkllm.gpg

# Add the repository — replace 'stable' with 'beta' or 'alpha' to follow pre-releases
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/orkllm.gpg] \
  https://mafischer.github.io/oRKLLM stable main" \
  | sudo tee /etc/apt/sources.list.d/orkllm.list

sudo apt update && sudo apt install orkllm
```

### Option B — Direct download

```bash
VERSION=0.7.0
wget https://github.com/mafischer/oRKLLM/releases/latest/download/orkllm_${VERSION}_arm64.deb
sudo dpkg -i orkllm_${VERSION}_arm64.deb
```

### Configure

```bash
sudo nano /etc/orkllm/orkllm.conf
```

```bash
ORKLLM_HOST=0.0.0.0
ORKLLM_PORT=8000
ORKLLM_LIB_PATH=/usr/lib/librkllmrt.so
ORKLLM_MODELS_DIR=/var/lib/orkllm/models
ORKLLM_DB_PATH=/var/lib/orkllm/orkllm.db
```

### Add models and start

```bash
sudo cp your_model.rkllm /var/lib/orkllm/models/
sudo systemctl start orkllm
```

Admin console: `http://<device-ip>:8000/admin`

### Service management

```bash
sudo systemctl start|stop|restart|status orkllm
journalctl -u orkllm -f
```

---

## ⚙️ Installation from Source

### Prerequisites

- Node.js ≥ 18 (≥ 22.5 preferred for native `node:sqlite`)
- `node-gyp` dependencies: Python 3, C++ compiler (Xcode CLT on macOS, `build-essential` on Linux)
- A compiled `.rkllm` model (use `rkllm-toolkit` to convert from HuggingFace)
- `librkllmrt.so` on the target board (typically at `/usr/lib/librkllmrt.so`)

### Setup & Run

```bash
# Install all dependencies (compiles native addon)
npm install

# Build Vue frontend
npm run build:frontend

# Start development server (mock engine auto-enabled on macOS)
npm run dev:server
# → http://localhost:8000/admin
```

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ORKLLM_HOST` | `127.0.0.1` | Listen address (`0.0.0.0` for LAN) |
| `ORKLLM_PORT` | `8000` | Listen port |
| `ORKLLM_LIB_PATH` | `/usr/lib/librkllmrt.so` | Path to Rockchip RKLLM runtime |
| `ORKLLM_MODELS_DIR` | `./models` | Directory scanned for `.rkllm` files |
| `ORKLLM_DB_PATH` | `~/.config/orkllm/auth.db` | SQLite database path |
| `ORKLLM_TRUSTED_PROXY` | *(unset)* | `true` (all), a single IP/CIDR, or comma-separated IPs/CIDRs to trust `X-Forwarded-*` headers |
| `ORKLLM_RUNTIMES_DIR` | `~/.config/orkllm/runtimes` | Directory of versioned `librkllmrt-aarch64-vX.Y.Z.so` files for automatic runtime matching |

---

## 🧪 Running Tests

```bash
# Full E2E suite (mock mode, no board required)
npm test

# SSO integration tests using local Keycloak container (same as CI)
npm run test:sso        # starts Keycloak + runs SSO tests
npm run test:sso:down   # tear down Keycloak when done
```

CI runs the full suite including OIDC SSO via a containerised Keycloak instance with a pre-configured `orkllm` realm.

### Test environment variables

Set these in `.env` locally (gitignored) or as GitHub Actions secrets/variables. The `.env` file is loaded automatically by Playwright.

| Variable | Where | Description |
| :--- | :--- | :--- |
| `ORKLLM_TEST_ADMIN_USER` | Secret | Admin username created during test setup |
| `ORKLLM_TEST_ADMIN_PASS` | Secret | Admin password |
| `ORKLLM_TEST_OIDC_ISSUER` | Secret | Real Keycloak issuer URL (for `ORKLLM_TEST_LIVE=1`) |
| `ORKLLM_TEST_OIDC_CLIENT_ID` | Secret | OIDC client ID (`orkllm-oidc`) |
| `ORKLLM_TEST_SAML_METADATA_URL` | Secret | Real Keycloak SAML metadata URL |
| `ORKLLM_TEST_OIDC_USER` | Secret | Keycloak test user (`testuser`) |
| `ORKLLM_TEST_OIDC_USER_PASS` | Secret | Keycloak test user password |
| `ORKLLM_TEST_OIDC_ADMIN_USER` | Secret | Keycloak admin test user (`testadminuser`) |
| `ORKLLM_TEST_OIDC_ADMIN_PASS` | Secret | Keycloak admin test user password |
| `ORKLLM_TEST_MOCK_OIDC_URL` | Auto-set | Issuer URL of CI Keycloak container (`http://localhost:8080/realms/orkllm`) |
| `ORKLLM_TEST_REDIRECT_BASE` | Auto-set | Base URL for OIDC `redirect_uri` — derived from this so protocol is correct (`http://` in CI, `https://` live) |
| `ORKLLM_TEST_LIVE` | Variable | Set to `1` to run SSO tests against real Keycloak on LAN |
| `ORKLLM_TEST_LIVE_URL` | Variable | Live server URL (e.g. `https://orkllm.fischerapps.com`) |

### Debugging failed CI tests

When E2E tests fail in CI, Playwright uploads screenshots and error context as an artifact named `playwright-report` (retained 7 days).

**Download via CLI:**
```bash
gh run download <run-id> --name playwright-report -D /tmp/report
# Find the run ID with: gh run list --limit 5
```

**Download via browser:** GitHub Actions run → **Summary** → **Artifacts** section at the bottom → download `playwright-report.zip`.

Each failed test has a `test-failed-1.png` screenshot and an `error-context.md` with the stack trace, making it easy to see exactly what the browser showed at the point of failure.

---

## ⚙️ RKLLM Runtime Auto-Downloader

oRKLLM requires a versioned copy of Rockchip's `librkllmrt.so` runtime library to drive NPU inference. Each `.rkllm` model file is compiled against a specific runtime version (e.g. `1.2.3`), and loading a model with the wrong version fails immediately.

### How it works

1. oRKLLM parses the runtime version from the model filename (e.g. `Qwen3-8B-rk3576-w4a16-**1.2.3**.rkllm`).
2. It searches `ORKLLM_RUNTIMES_DIR` (`~/.config/orkllm/runtimes/` by default) for a matching `librkllmrt-aarch64-v1.2.3.so`.
3. If none matches, it retries with all other available runtimes newest-first, then falls back to the system `/usr/lib/librkllmrt.so`.
4. The winning library is cached per model so future loads skip straight to it.

### Auto-download (opt-in)

During first-time setup you are prompted to opt in to **auto-downloading runtimes**. When enabled:

- All available runtime versions are downloaded in the background at server startup.
- When a model is loaded whose required runtime is not yet present, oRKLLM downloads it automatically before retrying the load.
- The toggle can be changed at any time in **Settings → Runtime Auto-Download**.

When opted out, the UI shows a disclaimer dialog before downloading, and API callers receive `HTTP 422 RUNTIME_MISSING` with the required version.

### Runtime mirror

Pre-built `librkllmrt.so` binaries for `aarch64` and `armhf` are published at:

**[github.com/mafischer/rkllm-runtimes](https://github.com/mafischer/rkllm-runtimes)**

The mirror syncs from [airockchip/rknn-llm](https://github.com/airockchip/rknn-llm) nightly. All versions from v1.0.1 onward are available.

#### Direct download

```bash
VERSION=v1.2.3
ARCH=aarch64   # or armhf

curl -fsSL \
  https://github.com/mafischer/rkllm-runtimes/releases/download/${VERSION}/librkllmrt-${ARCH}-${VERSION}.so \
  -o ~/.config/orkllm/runtimes/librkllmrt-${ARCH}-${VERSION}.so
```

### Licensing

`librkllmrt.so` is Rockchip proprietary software distributed by Airockchip under the **[Apache 2.0 License](https://github.com/airockchip/rknn-llm/blob/main/LICENSE)** as part of the [rknn-llm](https://github.com/airockchip/rknn-llm) repository. The Apache 2.0 license explicitly permits redistribution with attribution. The mirror at `mafischer/rkllm-runtimes` reproduces this license in full on every release.

> **oRKLLM does not modify the binaries.** They are downloaded verbatim from the upstream repository and re-published as properly versioned GitHub release artifacts for programmatic access.

---

## 🤝 Credits & Acknowledgements

* **[jundot/oMLX](https://github.com/jundot/omlx)**: Inspired the dashboard layout, metrics design, single-model lifecycle, and OpenAI compatibility structures.
* **Rockchip**: SDKs and runtime libraries (`librkllmrt.so`) powering localized NPU inference.
