import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

// One immutable-ID correction; never create, delete or edit images.
const BASE = 'https://thetvdb.com';
const SLUG = '338282-show';
const X = {
  id: '12022496', year: '2026', number: 60,
  videoId: 'QG1WcEWOF4g', channelId: 'UCDPK_MTu3uTUFJXRVcTJcEw',
  oldDate: '2026-06-06', newDate: '2026-10-06'
};
const OUT = 'reports/mcfly-priorities-v22';
await fs.mkdir(OUT, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(), action: 'SINGLE_ID_DATE_ONLY',
  target: X, authenticated: false, checks: [], blocked: [], writes: [],
  verifications: [], result: 'NOT_STARTED'
};
const canon = x => String(x || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const armed = process.env.TVDB_MCFLY_PRIORITIES_APPLY === 'yes';
const user = process.env.TVDB_USERNAME, password = process.env.TVDB_PASSWORD;
let browser;

function stop(message) { throw new Error(message); }

async function youtubePrimary() {
  const u = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + X.channelId;
  const r = await fetch(u, { headers: { 'Accept': 'application/atom+xml' },
    signal: AbortSignal.timeout(30000) });
  if (!r.ok) stop('YOUTUBE_RSS_HTTP_' + r.status);
  const xml = await r.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const matches = entries.filter(s => s.includes('<yt:videoId>' + X.videoId + '</yt:videoId>'));
  if (matches.length !== 1) stop('PRIMARY_RSS_EXACT_ID_MISSING_OR_AMBIGUOUS');
  const entry = matches[0];
  const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || '';
  const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
  report.checks.push({ check: 'PRIMARY_YOUTUBE_RSS', url: u, videoId: X.videoId,
    published, title, verified: published.startsWith(X.newDate) && /priorities/i.test(title) });
  if (!published.startsWith(X.newDate) || !/priorities/i.test(title)) stop('YOUTUBE_ID_DATE_TITLE_NOT_PROVEN');
}

async function go(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!response || response.status() >= 400) stop('TVDB_HTTP_' + (response?.status() || 'none') + '_' + url);
  if (/\/auth\/login|\/login(?:\?|$)/i.test(page.url()) && !/\/auth\/login/.test(url)) stop('AUTH_REDIRECT');
  const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 2000);
  if (/verify you are human|captcha|too many requests|access denied|rate limit|cloudflare challenge/i.test(body))
    stop('HUMAN_VERIFICATION_OR_SITE_RESTRICTION');
  return response;
}

async function login(context, page) {
  await go(page, BASE + '/auth/login');
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  if (await form.count() !== 1) stop('LOGIN_FORM_UNAVAILABLE');
  await form.locator('input[name="email"]').fill(user);
  await form.locator('input[name="password"]').fill(password);
  await form.locator('button[type="submit"],input[type="submit"]').first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const probe = await context.request.get(BASE + '/auth/getuser', { timeout: 30000 }).catch(() => null);
  if (!probe?.ok()) stop('AUTH_NOT_PROVEN');
  const payload = await probe.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) stop('AUTH_PAYLOAD_EMPTY');
  report.authenticated = true;
}

async function seasonRow(page) {
  await go(page, BASE + '/series/' + SLUG + '/seasons/official/' + X.year + '/edit');
  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map(input => {
    const c = input.closest('tr') || input.closest('.row') ||
      input.parentElement?.parentElement || input.parentElement;
    const a = c?.querySelector('a[href*="/episodes/"]');
    return { id: (a?.href || '').match(/\/episodes\/(\d+)/)?.[1] || null,
      number: Number(input.value), title: (a?.textContent || '').replace(/\s+/g, ' ').trim() };
  }));
  const row = rows.find(x => x.id === X.id);
  report.checks.push({ check: 'IMMUTABLE_ID_SEASON_ROW', row });
  if (!row || row.number !== X.number || !/priorities/i.test(row.title)) stop('SEASON_ID_OR_TITLE_DRIFT');
}

