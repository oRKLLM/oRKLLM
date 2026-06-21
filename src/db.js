import path from 'path';
import fs from 'fs';
import os from 'os';

// Determine config and database paths
const home = os.homedir();
export const CONFIG_DIR = path.join(home, '.config', 'orkllm');

// ORKLLM_DB_PATH is the canonical env var (set by systemd unit).
// ORKLLM_AUTH_FILE is the legacy name kept for backward compatibility.
export const DB_FILE = process.env.ORKLLM_DB_PATH
  || process.env.ORKLLM_AUTH_FILE?.replace(/\.json$/, '.db')
  || path.join(CONFIG_DIR, 'auth.db');

export const AUTH_FILE = DB_FILE; // kept for any legacy import consumers

// Ensure parent directory exists
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// SQLite backend selection:
//   - Node >= 22.5  -> built-in node:sqlite (native, fastest, zero deps)
//   - Node <  22.5  -> node-sqlite3-wasm fallback
//
// The fallback is a WebAssembly build with no native binding, so it carries no
// NODE_MODULE_VERSION / ABI lock — the same artifact runs on every Node major
// (18/20/22/24) and every architecture. This is why the shipped .deb works on
// stock Debian/Ubuntu Node (e.g. trixie's Node 20) without an ABI-matched
// recompile. (The N-API addons in src/addon/ still compile per-arch, but they
// are ABI-stable across Node majors.)
let DatabaseSyncClass;
let usingWasmBackend = false;
try {
  const sqlite = await import('node:sqlite');
  DatabaseSyncClass = sqlite.DatabaseSync;
} catch (e) {
  usingWasmBackend = true;
  try {
    // node-sqlite3-wasm is CommonJS — under dynamic import() its module.exports
    // lands on `.default` (named exports are not statically detected).
    const { Database } = (await import('node-sqlite3-wasm')).default;
    DatabaseSyncClass = class {
      constructor(dbPath) {
        this.db = new Database(dbPath);
      }
      exec(sql) {
        return this.db.exec(sql);
      }
      prepare(sql) {
        // node:sqlite / better-sqlite3 bind params variadically — run(a, b, c) —
        // whereas node-sqlite3-wasm takes a single array (positional) or object
        // (named). All call sites here are positional, so we collect the varargs
        // into an array. WASM statements must be finalized explicitly or they
        // leak heap, so prepare-per-call and finalize; this also preserves the
        // reusable-statement semantics the other backends provide.
        const db = this.db;
        const exec = (method, args) => {
          const stmt = db.prepare(sql);
          try {
            return stmt[method](args.length ? args : undefined);
          } finally {
            stmt.finalize();
          }
        };
        return {
          run(...args) { return exec('run', args); },
          get(...args) { return exec('get', args); },
          all(...args) { return exec('all', args); }
        };
      }
    };
  } catch (err) {
    throw new Error('SQLite support is missing. Node < 22.5.0 requires the node-sqlite3-wasm fallback — run "npm install".');
  }
}

/**
 * Schema migrations — append only. Each entry runs exactly once per DB.
 * Version is tracked via SQLite PRAGMA user_version.
 *
 * Rules:
 *   - Never edit an existing migration — add a new one instead.
 *   - Each migration receives the raw db instance and must be synchronous.
 *   - Migrations run inside an implicit transaction per version step.
 */
