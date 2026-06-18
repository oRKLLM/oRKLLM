import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ADMIN_USER = process.env.ORKLLM_TEST_ADMIN_USER;
const ADMIN_PASS = process.env.ORKLLM_TEST_ADMIN_PASS;
if (!ADMIN_USER || !ADMIN_PASS) {
  throw new Error('ORKLLM_TEST_ADMIN_USER and ORKLLM_TEST_ADMIN_PASS must be set.');
}

const modelsDir = path.resolve('./models');
const dummyModelName = 'qwen_1.8b.rkllm';
const dummyModelPath = path.join(modelsDir, dummyModelName);

test.beforeAll(() => {
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(dummyModelPath, 'fake-model-binary-data', 'utf-8');
});

test.afterAll(() => {
  if (fs.existsSync(dummyModelPath)) fs.rmSync(dummyModelPath, { force: true });
});

async function login(page) {
  await page.goto('/login');
  await page.locator('input[type="text"]').fill(ADMIN_USER);
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await page.click('button:has-text("Sign In")');
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/, { timeout: 8000 });
}

// v-btn with :to renders as <a class="v-btn"> — clicking does SPA (router)
// navigation, NOT a full reload. Persistence-across-navigation must be tested
// this way; page.goto() would tear down the JS module and invalidate the test.
function navBtn(page, label) {
  return page.locator(`.v-app-bar .v-btn:has-text("${label}")`);
}

async function loadModel(page) {
  await page.goto('/models');
  await expect(page.locator('.v-list-item').filter({ hasText: dummyModelName }).first()).toBeVisible({ timeout: 5000 });
  const unloadBtn = page.locator(`.v-list-item:has-text("${dummyModelName}") button:has-text("Unload")`);
  if (await unloadBtn.isVisible()) return; // already loaded
  await page.locator(`.v-list-item:has-text("${dummyModelName}") button:has-text("Load")`).click();
  await expect(page.locator('.v-alert')).toContainText(`Loaded: ${dummyModelName}`, { timeout: 10000 });
}

function accountBtn(page) {
  return page.locator('.v-app-bar .v-btn:has(.mdi-account)');
}

function drawer(page) {
  // Target user drawer specifically — has logout item, location right
  return page.locator('.v-navigation-drawer--right');
}

test('Navbar: shows oRKLLM brand without Console suffix', async ({ page }) => {
  await login(page);
  const brand = page.locator('.text-gradient');
  await expect(brand).toBeVisible();
  await expect(brand).toContainText('oRKLLM');
  await expect(brand).not.toContainText('Console');
});

test('Navbar: version text is visible on desktop', async ({ page }) => {
  await login(page);
  const versionText = page.locator('.v-app-bar a.d-none.d-sm-flex');
  await expect(versionText).toBeVisible();
  const text = await versionText.textContent();
  expect(text).toMatch(/^v\d+\.\d+/);
});

test('Navbar: version shown in user drawer on mobile', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Version text hidden in navbar on mobile
  const navVersion = page.locator('.v-app-bar a.d-none.d-sm-flex');
  await expect(navVersion).toBeHidden();
  // Opens in user drawer footer
  await page.locator('.v-app-bar .v-btn:has(.mdi-account)').click();
  await page.waitForSelector('.v-navigation-drawer:has(.mdi-logout)', { state: 'visible' });
  const drawerVersion = page.locator('.v-navigation-drawer').locator('text=/^v\\d+\\.\\d+/');
  await expect(drawerVersion).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('User menu: opens as right-side drawer on account button click', async ({ page }) => {
  await login(page);

  const btn = accountBtn(page);
  await expect(btn).toBeVisible();

  const d = drawer(page);
  await btn.click();
  await expect(d).toBeVisible();

  // Vuetify applies v-navigation-drawer--right class for location="right"
  await expect(d).toHaveClass(/v-navigation-drawer--right/);
});

test('User menu: shows signed-in username in drawer', async ({ page }) => {
  await login(page);
  await accountBtn(page).click();
  const d = drawer(page);
  await expect(d).toBeVisible();
  await expect(d.locator('text=Signed in as')).toBeVisible();
  await expect(d.locator(`text=${ADMIN_USER}`)).toBeVisible();
});

test('Theme toggle: label says "Light Mode" when in dark mode', async ({ page }) => {
  await login(page);

  await page.evaluate(() => localStorage.setItem('orkllm-theme', 'customDarkTheme'));
  await page.reload();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);

  await accountBtn(page).click();
  const d = drawer(page);
  await expect(d).toBeVisible();

  // In dark mode the button should label the action "Light Mode" (what it will switch TO)
  await expect(d.locator('.v-list-item').filter({ hasText: 'Light Mode' })).toBeVisible();
  await expect(d.locator('.v-list-item').filter({ hasText: 'Dark Mode' })).not.toBeVisible();
});

