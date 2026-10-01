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

function safeFieldDescriptor(el) {
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.getAttribute('id'),
    required: Boolean(el.required),
    placeholder: el.getAttribute('placeholder'),
    autocomplete: el.getAttribute('autocomplete'),
    multiple: Boolean(el.multiple)
  };
}

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
    fields: Array.from(form.querySelectorAll('input, select, textarea')).map(safeFieldDescriptor),
    submitControls: Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.getAttribute('id'),
      text: (el.textContent || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim()
    }))
  })));

  return {
    source,
    candidateKind,
    finalUrl: page.url(),
    title: await page.title(),
    forms
  };
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

    const links = await page.locator('a[href]').evaluateAll(anchors => {
      const out = [];
      const seen = new Set();
      for (const a of anchors) {
        const href = a.href || '';
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        const signal = `${text} ${href}`.toLowerCase();
        if (!/(add|create|edit|episode)/i.test(signal)) continue;
        if (!href.includes('thetvdb.com')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        out.push({ href, text });
      }
      return out.slice(0, 80);
    });

    targetResult.candidateLinks = links;

    const addCandidate = links.find(link => /add|create/i.test(`${link.text} ${link.href}`) && /episode/i.test(`${link.text} ${link.href}`));
    const editCandidate = links.find(link => /edit/i.test(`${link.text} ${link.href}`) && /episode/i.test(`${link.text} ${link.href}`));

    for (const [kind, candidate] of [['add-episode', addCandidate], ['edit-episode', editCandidate]]) {
      if (!candidate) {
        targetResult.notes.push(`No visible ${kind} link discovered on the series page.`);
        continue;
      }

      const nav = await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      await page.waitForTimeout(1000);
      if (!nav || nav.status() >= 400) {
        targetResult.notes.push(`${kind} candidate returned HTTP ${nav?.status() ?? 'n/a'}.`);
      } else {
        targetResult.inspectedPages.push(await inspectCurrentPage(candidate.href, kind));
      }

      // Return to the canonical series page before inspecting another candidate.
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      await page.waitForTimeout(600);
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
  lines.push(`Candidate links: ${target.candidateLinks.length}`);
  lines.push(`Inspected pages: ${target.inspectedPages.length}`);
  for (const inspected of target.inspectedPages) {
    lines.push(`- ${inspected.candidateKind}: ${inspected.finalUrl}`);
    lines.push(`  Forms: ${inspected.forms.length}`);
    for (const form of inspected.forms) {
      lines.push(`  - ${(form.method || 'GET').toUpperCase()} ${form.action || '(no action)'} | fields=${form.fields.map(f => `${f.tag}:${f.type || ''}:${f.name || f.id || '(unnamed)'}`).join(', ')}`);
    }
  }
  for (const note of target.notes) lines.push(`- NOTE: ${note}`);
  lines.push('');
}
lines.push(...report.notes);
await fs.writeFile('reports/form-preflight.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (!report.authenticated) process.exitCode = 2;