const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema: auth, stats, settings, model_settings',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS auth (
          username TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          salt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stats (
          type TEXT PRIMARY KEY,
          total_requests INTEGER DEFAULT 0,
          total_prefill_tokens INTEGER DEFAULT 0,
          total_generated_tokens INTEGER DEFAULT 0,
          total_prefill_time_ms REAL DEFAULT 0.0,
          total_generate_time_ms REAL DEFAULT 0.0
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        CREATE TABLE IF NOT EXISTS model_settings (
          model_id TEXT PRIMARY KEY,
          settings TEXT NOT NULL DEFAULT '{}'
        );
        INSERT OR IGNORE INTO stats (type) VALUES ('session');
        INSERT OR IGNORE INTO stats (type) VALUES ('all_time');
      `);
    },
  },
  {
    version: 2,
    description: 'Multi-user RBAC: users, auth_provider_config, audit_log tables',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          email TEXT,
          role TEXT NOT NULL DEFAULT 'user',
          auth_provider TEXT NOT NULL DEFAULT 'local',
          auth_subject TEXT,
          password_hash TEXT,
          password_salt TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          last_login_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS auth_provider_config (
          id INTEGER PRIMARY KEY,
          provider_type TEXT,
          config TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          username TEXT,
          action TEXT NOT NULL,
          resource TEXT,
          ip_address TEXT,
          timestamp INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    description: 'Chat history: conversations and messages tables',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_model ON conversations(model, updated_at DESC);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);
        PRAGMA foreign_keys = ON;
      `);
    },
  },
  {
    version: 4,
    description: 'MCP servers: mcp_servers table',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          transport TEXT NOT NULL,
          config TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
      `);
    },
  },
  {
    version: 5,
    description: 'Benchmark history: bench_runs table',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS bench_runs (
          id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          ttft_ms REAL,
          prefill_tps REAL,
          gen_tps REAL,
          gen_tokens INTEGER,
          total_ms REAL,
          max_tokens INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bench_runs_created ON bench_runs(created_at DESC);
      `);
    },
  },
  {
    version: 6,
    description: 'Benchmark speculative-decode status columns',
    up(d) {
      d.exec(`ALTER TABLE bench_runs ADD COLUMN spec_enabled INTEGER DEFAULT 0;`);
      d.exec(`ALTER TABLE bench_runs ADD COLUMN spec_strategy TEXT;`);
      d.exec(`ALTER TABLE bench_runs ADD COLUMN spec_hardware TEXT;`);
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function runMigrations(d) {
  // PRAGMA user_version stores the current schema version as an integer
  const current = d.prepare('PRAGMA user_version').get()['user_version'] ?? 0;
  if (current >= LATEST_VERSION) return;

  const pending = MIGRATIONS.filter(m => m.version > current);
  for (const migration of pending) {
    try {
      migration.up(d);
      // Update version — PRAGMA cannot be parameterised, so interpolate directly
      d.exec(`PRAGMA user_version = ${migration.version}`);
      console.log(`[Database] Migration v${migration.version} applied: ${migration.description}`);
    } catch (e) {
      console.error(`[Database] Migration v${migration.version} FAILED:`, e.message);
      throw e;
    }
  }
}

function initDb(dbInstance) {
  runMigrations(dbInstance);
  return dbInstance;
}

// node-sqlite3-wasm (the Node < 22.5 fallback) can't use OS fcntl locks from a
// WASM VFS, so it guards the DB with an atomic mkdir lock at `<db>.lock`. A clean
// process exit removes it; a hard kill or power-cut leaves it behind, and the next
// start then fails migrations with "database is locked", crash-looping the service.
// This DB is opened only by the main server process (the inference worker imports
// none of db/cache/stats), and systemd guarantees a single instance — so any lock
// dir present at our startup is, by definition, stale. Remove it before opening.
// (node:sqlite on Node >= 22.5 uses OS locks released on death, so no .lock dir
// exists there — guarded by usingWasmBackend.)
function clearStaleWasmLock() {
  if (!usingWasmBackend) return;
  const lockPath = DB_FILE + '.lock';
  try {
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      console.warn(`[Database] Removed stale lock ${lockPath} (left by an unclean prior exit)`);
    }
  } catch (e) {
    console.warn(`[Database] Could not clear stale lock ${lockPath}: ${e.message}`);
  }
}

console.log(`[Database] Initializing SQLite database at: ${DB_FILE}`);
clearStaleWasmLock();
let db = initDb(new DatabaseSyncClass(DB_FILE));

// SQLITE_READONLY_DBMOVED (errcode 1032): the DB file was replaced while open
// (e.g. test isolation deletes and recreates it). Reconnect transparently.
function withReconnect(fn) {
  try {
    return fn(db);
  } catch (e) {
    if (e.errcode === 1032) {
      console.log('[Database] DB file replaced, reconnecting...');
      db = initDb(new DatabaseSyncClass(DB_FILE));
      return fn(db);
    }
    throw e;
  }
}

/**
 * Retrieve credentials
 */
export function dbGetCredentials() {
  try {
    return withReconnect(d => d.prepare('SELECT username, hash, salt FROM auth LIMIT 1').get()) || null;
  } catch (e) {
    console.error('[Database] getCredentials error:', e);
    return null;
  }
}

/**
 * Save credentials
 */
export function dbSaveCredentials(username, hash, salt) {
  withReconnect(d => {
    d.exec('DELETE FROM auth');
    d.prepare('INSERT INTO auth (username, hash, salt) VALUES (?, ?, ?)').run(username, hash, salt);
  });
  return true;
}

/**
 * Retrieve stats
 */
export function dbGetStats(type) {
  try {
    const row = withReconnect(d => d.prepare('SELECT total_requests, total_prefill_tokens, total_generated_tokens, total_prefill_time_ms, total_generate_time_ms FROM stats WHERE type = ?').get(type));
    if (!row) return null;
    return {
      totalRequests: row.total_requests,
      totalPrefillTokens: row.total_prefill_tokens,
      totalGeneratedTokens: row.total_generated_tokens,
      totalPrefillTimeMs: row.total_prefill_time_ms,
      totalGenerateTimeMs: row.total_generate_time_ms
    };
  } catch (e) {
    console.error('[Database] getStats error:', e);
    return null;
  }
}

/**
 * Record a request to stats
 */
export function dbRecordRequest(prefillTokens, genTokens, prefillTimeMs, genTimeMs) {
  try {
    withReconnect(d => {
      d.prepare(`UPDATE stats SET total_requests=total_requests+1, total_prefill_tokens=total_prefill_tokens+?, total_generated_tokens=total_generated_tokens+?, total_prefill_time_ms=total_prefill_time_ms+?, total_generate_time_ms=total_generate_time_ms+? WHERE type='session'`).run(prefillTokens, genTokens, prefillTimeMs, genTimeMs);
      d.prepare(`UPDATE stats SET total_requests=total_requests+1, total_prefill_tokens=total_prefill_tokens+?, total_generated_tokens=total_generated_tokens+?, total_prefill_time_ms=total_prefill_time_ms+?, total_generate_time_ms=total_generate_time_ms+? WHERE type='all_time'`).run(prefillTokens, genTokens, prefillTimeMs, genTimeMs);
    });
  } catch (e) {
    console.error('[Database] recordRequest error:', e);
  }
}

/**
 * Clear stats
 */
export function dbClearStats(type) {
  try {
    withReconnect(d => d.prepare(`UPDATE stats SET total_requests=0, total_prefill_tokens=0, total_generated_tokens=0, total_prefill_time_ms=0.0, total_generate_time_ms=0.0 WHERE type=?`).run(type));
    return true;
  } catch (e) {
    console.error('[Database] clearStats error:', e);
    return false;
  }
}

export function dbGetSetting(key) {
  try {
    const row = withReconnect(d => d.prepare('SELECT value FROM settings WHERE key = ?').get(key));
    return row ? row.value : null;
  } catch (e) {
    console.error('[Database] getSetting error:', e);
    return null;
  }
}

export function dbSetSetting(key, value) {
  try {
    withReconnect(d => d.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value)));
    return true;
  } catch (e) {
    console.error('[Database] setSetting error:', e);
    return false;
  }
}