test('Theme toggle: switches to light mode and updates localStorage', async ({ page }) => {
  await login(page);

  await page.evaluate(() => localStorage.setItem('orkllm-theme', 'customDarkTheme'));
  await page.reload();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);

  await accountBtn(page).click();
  const d = drawer(page);
  await expect(d).toBeVisible();

  // Click "Light Mode" to switch away from dark
  await d.locator('.v-list-item').filter({ hasText: 'Light Mode' }).click();

  // Label should now show "Dark Mode" (the reverse action)
  await expect(d.locator('.v-list-item').filter({ hasText: 'Dark Mode' })).toBeVisible();
  await expect(d.locator('.v-list-item').filter({ hasText: 'Light Mode' })).not.toBeVisible();

  // Wait for localStorage to be written, then assert
  await page.waitForFunction(
    () => localStorage.getItem('orkllm-theme') === 'customLightTheme',
    { timeout: 3000 }
  );
  const stored = await page.evaluate(() => localStorage.getItem('orkllm-theme'));
  expect(stored).toBe('customLightTheme');
});

test('Theme toggle: round-trips back to dark mode', async ({ page }) => {
  await login(page);

  await page.evaluate(() => localStorage.setItem('orkllm-theme', 'customDarkTheme'));
  await page.reload();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);

  await accountBtn(page).click();
  const d = drawer(page);
  await expect(d).toBeVisible();

  // Dark → Light
  await d.locator('.v-list-item').filter({ hasText: 'Light Mode' }).click();
  await expect(d.locator('.v-list-item').filter({ hasText: 'Dark Mode' })).toBeVisible();

  // Light → Dark
  await d.locator('.v-list-item').filter({ hasText: 'Dark Mode' }).click();
  await expect(d.locator('.v-list-item').filter({ hasText: 'Light Mode' })).toBeVisible();

  await page.waitForFunction(
    () => localStorage.getItem('orkllm-theme') === 'customDarkTheme',
    { timeout: 3000 }
  );
  const stored = await page.evaluate(() => localStorage.getItem('orkllm-theme'));
  expect(stored).toBe('customDarkTheme');
});

test('Theme toggle: persists across page reload', async ({ page }) => {
  await login(page);

  await page.evaluate(() => localStorage.setItem('orkllm-theme', 'customDarkTheme'));
  await page.reload();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);

  // Switch to light
  await accountBtn(page).click();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).locator('.v-list-item').filter({ hasText: 'Light Mode' }).click();

  // Wait for localStorage to update before reloading
  await page.waitForFunction(
    () => localStorage.getItem('orkllm-theme') === 'customLightTheme',
    { timeout: 3000 }
  );

  // Reload and verify light mode is still active
  await page.reload();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);

  await accountBtn(page).click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('.v-list-item').filter({ hasText: 'Dark Mode' })).toBeVisible();

  // Restore dark mode for subsequent tests
  await drawer(page).locator('.v-list-item').filter({ hasText: 'Dark Mode' }).click();
  await page.waitForFunction(
    () => localStorage.getItem('orkllm-theme') === 'customDarkTheme',
    { timeout: 3000 }
  );
});

