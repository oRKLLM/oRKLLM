# oRKLLM — Agent Instructions & Architecture

oRKLLM is an OpenAI API-compatible local LLM inference server and admin application designed for Rockchip NPU-powered platforms (specifically the **RK3576** found in the NanoPi M5 and **RK3588** series).

This project draws architectural inspiration from [oMLX](https://github.com/jundot/omlx) (optimized for Apple Silicon / MLX) but adaptively re-engineered to run on the Rockchip RKLLM runtime (`librkllmrt.so`) with its unique hardware constraints.

---

## 1. Executive Summary & Design Goals

The main objective of **oRKLLM** is to turn low-power Rockchip SBCs (Single Board Computers) into high-performance, self-hosted, private AI endpoints.

### Core Goals:
1. **OpenAI API Compatibility**: Expose standard `/v1/chat/completions`, `/v1/completions`, and `/v1/embeddings` endpoints.
2. **Beautiful Admin Dashboard**: A premium, responsive web console for monitoring NPU/CPU/RAM/Temp utilization, configuring settings, loading/unloading models, and testing inference in real-time.
3. **Optimized NPU Resource Management**: Safely serialize inference calls and manage model swaps (swap-in/swap-out) within NPU memory constraints.
4. **Zero-Inference Dependencies**: Run in-process on the target board (like the NanoPi M5) without needing cloud connectivity, heavy external deep learning runtimes (e.g., PyTorch), or complex compilation toolchains.

---

## 2. Implemented Stack

The project was re-engineered from a Python/FastAPI concept to a fully Node.js stack:

| Layer | Technology |
| :--- | :--- |
| **API Server** | Node.js + Fastify |
| **Native Bindings** | C++ N-API addon (`node-addon-api`) with `dlopen`/`dlsym` for `librkllmrt.so` |
| **Mock Fallback** | Pure JS mock engine (auto-enabled on non-ARM/non-Linux platforms) |
| **Frontend** | Vue 3 + Vuetify 3 SPA, built with Vite, served statically by Fastify |
| **Database** | SQLite via `node:sqlite` (Node ≥22.5) or `better-sqlite3` fallback (Node 20) |
| **E2E Tests** | Playwright |

---

## 3. Hardware & Runtime Constraints of RK3576 (NanoPi M5)

The **NanoPi M5** is powered by the Rockchip **RK3576** SoC:

- **Performance**: 6 TOPS (INT8) NPU.
- **Model Format**: Models must be converted on an **x86 Linux PC** using `rkllm-toolkit` to `.rkllm` format.
- **Quantization**: Must use 4-bit (`w4a16`) or 8-bit (`w8a8`).
- **Active Model Constraint**: Only **one model** can be loaded in NPU memory at a time.
- **Serial Execution**: `rkllm_run` must be called serially. All inference is serialized via a dedicated queue.

---

## 4. Architecture

```mermaid
graph TD
    Client[HTTP Client / Open WebUI] -->|REST API| Fastify[Fastify Server]
    Fastify -->|Admin SPA| Vue[Vue 3 + Vuetify 3 Frontend]
    Fastify -->|OpenAI Routes| API[OpenAI API Router]

    API -->|Queue Request| Pool[Engine Pool & Resource Manager]
    Pool -->|IPC Messages| Worker[Child Process Worker]

    Worker -->|N-API| Addon[orkllm_napi.node]
    Addon -->|dlopen| RKLLM[librkllmrt.so]
    RKLLM -->|C API| NPU[Rockchip NPU Driver]

    Fastify -->|WebSocket /ws/metrics| Monitor[System Monitor]
    Monitor -->|/sys/kernel/debug/rknpu| Linux[Linux Kernel]
```

### Key Components

| File | Role |
| :--- | :--- |
| `src/addon/orkllm_napi.cpp` | C++ N-API addon; wraps `rkllm_init`, `rkllm_run`, `rkllm_destroy` with `Napi::ThreadSafeFunction` for non-blocking callbacks |
| `src/worker.js` | Process-isolated inference worker; receives `load`/`run`/`unload` IPC commands from pool |
| `src/pool.js` | Single-active-model lock, auto-swap, idle timeout (configured via SQLite settings) |
| `src/monitor.js` | Polls CPU, RAM, SoC Temp, NPU load; Rockchip-native on ARM64 Linux, simulated elsewhere |
| `src/stats.js` | Records prefill/generation tokens and latencies in SQLite |
| `src/db.js` | SQLite wrapper; tables: auth, users, auth_provider_config, audit_log, stats, settings, model_settings |
| `src/config.js` | Env-driven settings; multi-user credential helpers; PBKDF2-HMAC-SHA256 |
| `src/cache.js` | Tiered SSD prefix KV cache (hot/cold LRU), sliding context window trim |
| `src/server.js` | Fastify bootstrap; mounts `/ws/metrics`, `/ws/logs`, static SPA, API routes |
| `src/api/routes.js` | `/v1/chat/completions` (SSE streaming + prefix cache), `/v1/models`, `/v1/embeddings` |
| `src/admin/routes.js` | Auth (local + OIDC + SAML), user CRUD, RBAC, HF proxy, audit log, settings |
| `src/mock_engine.js` | JS mock engine streaming realistic fake tokens (for macOS dev) |
| `frontend/src/components/AppNav.vue` | Shared navbar; Site Management item for admins |
| `frontend/src/views/Dashboard.vue` | Serving stats, hardware telemetry, inference playground |
| `frontend/src/views/Models.vue` | Model manager + HF search/collection browser/downloader |
| `frontend/src/views/Settings.vue` | Global settings, HF token, prefix cache config |
| `frontend/src/views/Logs.vue` | Full-page live log terminal (WebSocket) |
| `frontend/src/views/Bench.vue` | Inference benchmark (TTFT, tok/s) |
| `frontend/src/views/Chat.vue` | Full streaming chat against OpenAI-compatible API |
| `frontend/src/views/SiteManagement.vue` | Admin-only: user CRUD, OIDC/SAML config, audit log |
| `frontend/src/views/Login.vue` | Login page; shows SSO button when OIDC/SAML configured |
| `e2e/orkllm.spec.js` | Playwright E2E suite (21 tests — core flow) |
| `e2e/rbac.spec.js` | Playwright E2E suite (31 tests — RBAC, auth provider, Keycloak integration) |

---

## 5. Directory Structure

```text
oRKLLM/
├── AGENTS.md               # This file — canonical agent instructions
├── GEMINI.md               # @AGENTS.md
├── CLAUDE.md               # @AGENTS.md
├── README.md               # Quickstart and general info
├── package.json            # Root NPM package
├── binding.gyp             # node-gyp config for C++ N-API addon
├── playwright.config.js    # Playwright E2E config
├── models/                 # Default directory for .rkllm files
├── src/
│   ├── addon/
│   │   └── orkllm_napi.cpp
│   ├── api/
│   │   └── routes.js
│   ├── admin/
│   │   └── routes.js
│   ├── config.js
│   ├── db.js
│   ├── mock_engine.js
│   ├── monitor.js
│   ├── pool.js
│   ├── server.js
│   ├── stats.js
│   └── worker.js
├── frontend/               # Vue 3 + Vuetify 3 SPA
│   ├── package.json
│   ├── vite.config.js      # Route-based code splitting
│   ├── index.html
│   └── src/
│       ├── main.js
│       ├── App.vue
│       ├── router.js
│       ├── plugins/vuetify.js
│       ├── components/
│       │   └── AppNav.vue  # Shared navbar (all authenticated views)
│       └── views/
│           ├── Dashboard.vue   # Stats, telemetry, inference playground
│           ├── Models.vue      # Model manager + HF search/downloader
│           ├── Settings.vue    # Global settings + HF token
│           ├── Logs.vue        # Live log terminal
│           ├── Bench.vue       # Inference benchmark
│           ├── Chat.vue        # Full chat interface
│           ├── Login.vue
│           └── Setup.vue
└── e2e/
    ├── global-setup.js     # Resets server state between test runs
    ├── orkllm.spec.js      # 12 feature tests
    ├── rbac.spec.js        # RBAC, auth provider, Keycloak integration tests
    └── regression.spec.js  # UI regression tests
```

---

## 6. Local Development

### Prerequisites
- Node.js ≥ 18 (≥ 22.5 preferred for native `node:sqlite`)
- `node-gyp` dependencies: Python 3, C++ compiler (Xcode CLT on macOS)

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
| `ORKLLM_HOST` | `127.0.0.1` | Listen address |
| `ORKLLM_PORT` | `8000` | Listen port |
| `ORKLLM_LIB_PATH` | *(auto-detect)* | Path to `librkllmrt.so` |
| `ORKLLM_MODELS_DIR` | `./models` | Directory scanned for `.rkllm` files |
| `ORKLLM_DB_PATH` | `~/.config/orkllm/auth.db` | SQLite database path |

---

## 7. E2E Testing

The Playwright suite covers the full user journey in mock mode (no board required):

```bash
npm test
# or
npx playwright test
```

Tests cover:
- **First-launch setup** — redirects to `/setup`, creates credentials
- **Auth enforcement** — logout → login redirect, wrong password alert
- **Dashboard** — telemetry gauges visible, navbar does not overlap content
- **Model lifecycle** — scan, load, mock chat stream with prefill/rate metrics
- **Log terminal** — real-time WebSocket log capture
- **RBAC** — Site Management visible for admin, user/provider CRUD, SSO button on login
- **Keycloak OIDC/SAML** — config tests (skipped unless `ORKLLM_TEST_OIDC_CLIENT_SECRET` set)

Identity provider credentials are read from environment variables. Set them in `.env` locally
(gitignored) or as GitHub Actions secrets. See `.env` for variable names.

---

## 7a. Authentication & RBAC

### Architecture

- **Two roles**: `admin` (full access) and `user` (everything except site management)
- **Session cookie**: `userId|username|role|expires|HMAC-SHA256` — backward-compatible with legacy 3-part format
- **Auto-migration**: on first start after upgrade, the single-user `auth` table is migrated to the multi-user `users` table
- **Local auth**: always available; admin can disable it once federated auth is working

### OIDC Flow (e.g. Google, Keycloak)
1. Admin configures issuer URL, client ID/secret, redirect URI in Site Management → Auth Providers
2. Login page shows "Sign in with [Provider]" button
3. `/api/admin/oidc/authorize` → redirects to IdP with `state` + `nonce`
4. `/api/admin/oidc/callback` → exchanges code for tokens → upserts user → issues session cookie
5. Group → role mapping: OIDC `groups` claim values mapped to `admin`/`user`

### SAML Flow (e.g. Keycloak SAML, Azure AD)
1. Admin pastes IdP metadata XML or URL; SP metadata available at `/api/admin/saml/metadata`
2. `/api/admin/saml/login` → creates AuthnRequest → redirects to IdP SSO URL
3. `/api/admin/saml/acs` (POST) → validates Response → upserts user → session cookie
4. Attribute mapping: configurable paths for username, email, groups attributes

### Keycloak Configuration
- **Realm**: `https://auth-lab.fischerapps.com/realms/master`
- **OIDC client**: `orkllm-oidc`
- **SAML client**: `orkllm-saml`
- **Group attribute**: `groups` — add users to `orkllm-admins` for admin role
- **OIDC discovery**: `https://auth-lab.fischerapps.com/realms/master/.well-known/openid-configuration`
- **SAML metadata**: `https://auth-lab.fischerapps.com/realms/master/protocol/saml/descriptor`

---

## 8. Deployment to NanoPi M5

Target board: **NanoPi M5** (`10.6.0.14`) running Rockchip Linux (ARM64).

### 8.1 One-Time Board Setup

These steps only need to be done once:

```bash
# 1. Verify NPU driver is present on the board
ssh michael@10.6.0.14 'cat /sys/kernel/debug/rknpu/version'
# Expected: e.g. "0.9.8"

# 2. Verify librkllmrt.so is present
ssh michael@10.6.0.14 'ls /home/michael/rkllama/src/rkllama/lib/librkllmrt.so'

# 3. Install Node.js on the board (if not already present)
ssh michael@10.6.0.14 'node --version'
# Tested with: v20.20.2
```

### 8.2 Build Frontend Locally (macOS)

Always rebuild the frontend before deploying to ensure the latest UI changes are included:

```bash
cd /Users/michael/Dev/oRKLLM
npm run build:frontend
# Outputs to frontend/dist/
```

### 8.3 Sync Code to Board

Use `rsync` to push the repository (excluding `node_modules`, `.git`, `build/`, and test artifacts). **`build/` must be excluded** — it contains the macOS Mach-O binary which would overwrite the ARM64 ELF compiled on the board:

```bash
rsync -avz \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='build' \
  --exclude='test-results' \
  --exclude='test_auth.db' \
  --exclude='test_auth.json' \
  /Users/michael/Dev/oRKLLM/ \
  michael@10.6.0.14:/home/michael/Dev/oRKLLM/
```

### 8.4 Install Dependencies on Board

The native C++ addon (`orkllm_napi.node`) and `better-sqlite3` must be compiled on the board itself (ARM64):

```bash
ssh -n michael@10.6.0.14 'cd /home/michael/Dev/oRKLLM && npm install'
```

This compiles:
- `build/Release/orkllm_napi.node` — the RKLLM N-API binding
- `node_modules/better-sqlite3` — SQLite fallback for Node 20

### 8.5 Stop Any Running Instance

```bash
ssh -n michael@10.6.0.14 'pkill -f "node src/server.js" || true'
```

### 8.6 Start the Server

```bash
ssh -n michael@10.6.0.14 '
  cd /home/michael/Dev/oRKLLM &&
  nohup env \
    ORKLLM_HOST=0.0.0.0 \
    ORKLLM_PORT=8000 \
    ORKLLM_LIB_PATH=/home/michael/rkllama/src/rkllama/lib/librkllmrt.so \
    node src/server.js > server.log 2>&1 &
  sleep 3 && tail -5 server.log
'
```

Expected output:
```
[Database] Initializing SQLite database at: /home/michael/.config/orkllm/auth.db
{"level":30,"msg":"Server listening at http://0.0.0.0:8000"}
{"level":30,"msg":"oRKLLM server started at http://0.0.0.0:8000"}
```

### 8.7 Verify

```bash
# Check server is running
ssh -n michael@10.6.0.14 'ps aux | grep "node src/server"'

# Open admin console in browser
open http://10.6.0.14:8000/admin
```

### 8.8 Combined Deploy Script (copy-paste)

```bash
#!/usr/bin/env bash
set -e
BOARD=michael@10.6.0.14
BOARD_PATH=/home/michael/Dev/oRKLLM
LIB_PATH=/home/michael/rkllama/src/rkllama/lib/librkllmrt.so

echo "==> Building frontend..."
cd /Users/michael/Dev/oRKLLM
npm run build:frontend

echo "==> Syncing to board..."
rsync -avz \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='build' \
  --exclude='test-results' \
  --exclude='test_auth.db' \
  --exclude='test_auth.json' \
  /Users/michael/Dev/oRKLLM/ $BOARD:$BOARD_PATH/

echo "==> Installing dependencies on board..."
ssh -n $BOARD "cd $BOARD_PATH && npm install"

echo "==> Restarting server..."
ssh -n $BOARD "
  pkill -f 'node src/server.js' || true
  sleep 1
  cd $BOARD_PATH
  nohup env ORKLLM_HOST=0.0.0.0 ORKLLM_PORT=8000 ORKLLM_LIB_PATH=$LIB_PATH \
    node src/server.js > server.log 2>&1 &
  sleep 3 && tail -5 server.log
"
echo "==> Done! Admin console: http://10.6.0.14:8000/admin"
```

---

## 9. Implementation Roadmap

| Phase | Status | Description |
| :--- | :--- | :--- |
| Phase 1: Environment Probe | ✅ Done | SSH to board, verified NPU driver v0.9.8+, located `librkllmrt.so` |
| Phase 2: N-API Bindings | ✅ Done | `orkllm_napi.cpp` with `dlopen`/`dlsym` + `Napi::ThreadSafeFunction` |
| Phase 3: Inference Core | ✅ Done | `pool.js` + `worker.js` with single-active-model lock and idle timeout |
| Phase 4: Web Server & API | ✅ Done | Fastify + OpenAI routes + SSE streaming + WebSocket telemetry |
| Phase 5: Admin Dashboard UI | ✅ Done | Vue 3 + Vuetify 3 SPA with Chat Arena, telemetry gauges, log terminal |
| Phase 6: E2E Tests | ✅ Done | Playwright suite covering full user journey in mock mode |
| Phase 7: Board Deployment | ✅ Done | Deployed to NanoPi M5 at `10.6.0.14`, confirmed listening on port 8000 |
| Phase 8: Auth & RBAC | ✅ Done | OIDC/SAML federated auth, multi-user RBAC, Site Management UI, Keycloak integration |
| Phase 9: Prefix Cache | ✅ Done | Tiered SSD KV cache, sliding context window, cache stats in Settings |
| Phase 10: CI/CD | ✅ Done | GitHub Actions: parallel CI + Release, Trivy scan, dynamic shields.io badges |

---

## 10. Verification Plan

### Automated (Local)
```bash
npm test   # Playwright E2E against local mock server
```

### Manual (On-Device)
1. Deploy via Section 8.8 above.
2. Open `http://10.6.0.14:8000/admin`.
3. Complete first-launch setup (username + password).
4. Load a `.rkllm` model from the Model Explorer.
5. Send a prompt in the Chat Arena — verify NPU load spikes in the telemetry gauges.
6. Check logs terminal shows live server output.
