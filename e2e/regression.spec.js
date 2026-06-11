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
  const versionText = page.locator('.v-app-bar span.d-none.d-sm-flex');
  await expect(versionText).toBeVisible();
  const text = await versionText.textContent();
  expect(text).toMatch(/^v\d+\.\d+/);
});

test('Navbar: version shown in user drawer on mobile', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Version text hidden in navbar on mobile
  const navVersion = page.locator('.v-app-bar span.d-none.d-sm-flex');
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

  // Wait for the streamed mock response to complete.
  await expect(page.locator('.message-bubble').last()).toContainText('simulated response', { timeout: 10000 });
  await expect(page.locator('.message-bubble').filter({ hasText: 'Persistence check 123' })).toBeVisible();

  // Navigate away (Dashboard) then back to Chat via SPA router links.
  await navBtn(page, 'Dashboard').click();
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/);
  await navBtn(page, 'Chat').click();
  await expect(page).toHaveURL(/\/chat/);

  // Previously chatHistory lived in component data() and was reset on remount
  // (the active conversation was not reopened); the shared store keeps it.
  await expect(page.locator('.message-bubble').filter({ hasText: 'Persistence check 123' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.message-bubble').last()).toContainText('simulated response');
});