test('User menu: Sign Out navigates to login page', async ({ page }) => {
  await login(page);
  await accountBtn(page).click();
  const d = drawer(page);
  await expect(d).toBeVisible();
  await d.locator('.v-list-item').filter({ hasText: 'Sign Out' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('Hamburger: toggles mobile nav drawer open then closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page); // login after setting viewport so Vuetify picks up mobile breakpoint

  // v-icon renders as <i class="mdi-menu ..."> — click directly with force
  const hamburger = page.locator('.v-app-bar .mdi-menu');
  await expect(hamburger).toBeVisible({ timeout: 5000 });

  const navDrawer = page.locator('.v-navigation-drawer--left');

  // First tap — drawer opens (inert attribute removed)
  await hamburger.click({ force: true });
  await expect(navDrawer).not.toHaveAttribute('inert', { timeout: 3000 });

  // Second tap — drawer closes (inert attribute restored)
  await hamburger.click({ force: true });
  await expect(navDrawer).toHaveAttribute('inert', { timeout: 3000 });

  await page.setViewportSize({ width: 1280, height: 800 });
});

test('Account button: toggles user drawer open then closed', async ({ page }) => {
  await login(page);

  const btn = accountBtn(page);
  const d = drawer(page);

  // First click — drawer opens (inert removed)
  await btn.click();
  await expect(d).not.toHaveAttribute('inert', { timeout: 3000 });

  // Second click — drawer closes (inert restored)
  await btn.click();
  await expect(d).toHaveAttribute('inert', { timeout: 3000 });
});

test('User menu: Contribute button links to GitHub', async ({ page }) => {
  await login(page);
  await accountBtn(page).click();
  const d = drawer(page);
  await expect(d).toBeVisible();

  const contributeLink = d.locator('.v-list-item').filter({ hasText: 'Contribute' });
  await expect(contributeLink).toBeVisible();
  // v-list-item with href renders as the <a> element itself
  const href = await contributeLink.getAttribute('href');
  expect(href).toContain('github.com/mafischer/oRKLLM');
});

test('No browser alert() popups — notifications use Vuetify snackbar', async ({ page }) => {
  await login(page);

  // Intercept any native dialog — should never fire from app code
  let alertFired = false;
  page.on('dialog', dialog => { alertFired = true; dialog.dismiss(); });

  await page.goto('/');

  // Grant clipboard permission so the copy button uses $notify not alert()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.v-btn:has(.mdi-content-copy)').first().click({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(500);
  expect(alertFired).toBe(false);

  // v-snackbar rendered by App.vue should be in the DOM
  await expect(page.locator('.v-snackbar')).toBeAttached();
});

// ---------------------------------------------------------------------------
// State persistence across in-app navigation (shared reactive stores)
// ---------------------------------------------------------------------------

test('Bench: results persist when navigating away and back', async ({ page }) => {
  await login(page);
  await loadModel(page);

  await navBtn(page, 'Bench').click();
  await expect(page).toHaveURL(/\/bench/);

  // Run the benchmark to completion so a Results card is rendered.
  const runBtn = page.locator('button:has-text("Run Benchmark")');
  await expect(runBtn).toBeEnabled({ timeout: 8000 });
  await runBtn.click();

  const resultsCard = page.locator('.v-card').filter({ hasText: /Results/ });
  await expect(resultsCard).toBeVisible({ timeout: 20000 });
  const genTokens = await page.locator('.v-card').filter({ hasText: /Results/ })
    .locator('text=/Total tokens generated/').first().isVisible();
  expect(genTokens).toBe(true);

  // Navigate away (Dashboard) then back to Bench via SPA router links.
  await navBtn(page, 'Dashboard').click();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);
  await navBtn(page, 'Bench').click();
  await expect(page).toHaveURL(/\/bench/);

  // Previously the Results card lived in component data() and was wiped on
  // remount; with the shared store it must still be visible.
  await expect(page.locator('.v-card').filter({ hasText: /Results/ })).toBeVisible({ timeout: 5000 });
});

test('Chat: conversation persists when navigating away and back', async ({ page }) => {
  await login(page);
  await loadModel(page);

  await navBtn(page, 'Chat').click();
  await expect(page).toHaveURL(/\/chat/);

  const chatInput = page.locator('textarea').first();
  await expect(chatInput).toBeEnabled({ timeout: 8000 });
  await chatInput.fill('Persistence check 123');
  await page.keyboard.press('Enter');

  // Wait for the streamed mock response to complete. Scope the user-message
  // assertion to the user bubble (bg-primary) — the mock response echoes the
  // prompt, so an unscoped .message-bubble filter matches both bubbles.
  const userBubble = page.locator('.message-bubble.bg-primary').filter({ hasText: 'Persistence check 123' });
  await expect(page.locator('.message-bubble').last()).toContainText('simulated response', { timeout: 10000 });
  await expect(userBubble).toBeVisible();

  // Navigate away (Dashboard) then back to Chat via SPA router links.
  await navBtn(page, 'Dashboard').click();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);
  await navBtn(page, 'Chat').click();
  await expect(page).toHaveURL(/\/chat/);

  // Previously chatHistory lived in component data() and was reset on remount
  // (the active conversation was not reopened); the shared store keeps it.
  await expect(page.locator('.message-bubble.bg-primary').filter({ hasText: 'Persistence check 123' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.message-bubble').last()).toContainText('simulated response');
});

// ---------------------------------------------------------------------------
// MCP servers — Settings CRUD
// ---------------------------------------------------------------------------

test('Settings: MCP server can be added, listed, and deleted', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings/);

  // MCP Servers section is present.
  await expect(page.locator('.section-heading').filter({ hasText: 'MCP Servers' })).toBeVisible({ timeout: 8000 });

  // Open the add dialog and fill a stdio server (no network needed; saved with validate:false).
  await page.locator('button:has-text("Add Server")').click();
  const dialog = page.locator('.v-overlay--active .v-card');
  await expect(dialog.locator('text=Add MCP Server')).toBeVisible();
  await dialog.locator('.v-text-field:has(label:has-text("Name")) input').fill('E2E MCP Server');
  // Transport defaults to stdio → fill Command.
  await dialog.locator('.v-text-field:has(label:has-text("Command")) input').fill('echo');
  await dialog.locator('button:has-text("Save")').click();

  // Row appears in the table.
  const row = page.locator('.mcp-table tbody tr').filter({ hasText: 'E2E MCP Server' });
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row.locator('.v-chip')).toContainText('stdio');

  // Delete it.
  await row.locator('button[title="Delete"]').click();
  await expect(page.locator('.mcp-table tbody tr').filter({ hasText: 'E2E MCP Server' })).toHaveCount(0, { timeout: 5000 });
});

test('Chat: MCP tool picker is present in the system prompt panel', async ({ page }) => {
  await login(page);
  await loadModel(page);
  await navBtn(page, 'Chat').click();
  await expect(page).toHaveURL(/\/chat/);

  // Expand the "System Prompt & Parameters" panel.
  await page.locator('.v-expansion-panel-title:has-text("System Prompt")').click();

  // The "Use MCP tools" switch and its availability hint are shown. With no
  // enabled MCP servers in the mock environment it reports "no enabled MCP servers"
  // and the switch is disabled (so the scrollable picker stays hidden).
  await expect(page.locator('text=Use MCP tools')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('text=no enabled MCP servers')).toBeVisible();
});

test('Settings: "Use MCP tools in inference" toggle persists', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page.locator('.section-heading').filter({ hasText: 'MCP Servers' })).toBeVisible({ timeout: 8000 });

  // The toggle lives in the MCP card next to the "Use MCP tools in inference" label.
  const toggleRow = page.locator('.v-card').filter({ hasText: 'Use MCP tools in inference' });
  const sw = toggleRow.locator('.v-switch input[type="checkbox"]').first();
  const before = await sw.isChecked();
  await toggleRow.locator('.v-switch').first().click();
  await page.locator('button:has-text("Save Settings")').click();
  await expect(page.locator('.v-snackbar')).toContainText('Settings saved', { timeout: 5000 });

  // Reload and confirm the new value stuck.
  await page.reload();
  await expect(page.locator('.section-heading').filter({ hasText: 'MCP Servers' })).toBeVisible({ timeout: 8000 });
  const after = await page.locator('.v-card').filter({ hasText: 'Use MCP tools in inference' })
    .locator('.v-switch input[type="checkbox"]').first().isChecked();
  expect(after).toBe(!before);
});

