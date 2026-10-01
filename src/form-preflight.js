import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;

await fs.mkdir('reports', { recursive: true });

const TARGETS = [
  { name: 'Djilsi', url: 'https://thetvdb.com/series/djilsi/allseasons/official' },
  { name: 'Raska', url: 'https://thetvdb.com/series/raska/allseasons/official' },
  { name: 'Squeezie', url: 'https://thetvdb.com/series/279758-show/allseasons/official' }
];

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'FORM_PREFLIGHT_READ_ONLY_NO_SUBMITS',
  authenticated: false,
  safety: {
    formSubmitsAllowed: false,
    editPostsAllowed: false,
    destructiveActionsAllowed: false,
    credentialsLogged: false
  },
  sessionProbe: null,
  targets: [],
  notes: []
};

if (!username || !password) {
  report.notes.push('Missing TVDB_USERNAME or TVDB_PASSWORD GitHub Actions secret.');
  await fs.writeFile('reports/form-preflight.json', JSON.stringify(report, null, 2));
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
});
const page = await context.newPage();

async function login() {
  await page.goto('https://thetvdb.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1000);

  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  const email = form.locator('input[name="email"]').first();
  const pass = form.locator('input[name="password"]').first();
  const submit = form.locator('button[type="submit"], input[type="submit"]').first();

  if (!(await email.isVisible().catch(() => false)) || !(await pass.isVisible().catch(() => false)) || !(await submit.isVisible().catch(() => false))) {
    throw new Error('Could not identify exact TheTVDB login controls.');
  }

  await email.fill(username);
  await pass.fill(password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submit.click()
  ]);
  await page.waitForTimeout(1800);

  const probe = await context.request.get('https://thetvdb.com/auth/getuser').catch(() => null);
  if (!probe) return false;
  const status = probe.status();
  const text = await probe.text().catch(() => '');
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  const hasUserPayload = Boolean(payload && typeof payload === 'object' && Object.keys(payload).length);
  report.sessionProbe = { status, ok: probe.ok(), hasUserPayload };
  return probe.ok() && hasUserPayload;
}

async function inspectCurrentPage(source, candidateKind) {
  const forms = await page.locator('form').evaluateAll(forms => forms.map((form, index) => ({
    index,
    action: form.getAttribute('action'),
    method: (form.getAttribute('method') || 'GET').toUpperCase(),
    fields: Array.from(form.querySelectorAll('input, select, textarea')).map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.getAttribute('id'),
      required: Boolean(el.required),
      placeholder: el.getAttribute('placeholder'),
      autocomplete: el.getAttribute('autocomplete'),
      multiple: Boolean(el.multiple)
    })),
    submitControls: Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.getAttribute('id'),
      text: (el.textContent || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim()
    }))
  })));

  const controls = await page.locator('a[href], button').evaluateAll(nodes => nodes.map(el => ({
    tag: el.tagName.toLowerCase(),
    href: el.tagName.toLowerCase() === 'a' ? el.href : null,
    text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
    title: el.getAttribute('title'),
    ariaLabel: el.getAttribute('aria-label')
  })).filter(item => /add|create|edit|episode/i.test(`${item.text} ${item.href || ''} ${item.title || ''} ${item.ariaLabel || ''}`)).slice(0, 80));

  return {
    source,
    candidateKind,
    finalUrl: page.url(),
    title: await page.title(),
    forms,
    controls
  };
}

