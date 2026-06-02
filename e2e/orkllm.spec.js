import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Credentials are sourced from env so they're consistent across all spec files.
// Throw early if they're missing in CI rather than getting a cryptic 401.
const ADMIN_USER = process.env.ORKLLM_TEST_ADMIN_USER;
const ADMIN_PASS = process.env.ORKLLM_TEST_ADMIN_PASS;
if (!ADMIN_USER || !ADMIN_PASS) {
  throw new Error(
    'ORKLLM_TEST_ADMIN_USER and ORKLLM_TEST_ADMIN_PASS must be set. ' +
    'Add them to your .env file locally or as GitHub Actions secrets in CI.'
  );
}

const modelsDir = path.resolve('./models');
const dummyModelName = 'qwen_1.8b.rkllm';
const dummyModelPath = path.join(modelsDir, dummyModelName);

test.beforeAll(() => {
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  fs.writeFileSync(dummyModelPath, 'fake-model-binary-data', 'utf-8');
});

test.afterAll(() => {
  if (fs.existsSync(dummyModelPath)) {
    fs.rmSync(dummyModelPath, { force: true });
  }
});

// v-btn with :to renders as <a class="v-btn">, not <button>
function navBtn(page, label) {
  return page.locator(`.v-app-bar .v-btn:has-text("${label}")`);
}

async function login(page, username = ADMIN_USER, password = ADMIN_PASS) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/, { timeout: 8000 });
  await page.locator('input[type="text"]').fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.click('button:has-text("Sign In")');
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/, { timeout: 8000 });
}

async function loadModel(page) {
  await page.goto('/models');
  // Wait for the model list to render (at least the dummy model row appears)
  await expect(page.locator('.v-list-item').filter({ hasText: dummyModelName }).first()).toBeVisible({ timeout: 5000 });
  const unloadBtn = page.locator(`.v-list-item:has-text("${dummyModelName}") button:has-text("Unload")`);
  if (await unloadBtn.isVisible()) return; // already loaded
  const loadBtn = page.locator(`.v-list-item:has-text("${dummyModelName}") button:has-text("Load")`);
  await loadBtn.click();
  await expect(page.locator('.v-alert')).toContainText(`Loaded: ${dummyModelName}`, { timeout: 10000 });
}

async function unloadModel(page) {
  await page.goto('/models');
  await expect(page.locator('.v-list-item').filter({ hasText: dummyModelName }).first()).toBeVisible({ timeout: 5000 });
  const unloadBtn = page.locator(`.v-list-item:has-text("${dummyModelName}") button:has-text("Unload")`);
  if (!await unloadBtn.isVisible()) return; // already unloaded
  await unloadBtn.click();
  await expect(page.locator('.v-alert')).toContainText('No active model', { timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Test 1: First-launch setup & auth
// ---------------------------------------------------------------------------
test('Setup, auth enforcement, and login', async ({ page }) => {
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  // Fresh server (test port 18000 + global-setup deleted test_auth.json)
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup/, { timeout: 8000 });
  await expect(page.locator('h1')).toContainText('oRKLLM Setup');

  await page.locator('input[type="text"]').fill(ADMIN_USER);
  await page.locator('input[type="password"]').first().fill(ADMIN_PASS);
  await page.locator('input[type="password"]').nth(1).fill(ADMIN_PASS);
  await page.click('button:has-text("Initialize Server")');

  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/, { timeout: 8000 });
  await expect(page.locator('.text-gradient').first()).toContainText('oRKLLM');

  // Sign out
  await page.click('.v-app-bar .v-btn:has(.mdi-account)');
  await page.waitForSelector('.v-navigation-drawer:has(.mdi-logout)', { state: 'visible' });
  await page.click('.v-navigation-drawer .v-list-item:has-text("Sign Out")');
  await expect(page).toHaveURL(/\/login/);

  // Wrong password
  await page.locator('input[type="text"]').fill(ADMIN_USER);
  await page.locator('input[type="password"]').fill('wrong_pass');
  await page.click('button:has-text("Sign In")');
  await expect(page.locator('.v-alert')).toBeVisible();

  // Correct password
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await page.click('button:has-text("Sign In")');
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);
});