export function dbGetModelSettings(modelId) {
  try {
    const row = withReconnect(d => d.prepare('SELECT settings FROM model_settings WHERE model_id = ?').get(modelId));
    return row ? JSON.parse(row.settings) : {};
  } catch (e) {
    console.error('[Database] getModelSettings error:', e);
    return {};
  }
}

export function dbSetModelSettings(modelId, settings) {
  try {
    withReconnect(d => d.prepare('INSERT OR REPLACE INTO model_settings (model_id, settings) VALUES (?, ?)').run(modelId, JSON.stringify(settings)));
    return true;
  } catch (e) {
    console.error('[Database] setModelSettings error:', e);
    return false;
  }
}

/**
 * Delete per-model settings
 */
export function dbDeleteModelSettings(modelId) {
  try {
    withReconnect(d => d.prepare('DELETE FROM model_settings WHERE model_id = ?').run(modelId));
    return true;
  } catch (e) {
    console.error('[Database] deleteModelSettings error:', e);
    return false;
  }
}

// Only used in test mode (ORKLLM_MOCK=1) to reset state between test runs
export function dbResetForTesting() {
  withReconnect(d => {
    d.exec('DELETE FROM auth; DELETE FROM users; DELETE FROM auth_provider_config; DELETE FROM audit_log; DELETE FROM settings; DELETE FROM model_settings;');
    d.exec(`INSERT OR IGNORE INTO stats (type) VALUES ('session'); INSERT OR IGNORE INTO stats (type) VALUES ('all_time');`);
    // Keep user_version intact — schema tables already exist, no need to re-migrate
  });
}

