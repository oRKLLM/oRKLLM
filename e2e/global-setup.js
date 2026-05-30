import fs from 'fs';
import path from 'path';

export default async function globalSetup() {
  // Try to reset via the test-mode API endpoint (server may already be running).
  // This avoids SQLITE_READONLY_DBMOVED that occurs when we delete the DB file
  // while the server still has it open.
  try {
    const res = await fetch('http://127.0.0.1:18000/api/admin/reset-for-testing', { method: 'POST' });
    if (res.ok) return; // Server reset — no need to delete files
  } catch {
    // Server not running yet — fall through to file cleanup
  }

  // No server running: clean up leftover DB files from aborted previous runs
  for (const f of ['./test_auth.db', './test_auth.db-wal', './test_auth.db-shm', './test_auth.json']) {
    const p = path.resolve(f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

// Note: global-setup intentionally does NOT clear auth-provider config via API
// because the server isn't started yet at this point.
// Each SSO test uses try/finally to guarantee cleanup after itself.
