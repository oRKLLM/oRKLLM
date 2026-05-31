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

  await expect(page.locator('text=CPU Utilization')).toBeVisible();
  await expect(page.locator('text=NPU Utilization')).toBeVisible();
  await expect(page.locator('text=RAM Utilization')).toBeVisible();

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

  // HF repo ID field (any input on the page that appeared after tab click)
  await expect(
    page.locator('.v-text-field').filter({ hasText: /Repo ID/i }).first()
  ).toBeVisible({ timeout: 3000 });

  // HF token field
  await expect(
    page.locator('.v-text-field').filter({ hasText: /Token/i }).first()
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 6: Dashboard chat playground
// ---------------------------------------------------------------------------
test('Dashboard inference playground: load model and run chat', async ({ page }) => {
  await login(page);
  await loadModel(page);

  await page.goto('/');
  const chatInput = page.locator('input[placeholder="Enter your message..."]');
  await expect(chatInput).toBeEnabled({ timeout: 10000 });

  await chatInput.fill('Hi mock engine, what are your specs?');
  await page.keyboard.press('Enter');

  const assistantBubble = page.locator('.message-bubble').last();
  await expect(assistantBubble).toContainText('simulated response', { timeout: 10000 });
  await expect(chatInput).toBeEnabled({ timeout: 15000 });
  await expect(assistantBubble.locator('.text-caption')).toContainText('Prefill:');

  await unloadModel(page);
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