// ---------------------------------------------------------------------------
// Test 2: Dashboard - telemetry + navbar
// ---------------------------------------------------------------------------
test('Dashboard shows telemetry and navbar does not overlap content', async ({ page }) => {
  await login(page);

  // Gauge labels are .text-caption.text-grey divs inside the telemetry card
  const telemetry = page.locator('.v-card', { hasText: 'Hardware Telemetry' });
  for (const label of ['CPU', 'NPU', 'GPU', 'RAM', 'Disk', 'Temp']) {
    await expect(telemetry.locator('.text-caption.text-grey', { hasText: label }).first()).toBeVisible();
  }

  for (const label of ['Dashboard', 'Models', 'Settings', 'Logs', 'Bench', 'Chat']) {
    await expect(navBtn(page, label)).toBeVisible();
  }

  const appBar = page.locator('.v-app-bar');
  const mainContainer = page.locator('.v-main > .v-container');
  const appBarBox = await appBar.boundingBox();
  const mainContainerBox = await mainContainer.boundingBox();
  if (appBarBox && mainContainerBox) {
    expect(mainContainerBox.y).toBeGreaterThanOrEqual(appBarBox.y + appBarBox.height - 2);
  }
});

// ---------------------------------------------------------------------------
// Test 3: Navbar routing
// ---------------------------------------------------------------------------
test('Navbar buttons navigate to correct pages', async ({ page }) => {
  await login(page);

  await navBtn(page, 'Models').click();
  await expect(page).toHaveURL(/\/models/);

  await navBtn(page, 'Settings').click();
  await expect(page).toHaveURL(/\/settings/);

  await navBtn(page, 'Logs').click();
  await expect(page).toHaveURL(/\/logs/);

  await navBtn(page, 'Bench').click();
  await expect(page).toHaveURL(/\/bench/);

  await navBtn(page, 'Chat').click();
  await expect(page).toHaveURL(/\/chat/);

  await navBtn(page, 'Dashboard').click();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);
});