/** Return current schema version (for diagnostics/admin UI) */
export function dbGetSchemaVersion() {
  return withReconnect(d => d.prepare('PRAGMA user_version').get()['user_version'] ?? 0);
}

// ── Users ──────────────────────────────────────────────────────────────────

export function dbCreateUser({ id, username, email, role, authProvider, authSubject, passwordHash, passwordSalt }) {
  withReconnect(d => d.prepare(
    `INSERT INTO users (id, username, email, role, auth_provider, auth_subject, password_hash, password_salt, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, username, email ?? null, role, authProvider, authSubject ?? null, passwordHash ?? null, passwordSalt ?? null, Date.now()));
}

export function dbGetUserById(id) {
  return withReconnect(d => d.prepare('SELECT * FROM users WHERE id = ?').get(id)) || null;
}

export function dbGetUserByUsername(username) {
  return withReconnect(d => d.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username)) || null;
}

export function dbGetUserBySubject(authProvider, authSubject) {
  return withReconnect(d => d.prepare('SELECT * FROM users WHERE auth_provider = ? AND auth_subject = ?').get(authProvider, authSubject)) || null;
}

export function dbListUsers() {
  return withReconnect(d => d.prepare('SELECT id, username, email, role, auth_provider, is_active, created_at, last_login_at FROM users ORDER BY created_at ASC').all());
}

export function dbUpdateUser(id, fields) {
  const allowed = ['role', 'is_active', 'email', 'last_login_at', 'password_hash', 'password_salt', 'auth_provider', 'auth_subject'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  withReconnect(d => d.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...vals, id));
}

export function dbUsersEmpty() {
  const row = withReconnect(d => d.prepare('SELECT COUNT(*) as n FROM users').get());
  return (row?.n ?? 0) === 0;
}

// ── Auth provider config ───────────────────────────────────────────────────

export function dbGetAuthProviderConfig() {
  const row = withReconnect(d => d.prepare('SELECT provider_type, config FROM auth_provider_config WHERE id = 1').get());
  if (!row) return null;
  return { providerType: row.provider_type, config: JSON.parse(row.config) };
}

export function dbSetAuthProviderConfig(providerType, config) {
  withReconnect(d => d.prepare(
    `INSERT INTO auth_provider_config (id, provider_type, config) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider_type = excluded.provider_type, config = excluded.config`
  ).run(providerType, JSON.stringify(config)));
}

export function dbClearAuthProviderConfig() {
  withReconnect(d => d.prepare('DELETE FROM auth_provider_config WHERE id = 1').run());
}

// ── Audit log ──────────────────────────────────────────────────────────────

export function dbLogAudit({ id, userId, username, action, resource, ipAddress }) {
  try {
    withReconnect(d => d.prepare(
      `INSERT INTO audit_log (id, user_id, username, action, resource, ip_address, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, userId ?? null, username ?? null, action, resource ?? null, ipAddress ?? null, Date.now()));
  } catch (e) {
    console.error('[Database] audit log error:', e);
  }
}

export function dbGetAuditLog(limit = 200) {
  return withReconnect(d => d.prepare(
    'SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?'
  ).all(limit));
}

// --- Conversations ---