test('Models: auto-unload timeout persists and displays after page reload', async ({ page }) => {
  await login(page);
  await page.goto('/models');

  const card = page.locator('.v-card').filter({ hasText: 'Inactivity Auto-Unload Timeout' });
  await expect(card).toBeVisible({ timeout: 8000 });

  // Set the slider to a non-default value (default is 5) via keyboard, which is
  // deterministic for a Vuetify slider (Home → min, ArrowRight → +step).
  const thumb = card.locator('[role="slider"]');
  await thumb.click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  await expect(card.locator('.v-chip')).toHaveText('12m');

  // Save, then do a FULL page reload (not SPA nav) and re-fetch status.
  await card.getByRole('button', { name: 'Save Timeout' }).click();
  await page.reload();

  // Regression: the saved value must be shown after reload — previously the UI
  // read it from the wrong field (active model's load options) and fell back to
  // the 5m default, so the saved value was lost on refresh.
  const cardAfter = page.locator('.v-card').filter({ hasText: 'Inactivity Auto-Unload Timeout' });
  await expect(cardAfter.locator('.v-chip')).toHaveText('12m', { timeout: 8000 });

  // Restore the default so later tests start from a known timeout.
  await cardAfter.locator('[role="slider"]').click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await cardAfter.getByRole('button', { name: 'Save Timeout' }).click();
});

