import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;

await fs.mkdir('reports', { recursive: true });

const result = {
  generatedAt: new Date().toISOString(),
  mode: 'AUTH_PREFLIGHT_NO_EDITS',
  authenticated: false,
  loginPageFound: false,
  loginSubmitted: false,
  finalUrl: null,
  finalTitle: null,
  logoutControlFound: false,
  loginFormStillVisible: false,
  notes: []
};

if (!username || !password) {
  result.notes.push('Missing TVDB_USERNAME or TVDB_PASSWORD GitHub Actions secret.');
  await fs.writeFile('reports/auth-preflight.json', JSON.stringify(result, null, 2));
  console.log('Authentication preflight blocked: missing GitHub secrets.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'fr-FR' });
const page = await context.newPage();

try {
  await page.goto('https://thetvdb.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  const loginLinkSelectors = [
    'a:has-text("Login")',
    'a:has-text("Sign In")',
    'a:has-text("Log In")',
    'a[href*="login"]',
    'a[href*="signin"]'
  ];

  let openedLogin = false;
  for (const selector of loginLinkSelectors) {
    const link = page.locator(selector).first();
    if (await link.isVisible().catch(() => false)) {
      await link.click();
      openedLogin = true;
      break;
    }
  }

  if (!openedLogin) {
    for (const url of ['https://thetvdb.com/auth/login', 'https://thetvdb.com/login']) {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      if (response && response.status() < 400) {
        openedLogin = true;
        break;
      }
    }
  }

  await page.waitForTimeout(1200);
  result.loginPageFound = openedLogin;

  const userField = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[type="text"]').first();
  const passwordField = page.locator('input[type="password"]').first();

  if (!(await userField.isVisible().catch(() => false)) || !(await passwordField.isVisible().catch(() => false))) {
    result.notes.push('Login form fields could not be identified safely.');
  } else {
    await userField.fill(username);
    await passwordField.fill(password);

    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign In")').first();
    if (await submit.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        submit.click()
      ]);
      result.loginSubmitted = true;
      await page.waitForTimeout(2500);
    } else {
      result.notes.push('Submit button could not be identified safely.');
    }
  }

  result.finalUrl = page.url();
  result.finalTitle = await page.title();

  const logoutSelectors = [
    'a:has-text("Logout")',
    'button:has-text("Logout")',
    'a:has-text("Log out")',
    'button:has-text("Log out")',
    'a:has-text("Sign out")',
    'button:has-text("Sign out")',
    'a[href*="logout"]'
  ];

  for (const selector of logoutSelectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      result.logoutControlFound = true;
      break;
    }
  }

  result.loginFormStillVisible =
    (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) ||
    (await page.locator('form').filter({ has: page.locator('input[type="password"]') }).first().isVisible().catch(() => false));

  const urlStillLogin = /\/auth\/login(?:[/?#]|$)|\/login(?:[/?#]|$)/i.test(result.finalUrl || '');

  result.authenticated = Boolean(
    result.loginSubmitted &&
    !urlStillLogin &&
    !result.loginFormStillVisible &&
    result.logoutControlFound
  );

  if (!result.authenticated) {
    result.notes.push('Strict authentication proof not established. No edit action was attempted.');
    if (urlStillLogin) result.notes.push('Browser remained on a login URL after submission.');
    if (result.loginFormStillVisible) result.notes.push('Login form is still visible after submission.');
    if (!result.logoutControlFound) result.notes.push('No visible logout/sign-out control was found.');
  } else {
    result.notes.push('Strict authentication proof established. This preflight intentionally performs no edit action.');
  }
} catch (error) {
  result.notes.push(error?.message || String(error));
} finally {
  await browser.close();
}

await fs.writeFile('reports/auth-preflight.json', JSON.stringify(result, null, 2));
console.log(`Authenticated: ${result.authenticated}`);
console.log(`Final URL: ${result.finalUrl || 'n/a'}`);
console.log(`Logout control found: ${result.logoutControlFound}`);
console.log(`Login form still visible: ${result.loginFormStillVisible}`);
console.log(result.notes.join('\n'));

if (!result.authenticated) process.exitCode = 2;