export function dbCreateConversation({ id, model, title }) {
  const now = Date.now();
  return withReconnect(d => d.prepare(
    'INSERT INTO conversations (id, model, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, model, title, now, now));
}

export function dbListConversations(model) {
  return withReconnect(d => d.prepare(
    'SELECT id, model, title, created_at, updated_at FROM conversations WHERE model = ? ORDER BY updated_at DESC'
  ).all(model));
}

export function dbGetConversation(id) {
  return withReconnect(d => d.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).get(id));
}

export function dbTouchConversation(id) {
  return withReconnect(d => d.prepare(
    'UPDATE conversations SET updated_at = ? WHERE id = ?'
  ).run(Date.now(), id));
}

export function dbUpdateConversationTitle(id, title) {
  return withReconnect(d => d.prepare(
    'UPDATE conversations SET title = ? WHERE id = ?'
  ).run(title, id));
}

export function dbDeleteConversation(id) {
  return withReconnect(d => d.prepare(
    'DELETE FROM conversations WHERE id = ?'
  ).run(id));
}

// --- Messages ---

export function dbAddMessage({ id, conversationId, role, content }) {
  return withReconnect(d => d.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, conversationId, role, content, Date.now()));
}

export function dbUpdateLastMessage(conversationId, role, content) {
  return withReconnect(d => {
    const lastMsg = d.prepare(
      'SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    ).get(conversationId);
    if (lastMsg && lastMsg.role === role) {
      d.prepare(
        'UPDATE messages SET content = ? WHERE id = ?'
      ).run(content, lastMsg.id);
      return true;
    }
    return false;
  });
}

export function dbGetMessages(conversationId) {
  return withReconnect(d => d.prepare(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId));
}

// --- MCP servers ---
// `config` holds transport-specific JSON: stdio → { command, args[], env{} };
// sse/http → { url, headers{} }. Stored as a string, parsed by the mapper.

function mapMcpRow(row) {
  if (!row) return null;
  let config = {};
  try { config = JSON.parse(row.config); } catch (e) {}
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    config,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function dbListMcpServers() {
  return withReconnect(d => d.prepare(
    'SELECT * FROM mcp_servers ORDER BY created_at ASC'
  ).all()).map(mapMcpRow);
}

export function dbListEnabledMcpServers() {
  return withReconnect(d => d.prepare(
    'SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC'
  ).all()).map(mapMcpRow);
}

export function dbGetMcpServer(id) {
  return mapMcpRow(withReconnect(d => d.prepare(
    'SELECT * FROM mcp_servers WHERE id = ?'
  ).get(id)));
}

export function dbCreateMcpServer({ id, name, transport, config, enabled = true }) {
  const now = Date.now();
  return withReconnect(d => d.prepare(
    'INSERT INTO mcp_servers (id, name, transport, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name, transport, JSON.stringify(config ?? {}), enabled ? 1 : 0, now, now));
}

export function dbUpdateMcpServer(id, fields) {
  const current = dbGetMcpServer(id);
  if (!current) return false;
  const name = fields.name ?? current.name;
  const transport = fields.transport ?? current.transport;
  const config = fields.config ?? current.config;
  const enabled = fields.enabled ?? current.enabled;
  return withReconnect(d => d.prepare(
    'UPDATE mcp_servers SET name = ?, transport = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?'
  ).run(name, transport, JSON.stringify(config ?? {}), enabled ? 1 : 0, Date.now(), id));
}

export function dbDeleteMcpServer(id) {
  return withReconnect(d => d.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id));
}

// --- Benchmark runs ---

export function dbCreateBenchRun({ id, model, ttft_ms, prefill_tps, gen_tps, gen_tokens, total_ms, max_tokens, spec_enabled, spec_strategy, spec_hardware }) {
  return withReconnect(d => d.prepare(
    `INSERT INTO bench_runs (id, model, ttft_ms, prefill_tps, gen_tps, gen_tokens, total_ms, max_tokens, spec_enabled, spec_strategy, spec_hardware, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, model, ttft_ms ?? null, prefill_tps ?? null, gen_tps ?? null, gen_tokens ?? null, total_ms ?? null, max_tokens ?? null, spec_enabled ? 1 : 0, spec_strategy ?? null, spec_hardware ?? null, Date.now()));
}

export function dbListBenchRuns(limit = 50) {
  return withReconnect(d => d.prepare(
    'SELECT * FROM bench_runs ORDER BY created_at DESC LIMIT ?'
  ).all(limit));
}

export function dbDeleteBenchRun(id) {
  return withReconnect(d => d.prepare('DELETE FROM bench_runs WHERE id = ?').run(id));
}

export function dbClearBenchRuns() {
  return withReconnect(d => d.prepare('DELETE FROM bench_runs').run());
}
