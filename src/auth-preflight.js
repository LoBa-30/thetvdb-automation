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
  initialUrl: null,
  finalUrl: null,
  finalTitle: null,
  logoutControlFound: false,
  loginFormStillVisible: false,
  credentialsFilled: { email: false, password: false },
  sessionProbe: {
    url: 'https://thetvdb.com/auth/getuser',
    status: null,
    ok: false,
    contentType: null,
    bodyLooksAuthenticated: false,
    bodyPreview: null
  },
  form: {
    action: null,
    method: null,
    fields: [],
    submitText: null
  },
  submissionResponses: [],
  visibleMessages: [],
  protectionSignals: [],
  notes: []
};

if (!username || !password) {
  result.notes.push('Missing TVDB_USERNAME or TVDB_PASSWORD GitHub Actions secret.');
  await fs.writeFile('reports/auth-preflight.json', JSON.stringify(result, null, 2));
  console.log('Authentication preflight blocked: missing GitHub secrets.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
});
const page = await context.newPage();

const interestingResponse = response => /thetvdb\.com\/(auth|login|account|user|profile)/i.test(response.url());
page.on('response', response => {
  if (!interestingResponse(response)) return;
  const entry = {
    url: response.url(),
    status: response.status(),
    method: response.request().method()
  };
  if (!result.submissionResponses.some(x => x.url === entry.url && x.status === entry.status && x.method === entry.method)) {
    result.submissionResponses.push(entry);
  }
});

