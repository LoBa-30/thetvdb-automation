import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;

await fs.mkdir('reports', { recursive: true });

const TARGETS = [
  { name: 'Djilsi', slug: 'djilsi', season: 2026, editUrl: 'https://thetvdb.com/series/djilsi/seasons/official/2026/edit' },
  { name: 'Raska', slug: 'raska', season: 2018, editUrl: 'https://thetvdb.com/series/raska/seasons/official/2018/edit' },
  { name: 'Raska', slug: 'raska', season: 2023, editUrl: 'https://thetvdb.com/series/raska/seasons/official/2023/edit' }
];

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'POST_APPLY_READ_ONLY_CHECK',
  authenticated: false,
  writeRequestsDetected: 0,
  targets: [],
  findings: [],
  ok: false
};

if (!username || !password) {
  report.findings.push('Missing TVDB credentials.');
  await fs.writeFile('reports/post-apply-check.json', JSON.stringify(report, null, 2));
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
  if (request.method() === 'POST' && /thetvdb\.com\/series\//i.test(request.url())) {
    report.writeRequestsDetected += 1;
  }
});

async function login() {
  await page.goto('https://thetvdb.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  const email = form.locator('input[name="email"]').first();
  const pass = form.locator('input[name="password"]').first();
  const submit = form.locator('button[type="submit"], input[type="submit"]').first();
  if (!(await email.isVisible().catch(() => false)) || !(await pass.isVisible().catch(() => false)) || !(await submit.isVisible().catch(() => false))) return false;
  await email.fill(username);
  await pass.fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(800);
  const probe = await context.request.get('https://thetvdb.com/auth/getuser').catch(() => null);
  if (!probe?.ok()) return false;
  const text = await probe.text().catch(() => '');
  try {
    const payload = JSON.parse(text);
    return Boolean(payload && typeof payload === 'object' && Object.keys(payload).length);
  } catch {
    return false;
  }
}

async function inspectSeason(def) {
  const response = await page.goto(def.editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (!response || response.status() >= 400) throw new Error(`${def.name} ${def.season}: edit page HTTP ${response?.status() ?? 'n/a'}`);
  await page.waitForTimeout(500);
  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map((input, index) => {
    const inputName = input.getAttribute('name') || '';
    const internalId = inputName.match(/^episodes\[(\d+)\]$/)?.[1] || null;
    let container = input.closest('tr');
    if (!container) container = input.closest('.row');
    if (!container) container = input.parentElement?.parentElement || input.parentElement;
    const anchor = container?.querySelector('a[href*="/episodes/"]') || null;
    const href = anchor?.href || '';
    const publicId = href.match(/\/episodes\/(\d+)/)?.[1] || null;
    const title = (anchor?.textContent || '').replace(/\s+/g, ' ').trim();
    const rowText = (container?.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      index,
      internalId,
      publicId,
      number: Number(input.value),
      title,
      rowText,
      editUrl: publicId ? `https://thetvdb.com/series/${def.slug}/episodes/${publicId}/0/edit` : null
    };
  }));
  return rows.sort((a, b) => a.number - b.number || a.index - b.index);
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session could not be proven.');
  loginComplete = true;

  for (const def of TARGETS) {
    const rows = await inspectSeason(def);
    report.targets.push({ ...def, count: rows.length, rows });
  }

  const dj = report.targets.find(t => t.name === 'Djilsi');
  if (!dj || dj.count !== 17) report.findings.push(`Djilsi 2026 should have 17 episodes; found ${dj?.count ?? 0}.`);
  if (dj) {
    const e11 = dj.rows.filter(r => r.number === 11);
    const e17 = dj.rows.filter(r => r.number === 17);
    report.findings.push(`Djilsi E11 count=${e11.length}: ${e11.map(r => `${r.publicId} :: ${r.title}`).join(' | ')}`);
    report.findings.push(`Djilsi E17 count=${e17.length}: ${e17.map(r => `${r.publicId} :: ${r.title}`).join(' | ')}`);
  }

  const r18 = report.targets.find(t => t.name === 'Raska' && t.season === 2018);
  const r23 = report.targets.find(t => t.name === 'Raska' && t.season === 2023);
  if (r18) {
    const nums = r18.rows.map(r => r.number);
    report.findings.push(`Raska 2018 numbering: ${nums.join(',')}`);
  }
  if (r23) {
    const nums = r23.rows.map(r => r.number);
    report.findings.push(`Raska 2023 numbering: ${nums.join(',')}`);
  }

  report.ok = report.writeRequestsDetected === 0;
} catch (error) {
  report.findings.push(error?.message || String(error));
} finally {
  await browser.close();
}

await fs.writeFile('reports/post-apply-check.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Write requests detected: ${report.writeRequestsDetected}`,
  `OK: ${report.ok}`,
  ''
];
for (const target of report.targets) {
  lines.push(`## ${target.name} ${target.season} | count=${target.count}`);
  for (const row of target.rows) lines.push(`E${row.number} | TVDB ${row.publicId || '?'} | ${row.title}`);
  lines.push('');
}
lines.push('FINDINGS:');
for (const finding of report.findings) lines.push(`- ${finding}`);
await fs.writeFile('reports/post-apply-check.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (!report.ok) process.exitCode = 2;
