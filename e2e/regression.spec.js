import { test, expect } from '@playwright/test';

const ADMIN_USER = process.env.ORKLLM_TEST_ADMIN_USER;
const ADMIN_PASS = process.env.ORKLLM_TEST_ADMIN_PASS;
if (!ADMIN_USER || !ADMIN_PASS) {
  throw new Error('ORKLLM_TEST_ADMIN_USER and ORKLLM_TEST_ADMIN_PASS must be set.');
}

async function login(page) {
  await page.goto('/login');
  await page.locator('input[type="text"]').fill(ADMIN_USER);
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await page.click('button:has-text("Sign In")');
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/, { timeout: 8000 });
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

test('Navbar: version chip is visible on desktop', async ({ page }) => {
  await login(page);
  const chip = page.locator('.v-app-bar .v-chip');
  await expect(chip).toBeVisible();
  const text = await chip.textContent();
  expect(text).toMatch(/^v\d+\.\d+/);
});

test('Navbar: version shown in user drawer on mobile', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Version chip hidden in navbar on mobile
  const navChip = page.locator('.v-app-bar .v-chip');
  await expect(navChip).toBeHidden();
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