// ---------------------------------------------------------------------------
// PWA — installable manifest + service worker (built dist; 127.0.0.1 = secure context)
// ---------------------------------------------------------------------------

test('PWA: manifest is linked, valid, and icons resolve', async ({ page }) => {
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toMatch(/\.webmanifest$/);

  const res = await page.request.get(href);
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBe('oRKLLM');
  expect(m.short_name).toBe('oRKLLM');
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBe('/');
  expect(m.theme_color).toBe('#7C3AED');
  // icons: 192, 512, and a maskable
  const sizes = m.icons.map(i => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(m.icons.some(i => i.purpose === 'maskable')).toBeTruthy();
  for (const icon of m.icons) {
    const ir = await page.request.get('/' + icon.src.replace(/^\//, ''));
    expect(ir.ok()).toBeTruthy();
  }
});

test('PWA: theme-color + apple-touch-icon present', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('meta[name="theme-color"][content="#7C3AED"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
});

test('PWA: service worker registers and sw.js is no-cache', async ({ page }) => {
  await page.goto('/login');
  const ready = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then(r => !!r),
      new Promise(res => setTimeout(() => res(false), 8000)),
    ]);
    return reg;
  });
  expect(ready).toBeTruthy();

  const swRes = await page.request.get('/sw.js');
  expect(swRes.ok()).toBeTruthy();
  expect((swRes.headers()['cache-control'] || '')).toContain('no-cache');
});

test('PWA: API stays network-only (not the cached shell)', async ({ page }) => {
  await page.goto('/login');
  await page.evaluate(() => navigator.serviceWorker?.ready);
  const res = await page.request.get('/api/admin/auth-status');
  expect((res.headers()['content-type'] || '')).toContain('application/json');
  await res.json(); // parses as JSON, not index.html
});