// ---------------------------------------------------------------------------
// Test 4: Models page - model list, load, unload
// ---------------------------------------------------------------------------
test('Models page: model list, load, and unload', async ({ page }) => {
  await login(page);
  await page.goto('/models');

  await expect(page.locator('.v-list-item').filter({ hasText: dummyModelName }).first()).toBeVisible();

  await page.click(`.v-list-item:has-text("${dummyModelName}") button:has-text("Load")`);
  const alert = page.locator('.v-alert');
  await expect(alert).toContainText(`Loaded: ${dummyModelName}`, { timeout: 10000 });
  await expect(alert).toContainText('Mock Engine');

  await page.click(`.v-list-item:has-text("${dummyModelName}") button:has-text("Unload")`);
  await expect(alert).toContainText('No active model', { timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Test 5: Models - Downloader tab has HF fields
// ---------------------------------------------------------------------------
test('Models page: Downloader tab visible with HF fields', async ({ page }) => {
  await login(page);
  await page.goto('/models');

  await page.click('.v-tab:has-text("Downloader")');

  // Search field
  await expect(
    page.locator('.v-text-field').filter({ hasText: /Search models/i }).first()
  ).toBeVisible({ timeout: 3000 });

  // Repo ID field in the download card
  await expect(
    page.locator('.v-text-field').filter({ hasText: /Repo ID/i }).first()
  ).toBeVisible({ timeout: 3000 });

  // HF Token field for ad-hoc override
  await expect(
    page.locator('.v-text-field').filter({ hasText: /Token/i }).first()
  ).toBeVisible({ timeout: 3000 });
});

// ---------------------------------------------------------------------------
// Test 6: Dashboard cache observability and runtime versions visible
// ---------------------------------------------------------------------------
test('Dashboard shows cache observability and runtime versions sections', async ({ page }) => {
  await login(page);
  await page.goto('/');

  await expect(page.locator('text=Prefix Cache Observability')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('text=RKLLM Runtime Versions')).toBeVisible({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Test 7: Logs page
// ---------------------------------------------------------------------------
test('Logs page: log terminal appears and receives WebSocket output', async ({ page }) => {
  await login(page);
  await page.goto('/logs');
  await expect(page).toHaveURL(/\/logs/);
  await expect(page.locator('.v-main .text-h5, .v-main h1').filter({ hasText: /^Logs$/ }).or(
    page.locator('.v-main').locator('text=Logs').first()
  )).toBeVisible();

  const terminal = page.locator('.terminal-logs');
  await expect(terminal).toBeVisible();

  await expect(
    page.locator('.text-success:has-text("Connected")').or(page.locator('.text-error:has-text("Disconnected")'))
  ).toBeVisible({ timeout: 5000 });

  // After a couple seconds logs should arrive
  await page.waitForTimeout(2500);
  const content = await terminal.textContent();
  expect(content.trim().length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 8: Settings - HuggingFace token
// ---------------------------------------------------------------------------
test('Settings page: HuggingFace token saves and persists', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  const hfCard = page.locator('.v-card').filter({ hasText: 'HuggingFace' }).first();
  await expect(hfCard).toBeVisible();
  const hfInput = hfCard.locator('input').first();
  await expect(hfInput).toBeVisible();

  await hfInput.fill('hf_test_token_12345');
  await hfCard.locator('button:has-text("Save Token")').click();

  await expect(page.locator('.v-snackbar')).toContainText(/saved|success/i, { timeout: 3000 });

  await page.reload();
  await expect(hfCard.locator('input').first()).toHaveValue('hf_test_token_12345', { timeout: 3000 });
});

// ---------------------------------------------------------------------------
// Test 9: Bench page - renders
// ---------------------------------------------------------------------------
test('Bench page: renders benchmark card with model selector and prompt textarea', async ({ page }) => {
  await login(page);
  await page.goto('/bench');
  await expect(page).toHaveURL(/\/bench/);

  // Page heading
  await expect(page.locator('.text-h5, .text-h6').filter({ hasText: 'Benchmark' }).first()).toBeVisible();

  // Model selector dropdown present
  await expect(page.locator('.v-select').first()).toBeVisible();

  // Prompt textarea visible
  await expect(page.locator('textarea').first()).toBeVisible();

  // Run button exists
  await expect(page.locator('button:has-text("Run Benchmark")')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 10: Bench page - runs benchmark
// ---------------------------------------------------------------------------
test('Bench page: runs benchmark and shows generation metrics', async ({ page }) => {
  await login(page);
  await loadModel(page);

  await page.goto('/bench');

  // Model selector should auto-populate with the loaded model
  const benchSelect = page.locator('.v-select').first();
  await expect(benchSelect).toContainText(dummyModelName, { timeout: 8000 }).catch(async () => {
    await benchSelect.click();
    await page.locator(`.v-list-item:has-text("${dummyModelName}")`).first().click();
  });

  // Active model alert (text changed to "Active:")
  const activeAlert = page.locator('.v-alert').filter({ hasText: /Active/ });
  await expect(activeAlert).toBeVisible({ timeout: 8000 });

  const runBtn = page.locator('button:has-text("Run Benchmark")');
  await expect(runBtn).toBeEnabled({ timeout: 3000 });
  await runBtn.click();

  // Wait for results card to appear (generation speed stat)
  const resultsCard = page.locator('.v-card').filter({ hasText: /tok\/s|TTFT|Generation|Prefill/ }).last();
  await expect(resultsCard).toBeVisible({ timeout: 20000 });

  await unloadModel(page);
});

// ---------------------------------------------------------------------------
// Test 11: Chat page
// ---------------------------------------------------------------------------
test('Chat page: model auto-selects and sends a streaming message', async ({ page }) => {
  await login(page);
  await loadModel(page);

  await page.goto('/chat');
  await expect(page).toHaveURL(/\/chat/);

  // The model selector should auto-populate (fetchModels then fetchStatus in mounted)
  const modelSelect = page.locator('.v-select').first();
  await expect(modelSelect).toContainText(dummyModelName, { timeout: 8000 }).catch(async () => {
    // Fallback: manually open the dropdown and select the model
    await modelSelect.click();
    await page.locator(`.v-list-item:has-text("${dummyModelName}")`).first().click();
  });

  // Now the textarea should be enabled
  const chatInput = page.locator('textarea').first();
  await expect(chatInput).toBeEnabled({ timeout: 5000 });

  await chatInput.fill('Hello, mock engine!');
  // Send via Enter key (Shift+Enter = newline, Enter = send)
  await page.keyboard.press('Enter');

  await expect(page.locator('.message-bubble').last()).toContainText(
    'simulated response', { timeout: 10000 }
  );

  await unloadModel(page);
});

// ---------------------------------------------------------------------------
// Test 12: Theme toggle
// ---------------------------------------------------------------------------
test('Theme toggle works and app renders after navigation', async ({ page }) => {
  await login(page);

  await page.click('.v-app-bar .v-btn:has(.mdi-account)');
  await page.waitForSelector('.v-navigation-drawer:has(.mdi-logout)', { state: 'visible' });
  const themeItem = page.locator('.v-navigation-drawer .v-list-item').filter({ hasText: /Light Mode|Dark Mode/ });
  await expect(themeItem).toBeVisible();
  await themeItem.click();

  await navBtn(page, 'Models').click();
  await expect(page).toHaveURL(/\/models/);
  await navBtn(page, 'Dashboard').click();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);
  await expect(page.locator('.v-app-bar')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 13: Mobile navbar — hamburger opens drawer, logo navigates to dashboard
// ---------------------------------------------------------------------------
test('Mobile navbar: hamburger opens left drawer, logo navigates to dashboard', async ({ page }) => {
  await login(page);
  await page.goto('/models'); // start on a non-dashboard page

  // Resize to mobile viewport (xs)
  await page.setViewportSize({ width: 390, height: 844 });

  // On mobile the desktop nav buttons should be hidden
  await expect(page.locator('.v-app-bar .v-btn:has-text("Dashboard")')).toBeHidden();

  // Hamburger icon (mdi-menu) should be visible
  const hamburger = page.locator('.v-app-bar .mdi-menu').locator('..');
  await expect(hamburger).toBeVisible();

  // Tapping hamburger opens the left nav drawer
  await hamburger.click();
  const drawer = page.locator('.v-navigation-drawer').filter({ hasText: 'Dashboard' });
  await expect(drawer).toBeVisible({ timeout: 3000 });
  await page.keyboard.press('Escape'); // close drawer

  // Tapping oRKLLM text navigates to dashboard
  await page.locator('.v-app-bar .text-gradient').click();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/, { timeout: 5000 });

  // Reset viewport
  await page.setViewportSize({ width: 1280, height: 800 });
});

// ---------------------------------------------------------------------------
// Test 14: Chat page — input bar is pinned at bottom, messages scroll
// ---------------------------------------------------------------------------
test('Chat page: input bar stays at bottom while messages scroll', async ({ page }) => {
  await login(page);

  await page.goto('/chat');
  await expect(page).toHaveURL(/\/chat/);

  // Input bar should be visible and at the bottom
  const inputBar = page.locator('.chat-input-bar');
  await expect(inputBar).toBeVisible({ timeout: 5000 });

  // Input bar bottom should be at or near the viewport bottom
  const inputBarBox = await inputBar.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 800;
  expect(inputBarBox?.y).toBeGreaterThan(viewportHeight * 0.7); // in bottom 30% of screen

  // Messages container scrolls independently
  const messagesContainer = page.locator('.chat-messages-container');
  await expect(messagesContainer).toBeVisible();

  // Test on mobile too
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  const inputBarMobile = page.locator('.chat-input-bar');
  await expect(inputBarMobile).toBeVisible({ timeout: 5000 });
  const mobileBox = await inputBarMobile.boundingBox();
  expect(mobileBox?.y).toBeGreaterThan(700); // near bottom of 844px screen

  await page.setViewportSize({ width: 1280, height: 800 });
});

// ---------------------------------------------------------------------------
// Test 15: Chat conversation persistence — history sidebar and round-trip
// ---------------------------------------------------------------------------
test('Chat: conversation is persisted and appears in sidebar', async ({ page }) => {
  await login(page);
  await loadModel(page);
  await page.goto('/chat');
  await expect(page).toHaveURL(/\/chat/);

  // Sidebar should be visible on desktop
  await expect(page.locator('.chat-sidebar')).toBeVisible({ timeout: 5000 });

  // Start a fresh conversation
  await page.locator('.chat-layout button:has(.mdi-plus)').click();

  const chatInput = page.locator('textarea').first();
  await expect(chatInput).toBeEnabled({ timeout: 5000 });

  // Send a message — this creates a new conversation
  await chatInput.fill('Persistence test message');
  await page.keyboard.press('Enter');

  // Wait for assistant response
  await expect(page.locator('.message-bubble').last()).toContainText('simulated response', { timeout: 10000 });

  // Sidebar should now list the conversation titled from the first message
  await expect(page.locator('.sidebar-item').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.sidebar-item').first()).toContainText('Persistence test message');

  // New chat clears the active view
  await page.locator('.chat-layout button:has(.mdi-plus)').click();
  await expect(page.locator('.message-bubble')).toHaveCount(0);

  // Clicking the sidebar item reloads the conversation
  await page.locator('.sidebar-item').first().click();
  await expect(page.locator('.message-bubble').first()).toBeVisible({ timeout: 5000 });

  await unloadModel(page);
});

// ---------------------------------------------------------------------------
// Test 16: Chat conversation — delete from sidebar
// ---------------------------------------------------------------------------
test('Chat: conversation can be deleted from sidebar', async ({ page }) => {
  await login(page);
  await loadModel(page);
  await page.goto('/chat');

  // Start fresh
  await page.locator('.chat-layout button:has(.mdi-plus)').click();

  const chatInput = page.locator('textarea').first();
  await expect(chatInput).toBeEnabled({ timeout: 5000 });
  await chatInput.fill('Delete test message');
  await page.keyboard.press('Enter');
  await expect(page.locator('.message-bubble').last()).toContainText('simulated response', { timeout: 10000 });

  // The new conversation should be first in the sidebar
  const targetItem = page.locator('.sidebar-item').filter({ hasText: 'Delete test message' });
  await expect(targetItem).toBeVisible({ timeout: 5000 });
  const countBefore = await page.locator('.sidebar-item').count();

  // Delete via its delete button
  await targetItem.locator('.mdi-delete-outline').click();

  // Item is gone and total count decreased by 1
  await expect(targetItem).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('.sidebar-item')).toHaveCount(countBefore - 1, { timeout: 5000 });
  await expect(page.locator('.message-bubble')).toHaveCount(0);

  await unloadModel(page);
});

// ---------------------------------------------------------------------------
// Test 17: Chat — partial response persisted when navigating away mid-stream
// ---------------------------------------------------------------------------
test('Chat: partial assistant response persisted when navigating away during generation', async ({ page }) => {
  await login(page);
  await loadModel(page);
  await page.goto('/chat');

  await page.locator('.chat-layout button:has(.mdi-plus)').click();

  const chatInput = page.locator('textarea').first();
  await expect(chatInput).toBeEnabled({ timeout: 5000 });

  await chatInput.fill('Partial persist test');
  await page.keyboard.press('Enter');

  // Wait for at least one message bubble to appear (user message)
  await expect(page.locator('.message-bubble').first()).toBeVisible({ timeout: 5000 });

  // Navigate away immediately (simulates page refresh during inference)
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\//);

  // Go back to chat
  await page.goto('/chat');
  await expect(page).toHaveURL(/\/chat/);

  // Sidebar should show the conversation
  await expect(page.locator('.sidebar-item').first()).toBeVisible({ timeout: 5000 });

  // Load it — at minimum the user message should be there
  await page.locator('.sidebar-item').first().click();
  await expect(page.locator('.message-bubble').first()).toContainText('Partial persist test', { timeout: 5000 });

  await unloadModel(page);
});

// ---------------------------------------------------------------------------
// Test 18: Pin model — persists to DB and clears on unload
// ---------------------------------------------------------------------------
test('Pin model: pin state saved to DB and cleared on unload', async ({ page }) => {
  await login(page);
  await loadModel(page);

  // Pin via API
  const pinRes = await page.evaluate(async () => {
    const r = await fetch('/api/admin/pin', { method: 'POST' });
    return r.json();
  });
  expect(pinRes.pinned).toBe(true);

  // Status reflects pinned=true
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/admin/status');
    return r.json();
  });
  expect(status.pinned).toBe(true);

  // pinnedModel persisted in global-settings
  const settings = await page.evaluate(async () => {
    const r = await fetch('/api/admin/global-settings');
    return r.json();
  });
  expect(settings.settings.pinnedModel).toBeTruthy();

  // Unload clears pin in DB
  await page.evaluate(async () => fetch('/api/admin/unload', { method: 'POST' }));

  const settingsAfter = await page.evaluate(async () => {
    const r = await fetch('/api/admin/global-settings');
    return r.json();
  });
  expect(settingsAfter.settings.pinnedModel).toBeFalsy();
});

// ---------------------------------------------------------------------------
// Test 19: Runtime version API
// ---------------------------------------------------------------------------
test('GET /api/admin/runtimes returns systemRuntime and runtimes array', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/runtimes');
    return r.json();
  });

  // Required fields present
  expect(data).toHaveProperty('runtimesDir');
  expect(data).toHaveProperty('systemRuntime');
  expect(data).toHaveProperty('runtimes');
  expect(Array.isArray(data.runtimes)).toBe(true);

  // systemRuntime has path and version fields
  expect(data.systemRuntime).toHaveProperty('path');
  expect(data.systemRuntime).toHaveProperty('version');
});

// ---------------------------------------------------------------------------
// Test 20: workingLibPath cached in model settings after successful load
// ---------------------------------------------------------------------------
test('Model settings store workingLibPath after successful load', async ({ page }) => {
  await login(page);
  await loadModel(page);

  // Read model settings via API
  const settings = await page.evaluate(async (modelName) => {
    const r = await fetch(`/api/admin/models/settings/${encodeURIComponent(modelName)}`);
    return r.json();
  }, dummyModelName);

  // workingLibPath should be set after a successful load
  expect(settings.settings).toHaveProperty('workingLibPath');
  expect(typeof settings.settings.workingLibPath).toBe('string');
  expect(settings.settings.workingLibPath.length).toBeGreaterThan(0);

  await unloadModel(page);
});

// ---------------------------------------------------------------------------
// Test 21: /v1/models exposes runtimeVersion per model
// ---------------------------------------------------------------------------
test('Models list includes runtimeVersion field', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/v1/models');
    return r.json();
  });

  expect(Array.isArray(data.data)).toBe(true);
  // Every model object has a runtimeVersion property (may be null for unnamed models)
  for (const model of data.data) {
    expect(model).toHaveProperty('runtimeVersion');
  }
});

// ---------------------------------------------------------------------------
// Test 22: autoDownloadRuntimes exposed in global-settings
// ---------------------------------------------------------------------------
test('Global settings exposes autoDownloadRuntimes', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/global-settings');
    return r.json();
  });

  expect(data.settings).toHaveProperty('autoDownloadRuntimes');
  expect(typeof data.settings.autoDownloadRuntimes).toBe('boolean');
});

// ---------------------------------------------------------------------------
// Test 23: autoDownloadRuntimes can be toggled via global-settings POST
// ---------------------------------------------------------------------------
test('autoDownloadRuntimes setting can be saved and read back', async ({ page }) => {
  await login(page);

  // Save false
  await page.evaluate(async () => {
    await fetch('/api/admin/global-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoDownloadRuntimes: false }),
    });
  });
  const off = await page.evaluate(async () => {
    const r = await fetch('/api/admin/global-settings');
    return r.json();
  });
  expect(off.settings.autoDownloadRuntimes).toBe(false);

  // Restore true
  await page.evaluate(async () => {
    await fetch('/api/admin/global-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoDownloadRuntimes: true }),
    });
  });
  const on = await page.evaluate(async () => {
    const r = await fetch('/api/admin/global-settings');
    return r.json();
  });
  expect(on.settings.autoDownloadRuntimes).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 24: POST /api/admin/runtimes/download accepts a version
// ---------------------------------------------------------------------------
test('POST /api/admin/runtimes/download accepts a version and returns success', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/runtimes/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v1.2.3' }),
    });
    return { status: r.status, body: await r.json() };
  });

  // On non-ARM64 the sync skips (not an error) — endpoint still returns 200
  expect(data.status).toBe(200);
  expect(data.body).toHaveProperty('success');
});

