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
  mode: 'TRANSLATION_MODAL_PREFLIGHT_READ_ONLY',
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
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();

async function goto(url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (!response || response.status() >= 400) throw new Error(`GET failed ${url} (${response?.status() ?? 'n/a'})`);
  await page.waitForTimeout(700);
}

async function login() {
  await goto(`${BASE}/auth/login`);
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  const email = form.locator('input[name="email"]').first();
  const pass = form.locator('input[name="password"]').first();
  const submit = form.locator('button[type="submit"], input[type="submit"]').first();
  if (!(await email.isVisible().catch(() => false)) || !(await pass.isVisible().catch(() => false))) return false;
  await email.fill(username);
  await pass.fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  const probe = await context.request.get(`${BASE}/auth/getuser`).catch(() => null);
  return Boolean(probe?.ok());
}

function safeHref(value, base) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw === '#' || raw.startsWith('#') || /^javascript:/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    if (u.origin !== new URL(BASE).origin) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

async function captureForms() {
  return page.locator('form').evaluateAll(forms => forms.map((form, index) => ({
    index,
    action: form.getAttribute('action'),
    method: (form.getAttribute('method') || 'GET').toUpperCase(),
    visible: Boolean(form.offsetWidth || form.offsetHeight || form.getClientRects().length),
    fields: [...form.querySelectorAll('input, textarea, select')].map(node => ({
      tag: node.tagName.toLowerCase(),
      type: node.type || '',
      name: node.getAttribute('name'),
      id: node.id || null,
      value: node.tagName === 'SELECT' ? [...node.selectedOptions].map(o => o.value).join('|') : (node.value || ''),
      visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
    })).filter(x => x.name),
    buttons: [...form.querySelectorAll('button, input[type="submit"]')].map(node => ({
      text: (node.textContent || node.value || '').replace(/\s+/g, ' ').trim(),
      type: node.getAttribute('type')
    }))
  })));
}

async function languageCandidates() {
  return page.locator('a, button, [role="button"], option').evaluateAll(nodes => nodes.map((node, index) => ({
    index,
    tag: node.tagName.toLowerCase(),
    text: (node.textContent || node.value || '').replace(/\s+/g, ' ').trim(),
    href: node.getAttribute('href'),
    id: node.id || null,
    className: node.getAttribute('class'),
    onclick: node.getAttribute('onclick'),
    dataset: { ...node.dataset },
    visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
    outerHTML: node.outerHTML.slice(0, 2500)
  })).filter(x => /english|french|fran[cç]ais|anglais|translation|translate/i.test(`${x.text} ${x.href || ''} ${x.onclick || ''} ${JSON.stringify(x.dataset)}`)));
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session not proven');

  // Hard read-only gate: after login no POST is allowed to reach TheTVDB.
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
    const translationUrl = `${BASE}/series/${def.slug}/episodes/${def.publicId}/translate/ep/0`;
    await goto(translationUrl);
    const item = {
      ...def,
      translationUrl,
      initialUrl: page.url(),
      bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 15000),
      candidates: await languageCandidates(),
      initialForms: await captureForms(),
      interactions: []
    };

    const candidates = item.candidates.filter(c => /english|french|fran[cç]ais|anglais/i.test(c.text));
    for (const c of candidates.slice(0, 8)) {
      await goto(translationUrl);
      const locator = page.locator('a, button, [role="button"], option').filter({ hasText: c.text }).first();
      const interaction = { candidate: c, beforeUrl: page.url(), clicked: false, afterUrl: null, forms: [], error: null };
      try {
        const href = safeHref(c.href, translationUrl);
        if (href) {
          await goto(href);
          interaction.clicked = true;
        } else if (await locator.count()) {
          await locator.click({ timeout: 5000, noWaitAfter: true });
          interaction.clicked = true;
          await page.waitForTimeout(700);
        }
        interaction.afterUrl = page.url();
        interaction.forms = await captureForms();
      } catch (e) {
        interaction.error = e?.message || String(e);
      }
      item.interactions.push(interaction);
    }

    const useful = item.interactions.flatMap(x => x.forms).filter(f => f.method === 'POST' && f.fields.some(field => /name|title|overview|translation|language|lang/i.test(field.name || '')));
    if (!useful.length) report.unresolved.push({ target: def.target, reason: 'No translation edit POST form revealed by safe language interactions.' });
    report.targets.push(item);
  }

  report.ok = report.authenticated && report.unresolved.length === 0;
} catch (e) {
  report.unresolved.push({ target: 'GLOBAL', reason: e?.stack || e?.message || String(e) });
} finally {
  await browser.close();
}

await fs.writeFile('reports/translation-preflight-v2.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Blocked POSTs: ${report.blockedPosts.length}`,
  `Targets: ${report.targets.length}`,
  `Unresolved: ${report.unresolved.length}`,
  `OK: ${report.ok}`,
  ''
];
for (const t of report.targets) {
  lines.push(`TARGET | ${t.target} | ${t.publicId}`);
  for (const c of t.candidates) lines.push(`  CANDIDATE | ${c.tag} | ${c.text} | href=${c.href || ''} | data=${JSON.stringify(c.dataset)}`);
  for (const i of t.interactions) {
    lines.push(`  INTERACT | ${i.candidate.text} | clicked=${i.clicked} | after=${i.afterUrl || ''} | error=${i.error || ''}`);
    for (const f of i.forms.filter(f => f.method === 'POST')) {
      lines.push(`    POST FORM | action=${f.action} | visible=${f.visible}`);
      for (const field of f.fields.filter(x => /name|title|overview|translation|language|lang/i.test(x.name || ''))) lines.push(`      FIELD | ${field.tag}/${field.type} | ${field.name} | value=${field.value}`);
    }
  }
}
for (const x of report.unresolved) lines.push(`UNRESOLVED | ${x.target} | ${x.reason}`);
await fs.writeFile('reports/translation-preflight-v2.txt', lines.join('\n'));
console.log(lines.join('\n'));
if (!report.ok) process.exitCode = 2;