// ---------------------------------------------------------------------------
// Benchmark history persistence
// ---------------------------------------------------------------------------

test('Bench: completed run is persisted in Previous Runs and survives reload', async ({ page }) => {
  await login(page);
  await loadModel(page);
  await navBtn(page, 'Bench').click();
  await expect(page).toHaveURL(/\/bench/);

  const runBtn = page.locator('button:has-text("Run Benchmark")');
  await expect(runBtn).toBeEnabled({ timeout: 8000 });
  await runBtn.click();

  // Wait for the run to finish (Results card appears).
  await expect(page.locator('.v-card').filter({ hasText: /Results/ })).toBeVisible({ timeout: 20000 });

  // Previous Runs table appears with at least one row.
  const history = page.locator('.v-card').filter({ hasText: 'Previous Runs' });
  await expect(history).toBeVisible({ timeout: 5000 });
  await expect(history.locator('.bench-history tbody tr').first()).toBeVisible();

  // Persists across a full reload (fetched from the DB on mount).
  await page.reload();
  await expect(page.locator('.v-card').filter({ hasText: 'Previous Runs' })
    .locator('.bench-history tbody tr').first()).toBeVisible({ timeout: 8000 });
});

test('Version: /api/version returns the app version and matches the bundle', async ({ page }) => {
  const res = await page.request.get('/api/version');
  expect(res.ok()).toBeTruthy();
  const { version } = await res.json();
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  // The page must NOT reload-loop: load /login, confirm it settles (no mismatch).
  await page.goto('/login');
  await expect(page).toHaveURL(/\/login/);
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/login/); // still here — no forced reload loop
});

// ── Dual-runtime (rkllm + llama) feature tests ──────────────────────────────

