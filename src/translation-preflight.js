import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const BASE = 'https://thetvdb.com';

const TARGETS = [
  { target: 'Djilsi teaser', slug: 'djilsi', publicId: '12014131' },
  { target: 'Raska S2017E03', slug: 'raska', publicId: '11960839' },
  { target: 'Joyca S2026E07', slug: '335805-show', publicId: '11719791' },
  { target: 'Mcfly & Carlito S2022E09', slug: '338282-show', publicId: '9381309' }
];

await fs.mkdir('reports', { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'TRANSLATION_PREFLIGHT_READ_ONLY',
  authenticated: false,
  writeRequestsDetected: 0,
  targets: [],
  unresolved: [],
  ok: false
};

if (!username || !password) {
  report.unresolved.push({ target: 'GLOBAL', reason: 'Missing TVDB credentials.' });
  await fs.writeFile('reports/translation-preflight.json', JSON.stringify(report, null, 2));
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
});
const page = await context.newPage();
let loginComplete = false;

context.on('request', request => {
  if (!loginComplete) return;
  if (request.method() === 'POST' && /thetvdb\.com\/(series|movies|people)\//i.test(request.url())) {
    report.writeRequestsDetected += 1;
  }
});

async function goto(url) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    last = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (last && last.status() < 400) {
      await page.waitForTimeout(600);
      return last;
    }
    await page.waitForTimeout(800 * attempt);
  }
  throw new Error(`GET failed: ${url} (${last?.status() ?? 'n/a'})`);
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
  if (!probe?.ok()) return false;
  const text = await probe.text().catch(() => '');
  try {
    const payload = JSON.parse(text);
    return Boolean(payload && typeof payload === 'object' && Object.keys(payload).length);
  } catch {
    return false;
  }
}

async function collectForms() {
  return page.locator('form').evaluateAll(forms => forms.map((form, index) => ({
    index,
    action: form.getAttribute('action'),
    method: (form.getAttribute('method') || 'GET').toUpperCase(),
    fields: [...form.querySelectorAll('input, textarea, select')].map(node => {
      const name = node.getAttribute('name');
      let value = '';
      if (node.tagName === 'SELECT') value = [...node.selectedOptions].map(o => o.value).join('|');
      else if (node.type === 'checkbox' || node.type === 'radio') value = node.checked ? node.value : '';
      else value = node.value || '';
      return {
        tag: node.tagName.toLowerCase(),
        type: node.type || '',
        name,
        id: node.id || null,
        value,
        visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
      };
    }).filter(x => x.name),
    submitControls: [...form.querySelectorAll('button, input[type="submit"], a')].map(node => ({
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute('type'),
      text: (node.textContent || node.value || '').replace(/\s+/g, ' ').trim(),
      href: node.href || null,
      name: node.getAttribute('name'),
      value: node.getAttribute('value')
    })).filter(x => /save|submit|translation|update|change/i.test(`${x.text} ${x.name || ''} ${x.value || ''} ${x.href || ''}`))
  })));
}

async function collectTranslationLinks() {
  return page.locator('a').evaluateAll(anchors => anchors.map(a => ({
    text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
    href: a.href || '',
    title: a.getAttribute('title'),
    ariaLabel: a.getAttribute('aria-label')
  })).filter(x => /translation/i.test(`${x.text} ${x.href} ${x.title || ''} ${x.ariaLabel || ''}`)));
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session could not be proven.');
  loginComplete = true;

  for (const def of TARGETS) {
    const episodeUrl = `${BASE}/series/${def.slug}/episodes/${def.publicId}`;
    await goto(episodeUrl);
    const links = await collectTranslationLinks();
    const title = await page.locator('h1').first().innerText().catch(() => null);
    const item = {
      ...def,
      episodeUrl,
      currentTitle: title?.replace(/\s+/g, ' ').trim() || null,
      translationLinks: links,
      translationPages: []
    };

    const unique = [...new Set(links.map(x => x.href).filter(href => href.startsWith(BASE)))];
    for (const url of unique) {
      await goto(url);
      item.translationPages.push({
        requestedUrl: url,
        finalUrl: page.url(),
        pageTitle: await page.title().catch(() => null),
        h1: await page.locator('h1').first().innerText().catch(() => null),
        forms: await collectForms(),
        links: await collectTranslationLinks()
      });
    }

    if (!unique.length) {
      report.unresolved.push({ target: def.target, reason: 'No Edit Translations link discovered on authenticated episode page.' });
    }
    report.targets.push(item);
  }

  report.ok = report.authenticated && report.writeRequestsDetected === 0 && report.unresolved.length === 0;
} catch (error) {
  report.unresolved.push({ target: 'GLOBAL', reason: error?.stack || error?.message || String(error) });
} finally {
  await browser.close();
}

await fs.writeFile('reports/translation-preflight.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Write requests detected: ${report.writeRequestsDetected}`,
  `Targets: ${report.targets.length}`,
  `Unresolved: ${report.unresolved.length}`,
  `OK: ${report.ok}`,
  ''
];
for (const t of report.targets) {
  lines.push(`TARGET | ${t.target} | TVDB ${t.publicId} | title=${t.currentTitle || '?'}`);
  for (const l of t.translationLinks) lines.push(`  LINK | ${l.text || '(no text)'} | ${l.href}`);
  for (const p of t.translationPages) {
    lines.push(`  PAGE | ${p.finalUrl}`);
    for (const f of p.forms) {
      lines.push(`    FORM | ${f.method} | ${f.action}`);
      for (const field of f.fields.filter(x => /name|title|overview|language|lang|translation/i.test(x.name || ''))) {
        lines.push(`      FIELD | ${field.tag}/${field.type} | ${field.name} | value=${field.value}`);
      }
    }
  }
}
for (const x of report.unresolved) lines.push(`UNRESOLVED | ${x.target} | ${x.reason}`);
await fs.writeFile('reports/translation-preflight.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (!report.ok) process.exitCode = 2;