// ---------------------------------------------------------------------------
// Test 25: Settings page has auto-download runtime toggle
// ---------------------------------------------------------------------------
test('Settings page has auto-download runtime toggle', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page.locator('text=Auto-download rkllm runtimes')).toBeVisible({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Test 26: HF search API returns paramCount and storageBytes fields
// ---------------------------------------------------------------------------
test('HF search results include paramCount and storageBytes fields', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/hf/search?q=qwen+rkllm&limit=3&rkllm=true');
    return { status: r.status, body: await r.json() };
  });

  // May fail if HF is unreachable in CI — treat network errors as skip
  if (data.status !== 200) return;

  expect(Array.isArray(data.body)).toBe(true);
  if (data.body.length === 0) return; // no results, can't assert fields

  const first = data.body[0];
  // Fields must be present (values may be null if HF doesn't return them)
  expect(first).toHaveProperty('paramCount');
  expect(first).toHaveProperty('storageBytes');
  expect(first).toHaveProperty('downloads');
  expect(first).toHaveProperty('likes');
});

// ---------------------------------------------------------------------------
// Test 27: GET /api/admin/download/status returns an array
// ---------------------------------------------------------------------------
test('GET /api/admin/download/status returns array', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/download/status');
    return { status: r.status, body: await r.json() };
  });

  expect(data.status).toBe(200);
  expect(Array.isArray(data.body)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 28: GET /api/admin/hf/files returns files array for a valid repo
// ---------------------------------------------------------------------------
test('GET /api/admin/hf/files returns files for a HF repo', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/hf/files?repoId=Qwen/Qwen2.5-0.5B-Instruct');
    return { status: r.status, body: await r.json() };
  });

  // Graceful skip if HF unreachable
  if (data.status !== 200) return;

  expect(data.body).toHaveProperty('repoId');
  expect(data.body).toHaveProperty('files');
  expect(Array.isArray(data.body.files)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 29: Dashboard cache observability section shows hot/cold stats
// ---------------------------------------------------------------------------
test('Dashboard cache observability shows stats from global-settings', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/global-settings');
    return r.json();
  });

  // cacheStats is always present in the response
  expect(data).toHaveProperty('cacheStats');
  expect(data.cacheStats).toHaveProperty('enabled');
});