async function meta(page) {
  await go(page, BASE + '/series/' + SLUG + '/episodes/' + X.id + '/0/edit');
  const form = page.locator('form').filter({ has: page.locator('input[name="airdate"]') }).first();
  if (await form.count() !== 1) stop('METADATA_FORM_UNAVAILABLE');
  const rawAction = await form.getAttribute('action');
  const action = new URL(rawAction || '', BASE);
  const allowed = '/series/' + SLUG + '/season/official/episodes/' + X.id + '/update';
  if (action.origin !== BASE || action.pathname !== allowed) stop('UPDATE_FORM_ACTION_DRIFT');
  const date = await form.locator('input[name="airdate"]').inputValue();
  return { form, path: allowed, date };
}

async function submit(context, page, form, path) {
  let blockedRequest = null;
  const guard = async route => {
    const r = route.request(), u = new URL(r.url()), method = r.method().toUpperCase();
    if (u.origin === BASE && !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      !(method === 'POST' && u.pathname === path)) {
      blockedRequest = method + ' ' + u.pathname; await route.abort(); return;
    }
    await route.continue();
  };
  await context.route('**/*', guard);
  try {
    await form.evaluate(f => f.requestSubmit());
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  } finally { await context.unroute('**/*', guard); }
  if (blockedRequest) stop('UNEXPECTED_TVDB_WRITE_' + blockedRequest);
}

try {
  if (!armed) stop('NOT_ARMED');
  if (!user || !password) stop('MISSING_GITHUB_SECRETS');
  // Primary evidence is mandatory, and checked BEFORE TheTVDB login or write.
  await youtubePrimary();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  await login(context, page);
  await seasonRow(page);
  const current = await meta(page);
  report.checks.push({ check: 'CURRENT_AIRDATE', id: X.id, date: current.date });
  if (current.date === X.newDate) {
    report.verifications.push({ id: X.id, date: current.date, ok: true });
    report.result = 'ALREADY_CORRECT_NO_WRITE';
  } else {
    if (current.date !== X.oldDate) stop('AIRDATE_DRIFT_' + current.date);
    const fields = await current.form.locator('input,select,textarea')
      .evaluateAll(xs => xs.map(e => ({ name: e.getAttribute('name'), value: e.value }))
        .filter(x => x.name));
    const airFields = fields.filter(x => x.name === 'airdate');
    if (airFields.length !== 1) stop('NON_UNIQUE_AIRDATE_FIELD');
    await current.form.locator('input[name="airdate"]').fill(X.newDate);
    await submit(context, page, current.form, current.path);
    const after = await meta(page);
    report.verifications.push({ id: X.id, date: after.date, ok: after.date === X.newDate });
    if (after.date !== X.newDate) stop('POST_WRITE_NOT_PERSISTENT_' + after.date);
    report.writes.push({ type: 'AIRDATE_ONLY', id: X.id, from: current.date, to: after.date });
    report.result = 'APPLIED_AND_VERIFIED';
  }
} catch (e) {
  report.blocked.push({ reason: String(e?.message || e) });
  report.result = report.writes.length ? 'POST_WRITE_REVIEW_REQUIRED' : 'BLOCKED_OR_REVIEW_REQUIRED';
} finally { if (browser) await browser.close().catch(() => {}); }
await fs.writeFile(OUT + '/report.json', JSON.stringify(report, null, 2) + '\n');
await fs.writeFile(OUT + '/summary.txt', [
  'result=' + report.result, 'authenticated=' + report.authenticated,
  'writes=' + report.writes.length, 'blocked=' + report.blocked.length,
  ...report.blocked.map(x => 'reason=' + x.reason)
].join('\n') + '\n');
console.log((await fs.readFile(OUT + '/summary.txt', 'utf8')).trim());
if (!['APPLIED_AND_VERIFIED', 'ALREADY_CORRECT_NO_WRITE'].includes(report.result)) process.exitCode = 2;
