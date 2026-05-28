import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/login');
  await page.locator('input[type="text"]').fill('admin_test');
  await page.locator('input[type="password"]').fill('secret123');
  await page.click('button:has-text("Sign In")');
  await expect(page).toHaveURL(/http:\/\/127.0.0.1:18000\/?$/, { timeout: 8000 });
}

function accountBtn(page) {
  return page.locator('.v-app-bar .v-btn:has(.mdi-account)');
}

function drawer(page) {
  return page.locator('.v-navigation-drawer');
}

test('Navbar: shows oRKLLM brand without Console suffix', async ({ page }) => {
  await login(page);
  const brand = page.locator('.text-gradient');
  await expect(brand).toBeVisible();
  await expect(brand).toContainText('oRKLLM');
  await expect(brand).not.toContainText('Console');
});

test('Navbar: version chip is visible', async ({ page }) => {
  await login(page);
  const chip = page.locator('.v-app-bar .v-chip');
  await expect(chip).toBeVisible();
  const text = await chip.textContent();
  expect(text).toMatch(/^v\d+\.\d+\.\d+$/);
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
  await expect(d.locator('text=admin_test')).toBeVisible();
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