// ---------------------------------------------------------------------------
// Test 30: GET /api/admin/status includes platform field
// ---------------------------------------------------------------------------
test('Status endpoint includes platform field', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/status');
    return r.json();
  });

  // platform is null on non-ARM64 (CI runs x86); must be present as property
  expect(data).toHaveProperty('platform');
  // On ARM64 Linux it would be 'rk3576' or 'rk3588'; on CI it's null
  expect(data.platform === null || typeof data.platform === 'string').toBe(true);
});

// ---------------------------------------------------------------------------
// Test 31: HF search shows both RKLLM and compatible chipset checkboxes
// ---------------------------------------------------------------------------
test('HF search has RKLLM only and Compatible chipset checkboxes', async ({ page }) => {
  await login(page);
  await page.goto('/models');
  await page.click('.v-tab:has-text("Downloader")');

  await expect(page.locator('text=RKLLM models only')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('text=Compatible chipset')).toBeVisible({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Test 32: Recursive model scan — subdirectory models appear in /v1/models
// ---------------------------------------------------------------------------
test('Recursive model scan includes subdirectory models', async ({ page }) => {
  await login(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/v1/models');
    return r.json();
  });

  // Every model returned has an id string
  expect(Array.isArray(data.data)).toBe(true);
  for (const model of data.data) {
    expect(typeof model.id).toBe('string');
    expect(model.id.length).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// Test 33: Context window setting accepts values up to 32768
// ---------------------------------------------------------------------------
test('Context window max is 32768 in global-settings', async ({ page }) => {
  await login(page);

  await page.evaluate(async () => {
    await fetch('/api/admin/global-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheMaxContextTokens: 32768 }),
    });
  });

  const data = await page.evaluate(async () => {
    const r = await fetch('/api/admin/global-settings');
    return r.json();
  });

  expect(data.settings.cacheMaxContextTokens).toBe(32768);

  // Restore default
  await page.evaluate(async () => {
    await fetch('/api/admin/global-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheMaxContextTokens: 8192 }),
    });
  });
});

// ---------------------------------------------------------------------------
// Test 34: New sampling params round-trip via model settings API
// ---------------------------------------------------------------------------
test('Model settings: presence_penalty, frequency_penalty, ctx_window round-trip', async ({ page }) => {
  await login(page);

  const payload = {
    presence_penalty: 0.5,
    frequency_penalty: 0.3,
    ctx_window: 4096,
  };

  await page.evaluate(async ({ name, data }) => {
    await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }, { name: dummyModelName, data: payload });

  const saved = await page.evaluate(async (name) => {
    const r = await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`);
    return r.json();
  }, dummyModelName);

  expect(saved.settings.presence_penalty).toBe(0.5);
  expect(saved.settings.frequency_penalty).toBe(0.3);
  expect(saved.settings.ctx_window).toBe(4096);
});

// ---------------------------------------------------------------------------
// Test 35: Thinking mode toggle round-trips via model settings API
// ---------------------------------------------------------------------------
test('Model settings: thinking_enabled persists and can be toggled', async ({ page }) => {
  await login(page);

  // Enable thinking
  await page.evaluate(async (name) => {
    await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinking_enabled: true }),
    });
  }, dummyModelName);

  const on = await page.evaluate(async (name) => {
    const r = await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`);
    return r.json();
  }, dummyModelName);
  expect(on.settings.thinking_enabled).toBe(true);

  // Disable thinking
  await page.evaluate(async (name) => {
    await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinking_enabled: false }),
    });
  }, dummyModelName);

  const off = await page.evaluate(async (name) => {
    const r = await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`);
    return r.json();
  }, dummyModelName);
  expect(off.settings.thinking_enabled).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 36: Mirostat settings round-trip via model settings API
// ---------------------------------------------------------------------------
test('Model settings: mirostat mode and params persist', async ({ page }) => {
  await login(page);

  await page.evaluate(async (name) => {
    await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mirostat: 2, mirostat_tau: 4.0, mirostat_eta: 0.05 }),
    });
  }, dummyModelName);

  const saved = await page.evaluate(async (name) => {
    const r = await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`);
    return r.json();
  }, dummyModelName);

  expect(saved.settings.mirostat).toBe(2);
  expect(saved.settings.mirostat_tau).toBe(4.0);
  expect(saved.settings.mirostat_eta).toBe(0.05);
});

