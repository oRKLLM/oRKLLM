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

// Fallback for node:sqlite DatabaseSync using better-sqlite3 on Node < 22.5.0
let DatabaseSyncClass;
try {
  const sqlite = await import('node:sqlite');
  DatabaseSyncClass = sqlite.DatabaseSync;
} catch (e) {
  try {
    const Database = (await import('better-sqlite3')).default;
    DatabaseSyncClass = class {
      constructor(dbPath) {
        this.db = new Database(dbPath);
      }
      exec(sql) {
        return this.db.exec(sql);
      }
      prepare(sql) {
        const stmt = this.db.prepare(sql);
        return {
          run(...args) {
            stmt.run(...args);
          },
          get(...args) {
            return stmt.get(...args);
          },
          all(...args) {
            return stmt.all(...args);
          }
        };
      }
    };
  } catch (err) {
    throw new Error('SQLite support is missing. Since your Node version is < 22.5.0, please run "npm install" to compile better-sqlite3.');
  }
}

const SCHEMA_SQL = `
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
`;

function initDb(dbInstance) {
  dbInstance.exec(SCHEMA_SQL);
  dbInstance.exec(`
    INSERT OR IGNORE INTO stats (type) VALUES ('session');
    INSERT OR IGNORE INTO stats (type) VALUES ('all_time');
  `);
  return dbInstance;
}

console.log(`[Database] Initializing SQLite database at: ${DB_FILE}`);
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
    d.exec('DELETE FROM auth; DELETE FROM settings; DELETE FROM model_settings;');
    d.exec(`INSERT OR IGNORE INTO stats (type) VALUES ('session'); INSERT OR IGNORE INTO stats (type) VALUES ('all_time');`);
  });
}