async function collectEditorSignals() {
  return page.locator('a[href], button').evaluateAll(nodes => {
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      const href = tag === 'a' ? (el.href || '') : '';
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      const signal = `${text} ${href} ${title} ${aria}`.toLowerCase();
      if (!/(add|create|edit|episode)/i.test(signal)) continue;
      if (href && !href.includes('thetvdb.com')) continue;
      const key = `${tag}|${href}|${text}|${title}|${aria}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tag, href: href || null, text, title: title || null, ariaLabel: aria || null });
    }
    return out.slice(0, 120);
  });
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session could not be proven. No form inspection attempted.');

  for (const target of TARGETS) {
    const targetResult = {
      name: target.name,
      seriesUrl: target.url,
      candidateLinks: [],
      inspectedPages: [],
      notes: []
    };

    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await page.waitForTimeout(1200);
    if (!response || response.status() >= 400) {
      targetResult.notes.push(`Series page unavailable or HTTP ${response?.status() ?? 'n/a'}.`);
      report.targets.push(targetResult);
      continue;
    }

    const links = await collectEditorSignals();
    targetResult.candidateLinks = links;

    const episodeDetail = links.find(link => link.href && /\/episodes?\//i.test(link.href));
    const directAdd = links.find(link => link.href && /add|create/i.test(`${link.text} ${link.href} ${link.title || ''} ${link.ariaLabel || ''}`) && /episode/i.test(`${link.text} ${link.href} ${link.title || ''} ${link.ariaLabel || ''}`));
    const directEdit = links.find(link => link.href && /edit/i.test(`${link.text} ${link.href} ${link.title || ''} ${link.ariaLabel || ''}`) && /episode/i.test(`${link.text} ${link.href} ${link.title || ''} ${link.ariaLabel || ''}`));

    const candidates = [];
    if (directAdd) candidates.push(['add-episode', directAdd]);
    if (directEdit) candidates.push(['edit-episode', directEdit]);

    // If the series page does not expose editor links directly, inspect one episode detail page read-only
    // and discover edit controls there. This still performs GET navigation only and never submits a form.
    if (!directAdd && !directEdit && episodeDetail) {
      const detailNav = await page.goto(episodeDetail.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      await page.waitForTimeout(900);
      if (detailNav && detailNav.status() < 400) {
        targetResult.inspectedPages.push(await inspectCurrentPage(episodeDetail.href, 'episode-detail'));
        const detailSignals = await collectEditorSignals();
        for (const signal of detailSignals) {
          if (!targetResult.candidateLinks.some(x => x.href === signal.href && x.text === signal.text)) targetResult.candidateLinks.push(signal);
        }
        const detailEdit = detailSignals.find(link => link.href && /edit/i.test(`${link.text} ${link.href} ${link.title || ''} ${link.ariaLabel || ''}`));
        if (detailEdit) candidates.push(['edit-episode-from-detail', detailEdit]);
      } else {
        targetResult.notes.push(`Episode detail candidate returned HTTP ${detailNav?.status() ?? 'n/a'}.`);
      }
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      await page.waitForTimeout(500);
    }

    if (!directAdd) targetResult.notes.push('No direct add-episode URL discovered on the series page.');
    if (!directEdit) targetResult.notes.push('No direct edit-episode URL discovered on the series page.');

    for (const [kind, candidate] of candidates) {
      if (!candidate?.href) continue;
      const nav = await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      await page.waitForTimeout(900);
      if (!nav || nav.status() >= 400) {
        targetResult.notes.push(`${kind} candidate returned HTTP ${nav?.status() ?? 'n/a'}.`);
      } else {
        targetResult.inspectedPages.push(await inspectCurrentPage(candidate.href, kind));
      }
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      await page.waitForTimeout(500);
    }

    report.targets.push(targetResult);
  }

  report.notes.push('Read-only form discovery complete. No edit form was submitted.');
} catch (error) {
  report.notes.push(error?.message || String(error));
} finally {
  await browser.close();
}

await fs.writeFile('reports/form-preflight.json', JSON.stringify(report, null, 2));

const lines = [
  `Authenticated: ${report.authenticated}`,
  `Session probe: ${report.sessionProbe ? `status=${report.sessionProbe.status}, ok=${report.sessionProbe.ok}, userPayload=${report.sessionProbe.hasUserPayload}` : 'n/a'}`,
  'Mode: FORM_PREFLIGHT_READ_ONLY_NO_SUBMITS',
  ''
];
for (const target of report.targets) {
  lines.push(`## ${target.name}`);
  lines.push(`Candidate controls: ${target.candidateLinks.length}`);
  for (const candidate of target.candidateLinks.slice(0, 25)) {
    lines.push(`- CONTROL ${candidate.tag}: ${candidate.text || '(no text)'} | ${candidate.href || '(no href)'} | title=${candidate.title || ''} | aria=${candidate.ariaLabel || ''}`);
  }
  lines.push(`Inspected pages: ${target.inspectedPages.length}`);
  for (const inspected of target.inspectedPages) {
    lines.push(`- ${inspected.candidateKind}: ${inspected.finalUrl}`);
    lines.push(`  Forms: ${inspected.forms.length}`);
    for (const form of inspected.forms) {
      lines.push(`  - ${(form.method || 'GET').toUpperCase()} ${form.action || '(no action)'} | fields=${form.fields.map(f => `${f.tag}:${f.type || ''}:${f.name || f.id || '(unnamed)'}`).join(', ')}`);
    }
    for (const control of inspected.controls.slice(0, 20)) {
      lines.push(`  - PAGE CONTROL ${control.tag}: ${control.text || '(no text)'} | ${control.href || '(no href)'} | title=${control.title || ''} | aria=${control.ariaLabel || ''}`);
    }
  }
  for (const note of target.notes) lines.push(`- NOTE: ${note}`);
  lines.push('');
}
lines.push(...report.notes);
await fs.writeFile('reports/form-preflight.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (!report.authenticated) process.exitCode = 2;