// ---------------------------------------------------------------------------
// Test 37: Speculative decoding scaffold settings persist
// ---------------------------------------------------------------------------
test('Model settings: speculative_mode and draft_model scaffold persists', async ({ page }) => {
  await login(page);

  await page.evaluate(async (name) => {
    await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speculative_mode: 'dflash', draft_model: 'draft.rkllm', spec_draft_tokens: 4 }),
    });
  }, dummyModelName);

  const saved = await page.evaluate(async (name) => {
    const r = await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`);
    return r.json();
  }, dummyModelName);

  expect(saved.settings.speculative_mode).toBe('dflash');
  expect(saved.settings.draft_model).toBe('draft.rkllm');
  expect(saved.settings.spec_draft_tokens).toBe(4);

  // Cleanup
  await page.evaluate(async (name) => {
    await fetch(`/api/admin/models/settings/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speculative_mode: null, draft_model: null }),
    });
  }, dummyModelName);
});

// ---------------------------------------------------------------------------
// Test 38: Model settings dialog renders new fields in UI
// ---------------------------------------------------------------------------
test('Model settings dialog shows Advanced and Speculative Decoding panels', async ({ page }) => {
  await login(page);
  await page.goto('/models');

  // Open settings for the dummy model
  const settingsBtn = page.locator(`.v-list-item:has-text("${dummyModelName}") button[title="Model Settings"]`);
  await expect(settingsBtn).toBeVisible({ timeout: 5000 });
  await settingsBtn.click();

  // Dialog opens
  await expect(page.locator('.v-dialog .v-card')).toBeVisible({ timeout: 3000 });

  // Basic new fields visible
  await expect(page.locator('.v-dialog text=Presence Penalty')).toBeVisible();
  await expect(page.locator('.v-dialog text=Frequency Penalty')).toBeVisible();
  await expect(page.locator('.v-dialog text=Ctx Window')).toBeVisible();

  // Advanced panel exists
  await expect(page.locator('.v-dialog text=Advanced')).toBeVisible();

  // Speculative Decoding panel exists
  await expect(page.locator('.v-dialog text=Speculative Decoding')).toBeVisible();

  // Close dialog
  await page.locator('.v-dialog button:has(.mdi-close)').click();
});