try {
  await page.goto('https://thetvdb.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  result.initialUrl = page.url();
  result.loginPageFound = /\/auth\/login(?:[/?#]|$)|\/login(?:[/?#]|$)/i.test(result.initialUrl);

  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first();
  if (await form.count()) {
    result.form.action = await form.getAttribute('action').catch(() => null);
    result.form.method = await form.getAttribute('method').catch(() => null);
    result.form.fields = await form.locator('input').evaluateAll(inputs => inputs.map(input => ({
      type: input.getAttribute('type') || 'text',
      name: input.getAttribute('name'),
      id: input.getAttribute('id'),
      autocomplete: input.getAttribute('autocomplete'),
      required: input.required
    })));
  }

  const userField = page.locator('form input[name="email"]').first();
  const passwordField = page.locator('form input[name="password"]').first();

  const userVisible = await userField.isVisible().catch(() => false);
  const passVisible = await passwordField.isVisible().catch(() => false);

  if (!userVisible || !passVisible) {
    result.notes.push('Exact TheTVDB email/password fields could not be identified safely.');
  } else {
    await userField.fill(username);
    await passwordField.fill(password);

    result.credentialsFilled.email = (await userField.inputValue().catch(() => '')).length > 0;
    result.credentialsFilled.password = (await passwordField.inputValue().catch(() => '')).length > 0;

    if (!result.credentialsFilled.email || !result.credentialsFilled.password) {
      result.notes.push('One or both credential fields remained empty after fill; submission blocked.');
    } else {
      const submit = form.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign In")').first();
      if (await submit.isVisible().catch(() => false)) {
        result.form.submitText = ((await submit.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim() || await submit.getAttribute('value').catch(() => null);
        await Promise.all([
          page.waitForLoadState('domcontentloaded').catch(() => {}),
          submit.click()
        ]);
        result.loginSubmitted = true;
        await page.waitForTimeout(2500);
      } else {
        result.notes.push('Submit button could not be identified safely inside the login form.');
      }
    }
  }

  result.finalUrl = page.url();
  result.finalTitle = await page.title();

  const messageSelectors = [
    '[role="alert"]', '.alert', '.alert-danger', '.alert-error', '.error', '.errors',
    '.invalid-feedback', '.help-block', 'form .text-danger', 'form .text-red-500'
  ];
  for (const selector of messageSelectors) {
    const texts = await page.locator(selector).evaluateAll(nodes => nodes
      .filter(node => {
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 10)).catch(() => []);
    for (const text of texts) {
      if (!result.visibleMessages.includes(text)) result.visibleMessages.push(text);
    }
  }

  const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
  const protectionChecks = [
    ['captcha', /captcha|recaptcha|hcaptcha/],
    ['cloudflare', /cloudflare|checking your browser|verify you are human|attention required/],
    ['rate-limit', /too many requests|rate limit|try again later/],
    ['two-factor', /two-factor|2fa|verification code|one-time code|authenticator/]
  ];
  for (const [name, pattern] of protectionChecks) {
    if (pattern.test(bodyText)) result.protectionSignals.push(name);
  }

  const captchaSelectors = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '[class*="captcha" i]',
    '[id*="captcha" i]', 'input[name*="captcha" i]', '[data-sitekey]'
  ];
  for (const selector of captchaSelectors) {
    if (await page.locator(selector).count().catch(() => 0)) {
      if (!result.protectionSignals.includes('captcha-dom')) result.protectionSignals.push('captcha-dom');
    }
  }

  const logoutSelectors = [
    'a:has-text("Logout")', 'button:has-text("Logout")', 'a:has-text("Log out")',
    'button:has-text("Log out")', 'a:has-text("Sign out")', 'button:has-text("Sign out")',
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

  // Session proof: query TheTVDB's own user endpoint with the same browser context/cookies.
  const sessionResponse = await context.request.get(result.sessionProbe.url, { timeout: 30000 }).catch(() => null);
  if (sessionResponse) {
    result.sessionProbe.status = sessionResponse.status();
    result.sessionProbe.ok = sessionResponse.ok();
    result.sessionProbe.contentType = sessionResponse.headers()['content-type'] || null;
    const raw = await sessionResponse.text().catch(() => '');
    const compact = raw.replace(/\s+/g, ' ').trim();
    result.sessionProbe.bodyPreview = compact.slice(0, 180);

    // Treat as authenticated only if endpoint is successful and returns a non-empty user-like payload.
    // Do not require a specific username or expose account details.
    const looksJson = /application\/json/i.test(result.sessionProbe.contentType || '') || /^[\[{]/.test(compact);
    const notGuestLike = !/\b(null|false|guest|unauthenticated|not authenticated|login required)\b/i.test(compact);
    result.sessionProbe.bodyLooksAuthenticated = Boolean(result.sessionProbe.ok && looksJson && compact && notGuestLike);
  }

  const urlStillLogin = /\/auth\/login(?:[/?#]|$)|\/login(?:[/?#]|$)/i.test(result.finalUrl || '');

  result.authenticated = Boolean(
    result.loginSubmitted &&
    !urlStillLogin &&
    !result.loginFormStillVisible &&
    (result.sessionProbe.bodyLooksAuthenticated || result.logoutControlFound)
  );

  if (!result.authenticated) {
    result.notes.push('Strict authentication proof not established. No edit action was attempted.');
    if (urlStillLogin) result.notes.push('Browser remained on a login URL after submission.');
    if (result.loginFormStillVisible) result.notes.push('Login form is still visible after submission.');
    if (!result.sessionProbe.bodyLooksAuthenticated) result.notes.push('The authenticated-user session probe did not return a reliable user payload.');
    if (result.visibleMessages.length) result.notes.push('Visible login feedback was captured in visibleMessages.');
    if (result.protectionSignals.length) result.notes.push('Possible protection/challenge signals were detected.');
  } else {
    result.notes.push('Strict authentication proof established through TheTVDB session state. This preflight intentionally performs no edit action.');
  }
} catch (error) {
  result.notes.push(error?.message || String(error));
} finally {
  await browser.close();
}

await fs.writeFile('reports/auth-preflight.json', JSON.stringify(result, null, 2));
console.log(`Authenticated: ${result.authenticated}`);
console.log(`Initial URL: ${result.initialUrl || 'n/a'}`);
console.log(`Final URL: ${result.finalUrl || 'n/a'}`);
console.log(`Form: ${(result.form.method || 'n/a').toUpperCase()} ${result.form.action || 'n/a'}`);
console.log(`Fields: ${result.form.fields.map(f => `${f.type}:${f.name || f.id || '(unnamed)'}`).join(', ') || 'none'}`);
console.log(`Credential fields filled: email=${result.credentialsFilled.email}, password=${result.credentialsFilled.password}`);
console.log(`Session probe: status=${result.sessionProbe.status ?? 'n/a'}, ok=${result.sessionProbe.ok}, userPayload=${result.sessionProbe.bodyLooksAuthenticated}`);
console.log(`Responses: ${result.submissionResponses.map(r => `${r.method} ${r.status} ${r.url}`).join(' | ') || 'none'}`);
console.log(`Visible messages: ${result.visibleMessages.join(' | ') || 'none'}`);
console.log(`Protection signals: ${result.protectionSignals.join(', ') || 'none'}`);
console.log(`Logout control found: ${result.logoutControlFound}`);
console.log(`Login form still visible: ${result.loginFormStillVisible}`);
console.log(result.notes.join('\n'));

if (!result.authenticated) process.exitCode = 2;
