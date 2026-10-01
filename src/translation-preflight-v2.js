import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const BASE = 'https://thetvdb.com';
const lock = JSON.parse(await fs.readFile('config/apply-all-locks.json', 'utf8'));
const TARGETS = lock.episodeEdits
  .filter(item => item.desiredTitle != null)
  .map(item => ({
    target: `${item.target} S${item.season}E${String(item.episode).padStart(2, '0')}`,
    slug: item.slug,
    publicId: String(item.publicId),
    desiredTitle: item.desiredTitle
  }));

await fs.mkdir('reports', { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  mode: 'TRANSLATION_DIRECT_FRA_PREFLIGHT_READ_ONLY',
  authenticated: false,
  blockedPosts: [],
  targets: [],
  unresolved: [],
  ok: false
};

if (!username || !password) {
  report.unresolved.push({ target: 'GLOBAL', reason: 'Missing credentials' });
  await fs.writeFile('reports/translation-preflight-v2.json', JSON.stringify(report, null, 2));
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
});
const page = await context.newPage();

async function goto(url) {
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    last = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (last && last.status() < 400) {
      await page.waitForTimeout(700);
      return last;
    }
    await page.waitForTimeout(800 * attempt);
  }
  throw new Error(`GET failed ${url} (${last?.status() ?? 'n/a'})`);
}

async function login() {
  await goto(`${BASE}/auth/login`);
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  const email = form.locator('input[name="email"]').first();
  const pass = form.locator('input[name="password"]').first();
  const submit = form.locator('button[type="submit"], input[type="submit"]').first();
  if (!(await email.isVisible().catch(() => false)) || !(await pass.isVisible().catch(() => false)) || !(await submit.isVisible().catch(() => false))) return false;
  await email.fill(username);
  await pass.fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(900);
  const probe = await context.request.get(`${BASE}/auth/getuser`).catch(() => null);
  return Boolean(probe?.ok());
}

async function inspectTranslation(def) {
  const url = `${BASE}/series/${def.slug}/episodes/${def.publicId}/translate/fra/0/single`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="episode_name"]') }).first();
  if (!(await form.count())) throw new Error('French translation form not found');
  const action = await form.getAttribute('action');
  const method = ((await form.getAttribute('method')) || 'GET').toUpperCase();
  const fields = await form.locator('input, textarea, select').evaluateAll(nodes => nodes.map(node => {
    const name = node.getAttribute('name');
    if (!name) return null;
    let value = '';
    if (node.tagName === 'SELECT') value = [...node.selectedOptions].map(o => o.value).join('|');
    else if (node.type === 'checkbox' || node.type === 'radio') value = node.checked ? node.value : '';
    else value = node.value || '';
    return { tag: node.tagName.toLowerCase(), type: node.type || '', name, value };
  }).filter(Boolean));
  const byName = Object.fromEntries(fields.map(f => [f.name, f.value]));
  if (method !== 'POST') throw new Error(`Unexpected method ${method}`);
  if (action !== '/episodes/translatestore') throw new Error(`Unexpected action ${action}`);
  if (byName.language !== 'fra') throw new Error(`Unexpected language ${byName.language || '(missing)'}`);
  if (!Object.hasOwn(byName, 'episode_name')) throw new Error('episode_name field missing');
  return {
    url,
    finalUrl: page.url(),
    action,
    method,
    currentTitle: byName.episode_name,
    episodeLanguage: byName.episode_language || null,
    language: byName.language,
    hasOverview: Object.hasOwn(byName, 'episode_overview'),
    fieldNames: fields.map(f => f.name)
  };
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session not proven');

  // Hard read-only gate after login: no POST to TheTVDB may leave the browser.
  await context.route('**/*', async route => {
    const req = route.request();
    if (req.method() === 'POST' && req.url().startsWith(BASE)) {
      report.blockedPosts.push({ url: req.url(), resourceType: req.resourceType() });
      await route.abort();
      return;
    }
    await route.continue();
  });

  for (const def of TARGETS) {
    try {
      const detail = await inspectTranslation(def);
      report.targets.push({ ...def, ...detail, ready: true });
    } catch (error) {
      const reason = error?.message || String(error);
      report.targets.push({ ...def, ready: false, error: reason });
      report.unresolved.push({ target: def.target, publicId: def.publicId, reason });
    }
  }

  report.ok = report.authenticated
    && report.blockedPosts.length === 0
    && report.unresolved.length === 0
    && report.targets.length === TARGETS.length;
} catch (error) {
  report.unresolved.push({ target: 'GLOBAL', reason: error?.stack || error?.message || String(error) });
} finally {
  await browser.close();
}

await fs.writeFile('reports/translation-preflight-v2.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Blocked POSTs: ${report.blockedPosts.length}`,
  `Targets expected: ${TARGETS.length}`,
  `Targets inspected: ${report.targets.length}`,
  `Unresolved: ${report.unresolved.length}`,
  `OK: ${report.ok}`,
  ''
];
for (const t of report.targets) {
  if (!t.ready) {
    lines.push(`TARGET | ${t.target} | TVDB ${t.publicId} | ERROR=${t.error}`);
    continue;
  }
  lines.push(`TARGET | ${t.target} | TVDB ${t.publicId} | action=${t.action} | language=${t.language}`);
  lines.push(`  CURRENT TITLE | ${t.currentTitle}`);
  lines.push(`  DESIRED TITLE | ${t.desiredTitle}`);
  lines.push(`  FIELDS | ${t.fieldNames.join(', ')}`);
}
for (const x of report.unresolved) lines.push(`UNRESOLVED | ${x.target} | ${x.reason}`);
await fs.writeFile('reports/translation-preflight-v2.txt', lines.join('\n'));
console.log(lines.join('\n'));
if (!report.ok) process.exitCode = 2;