test.describe('Dual-runtime (rkllm + llama)', () => {
  const dummyGgufName = 'test_model.gguf';
  const dummyGgufPath = path.join(modelsDir, dummyGgufName);

  test.beforeAll(async () => {
    fs.writeFileSync(dummyGgufPath, 'fake-gguf-data', 'utf-8');
    // Unload any model left by the Bench test so activeRuntime is null.
    // Unload requires auth — login first to obtain the session cookie.
    try {
      const loginRes = await fetch('http://127.0.0.1:18000/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
      });
      const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
      if (cookie) {
        await fetch('http://127.0.0.1:18000/api/admin/unload', {
          method: 'POST',
          headers: { Cookie: cookie },
        });
      }
    } catch {}
  });

  test.afterAll(() => {
    if (fs.existsSync(dummyGgufPath)) fs.rmSync(dummyGgufPath, { force: true });
  });

  test('/v1/models lists .gguf files tagged with runtime=llama', async ({ page }) => {
    const res = await page.request.get('/v1/models');
    expect(res.ok()).toBeTruthy();
    const { data } = await res.json();
    const gguf = data.find(m => m.id === dummyGgufName);
    expect(gguf).toBeTruthy();
    expect(gguf.runtime).toBe('llama');
    const rkllm = data.find(m => m.id === dummyModelName);
    expect(rkllm).toBeTruthy();
    expect(rkllm.runtime).toBe('rkllm');
  });

  test('/api/admin/library includes .gguf in available with runtime=llama', async ({ page }) => {
    await login(page);
    const res = await page.request.get('/api/admin/library');
    expect(res.ok()).toBeTruthy();
    const { available } = await res.json();
    const gguf = available.find(m => m.id === dummyGgufName);
    expect(gguf).toBeTruthy();
    expect(gguf.runtime).toBe('llama');
  });

  test('/api/admin/status includes activeRuntime and llamaRuntime fields', async ({ page }) => {
    await login(page);
    const res = await page.request.get('/api/admin/status');
    expect(res.ok()).toBeTruthy();
    const status = await res.json();
    expect('activeRuntime' in status).toBeTruthy();
    expect('llamaRuntime' in status).toBeTruthy();
    expect(status.activeRuntime).toBeNull(); // nothing loaded after explicit unload in beforeAll
    expect(typeof status.llamaRuntime).toBe('object');
    expect('available' in status.llamaRuntime).toBeTruthy();
  });

  test('/api/admin/llama-runtime endpoint exists and returns correct shape', async ({ page }) => {
    await login(page);
    const res = await page.request.get('/api/admin/llama-runtime');
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect('available' in d).toBeTruthy();
    expect('path' in d).toBeTruthy();
    expect('syncState' in d).toBeTruthy();
    expect('autoDownload' in d).toBeTruthy();
    expect(d.available).toBe(false); // not installed in test env
  });

  test('/api/admin/global-settings includes autoDownloadLlamaRuntime', async ({ page }) => {
    await login(page);
    const res = await page.request.get('/api/admin/global-settings');
    expect(res.ok()).toBeTruthy();
    const { settings } = await res.json();
    expect('autoDownloadLlamaRuntime' in settings).toBeTruthy();
    expect(typeof settings.autoDownloadLlamaRuntime).toBe('boolean');
  });

  test('autoDownloadLlamaRuntime setting can be toggled and persists', async ({ page }) => {
    await login(page);
    const res1 = await page.request.post('/api/admin/global-settings', {
      data: { autoDownloadLlamaRuntime: true }
    });
    expect(res1.ok()).toBeTruthy();
    const res2 = await page.request.get('/api/admin/global-settings');
    const { settings } = await res2.json();
    expect(settings.autoDownloadLlamaRuntime).toBe(true);
    // restore
    await page.request.post('/api/admin/global-settings', { data: { autoDownloadLlamaRuntime: false } });
  });

  test('Settings page shows Llama Runtime card', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await expect(page.locator('text=Llama Runtime (Open NPU)')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('text=Auto-download llama runtime')).toBeVisible();
  });

  test('Models page shows runtime chip for rkllm and gguf models', async ({ page }) => {
    await login(page);
    await page.goto('/models');
    // Both chips should appear somewhere in the available models list
    await expect(page.locator('.v-chip', { hasText: 'rkllm / .rkllm' }).first()).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.v-chip', { hasText: 'llama / .gguf' }).first()).toBeVisible({ timeout: 6000 });
  });

  test('Dashboard shows Inference Engines card with Llama subsection', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await expect(page.locator('text=Inference Engines')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('text=Llama (Open NPU)')).toBeVisible({ timeout: 6000 });
  });
});

// Regression: the manual "Find Files" path (fetchRepoFiles) once treated the
// /api/admin/hf/files response as an array and called .filter on it, throwing
// "filter is not a function". The endpoint actually returns { repoId, files:[…] }.
// Intercept it with that shape and assert the picker renders (with quant chips)
// and does not crash — no live HuggingFace dependency.
test('Downloader: Find Files renders the picker for a multi-quant repo', async ({ page }) => {
  await login(page);
  await page.goto('/models');
  await page.click('.v-tab:has-text("Downloader")');

  await page.route('**/api/admin/hf/files**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      repoId: 'test/Multi-GGUF',
      files: [
        { name: 'model-Q4_K_M.gguf', size: 1200000000 },
        { name: 'model-Q8_0.gguf',   size: 2000000000 },
        { name: 'config.json',       size: 1024 },
      ],
    }),
  }));

  const repoField = page.locator('.v-text-field').filter({ hasText: /Repo ID/i }).first();
  await repoField.locator('input').fill('test/Multi-GGUF');
  await page.click('button:has-text("Find Files")');

  // Picker lists each file with its quant chip — and crucially, no crash.
  await expect(page.locator('.v-list-item', { hasText: 'model-Q4_K_M.gguf' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.v-list-item', { hasText: 'model-Q8_0.gguf' })).toBeVisible();
  await expect(page.locator('.v-chip', { hasText: 'Q4_K_M' })).toBeVisible();
  await expect(page.getByText('is not a function')).toHaveCount(0);
});
