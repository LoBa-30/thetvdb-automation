import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const BASE = 'https://thetvdb.com';
const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const armed = String(process.env.TVDB_BATCH_APPLY || '').toLowerCase() === 'yes';
const lock = JSON.parse(await fs.readFile('config/apply-all-locks.json', 'utf8'));

await fs.mkdir('reports', { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'BATCH_APPLY_ALL_V2_TRANSLATION_SAFE',
  armed,
  authenticated: false,
  preflight: [],
  writes: [],
  skips: [],
  verifications: [],
  rollbackAttempts: [],
  blocked: [],
  unexpectedPosts: [],
  result: 'NOT_STARTED',
  safety: {
    noDeletes: true,
    noUnassignedWrites: true,
    noJapanExpoAutomaticCreate: true,
    exactAllowlistOnly: true,
    globalPreflightBeforeFirstWrite: true,
    translationRouteValidated: true,
    unexpectedPostBlocked: true,
    verifyAfterEveryWrite: true
  }
};

const fail = message => { throw new Error(message); };
const normalize = (value = '') => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const equalText = (a = '', b = '') => a === b || normalize(a) === normalize(b);
const isContiguous = rows => rows.map(r => r.number).sort((a, b) => a - b).every((n, i) => n === i + 1);

if (!armed) {
  report.result = 'BLOCKED_NOT_ARMED';
  await fs.writeFile('reports/batch-apply-all-v2.json', JSON.stringify(report, null, 2));
  console.log('Batch apply-all v2 is not armed.');
  process.exit(2);
}
if (!username || !password) {
  report.result = 'BLOCKED_MISSING_SECRETS';
  await fs.writeFile('reports/batch-apply-all-v2.json', JSON.stringify(report, null, 2));
  console.log('Missing TVDB credentials.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
});
const page = await context.newPage();

function absoluteAction(action) {
  if (!action) return null;
  try { return new URL(action, BASE).href; } catch { return null; }
}

async function assertNoChallenge() {
  const url = page.url();
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 8000);
  if (/captcha|verify you are human|security challenge|cloudflare/i.test(`${url}\n${text}`)) {
    fail(`Security challenge detected at ${url}`);
  }
}

async function goto(url) {
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    last = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (last && last.status() < 400) {
      await page.waitForTimeout(650);
      await assertNoChallenge();
      return last;
    }
    await page.waitForTimeout(700 * attempt);
  }
  fail(`GET failed: ${url} (${last?.status() ?? 'n/a'})`);
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
  await assertNoChallenge();
  const probe = await context.request.get(`${BASE}/auth/getuser`).catch(() => null);
  return Boolean(probe?.ok());
}

async function readSeason(slug, season) {
  const editUrl = `${BASE}/series/${slug}/seasons/official/${season}/edit`;
  await goto(editUrl);
  const form = page.locator('form').filter({ has: page.locator('input[name="season_number"]') }).first();
  if (!(await form.count())) fail(`${slug} ${season}: season edit form not found`);
  const action = await form.getAttribute('action');
  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map((input, index) => {
    const name = input.getAttribute('name') || '';
    const internalId = name.match(/^episodes\[(\d+)\]$/)?.[1] || null;
    let container = input.closest('tr') || input.closest('.row') || input.parentElement?.parentElement || input.parentElement;
    const anchor = container?.querySelector('a[href*="/episodes/"]') || null;
    const href = anchor?.href || '';
    return {
      index,
      internalId,
      publicId: href.match(/\/episodes\/(\d+)/)?.[1] || null,
      number: Number(input.value),
      title: (anchor?.textContent || '').replace(/\s+/g, ' ').trim()
    };
  }));
  rows.sort((a, b) => a.number - b.number || a.index - b.index);
  return { slug, season, editUrl, action, actionUrl: absoluteAction(action), rows };
}

async function readEpisodeMeta(slug, publicId) {
  const url = `${BASE}/series/${slug}/episodes/${publicId}/0/edit`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="airdate"], input[name="runtime"]') }).first();
  if (!(await form.count())) fail(`${slug} ${publicId}: metadata edit form not found`);
  const action = await form.getAttribute('action');
  if (!action || !action.includes(`/series/${slug}/season/official/episodes/${publicId}/update`)) fail(`${slug} ${publicId}: unexpected metadata action ${action}`);
  const air = form.locator('input[name="airdate"]').first();
  const runtime = form.locator('input[name="runtime"]').first();
  return {
    url,
    action,
    actionUrl: absoluteAction(action),
    airdate: await air.inputValue().catch(() => null),
    runtimeMinutes: Number(await runtime.inputValue().catch(() => '')) || null,
    hasAirdate: Boolean(await air.count()),
    hasRuntime: Boolean(await runtime.count())
  };
}

async function readFrenchTranslation(slug, publicId) {
  const url = `${BASE}/series/${slug}/episodes/${publicId}/translate/fra/0/single`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="episode_name"]') }).first();
  if (!(await form.count())) fail(`${slug} ${publicId}: French translation form not found`);
  const action = await form.getAttribute('action');
  const method = ((await form.getAttribute('method')) || 'GET').toUpperCase();
  if (method !== 'POST') fail(`${slug} ${publicId}: unexpected translation method ${method}`);
  if (action !== '/episodes/translatestore') fail(`${slug} ${publicId}: unexpected translation action ${action}`);
  const language = await form.locator('[name="language"]').first().inputValue().catch(() => null);
  const episodeLanguage = await form.locator('[name="episode_language"]').first().inputValue().catch(() => null);
  if (language !== 'fra') fail(`${slug} ${publicId}: unexpected translation language ${language}`);
  if (episodeLanguage && episodeLanguage !== 'fra') fail(`${slug} ${publicId}: unexpected episode_language ${episodeLanguage}`);
  return {
    url,
    action,
    actionUrl: absoluteAction(action),
    title: await form.locator('input[name="episode_name"]').inputValue()
  };
}

async function bulkAddPreflight(add) {
  const url = `${BASE}/series/${add.slug}/seasons/official/${add.season}/bulkadd`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="number[]"]') }).first();
  if (!(await form.count())) fail(`${add.target} ${add.season}: bulk-add form not found`);
  const action = await form.getAttribute('action');
  const expected = `/series/${add.slug}/seasons/official/${add.season}/savebulkadd`;
  if (action !== expected) fail(`${add.target} ${add.season}: unexpected bulk-add action ${action}`);
  for (const name of ['number[]', 'name[]', 'date[]']) {
    if (!(await form.locator(`[name="${name}"]`).count())) fail(`${add.target} ${add.season}: missing bulk-add field ${name}`);
  }
  return { url, action, actionUrl: absoluteAction(action) };
}

async function inspectExactEdit(item) {
  const season = await readSeason(item.slug, item.season);
  const row = season.rows.find(r => r.number === item.episode);
  if (!row || row.publicId !== String(item.publicId)) fail(`${item.target} S${item.season}E${item.episode}: expected TVDB ${item.publicId}, found ${row?.publicId || 'missing'}`);
  const meta = await readEpisodeMeta(item.slug, item.publicId);
  const translation = item.desiredTitle != null ? await readFrenchTranslation(item.slug, item.publicId) : null;
  const needs = {
    title: item.desiredTitle != null && translation.title !== item.desiredTitle,
    firstAired: item.desiredFirstAired != null && meta.airdate !== item.desiredFirstAired,
    runtime: item.desiredRuntimeMinutes != null && meta.runtimeMinutes !== item.desiredRuntimeMinutes
  };
  if (needs.firstAired && !meta.hasAirdate) fail(`${item.target} ${item.publicId}: airdate field missing`);
  if (needs.runtime && !meta.hasRuntime) fail(`${item.target} ${item.publicId}: runtime field missing`);
  return { item, row, meta, translation, needs, any: Object.values(needs).some(Boolean) };
}

async function inspectAdd(add) {
  const season = await readSeason(add.slug, add.season);
  const byTitle = season.rows.find(r => equalText(r.title, add.name));
  if (byTitle) {
    if (byTitle.number !== add.episode) fail(`${add.target} ${add.season}: existing target title is E${byTitle.number}, expected E${add.episode}`);
    const meta = await readEpisodeMeta(add.slug, byTitle.publicId);
    if (meta.airdate !== add.date) fail(`${add.target} S${add.season}E${add.episode}: existing date ${meta.airdate}, expected ${add.date}`);
    if (add.runtimeMinutes != null && meta.runtimeMinutes !== add.runtimeMinutes) fail(`${add.target} S${add.season}E${add.episode}: existing runtime ${meta.runtimeMinutes}, expected ${add.runtimeMinutes}`);
    return { add, state: 'ALREADY_PRESENT', season, row: byTitle, meta };
  }

  if (!isContiguous(season.rows)) fail(`${add.target} ${add.season}: numbering is not contiguous`);
  const bulk = await bulkAddPreflight(add);

  if (add.mode === 'APPEND') {
    if (season.rows.length !== add.expectedSeasonCountBefore) fail(`${add.target} ${add.season}: expected ${add.expectedSeasonCountBefore} episodes, found ${season.rows.length}`);
    const last = season.rows.at(-1);
    if (!last || last.number !== add.episode - 1) fail(`${add.target} ${add.season}: expected last episode E${add.episode - 1}`);
    const lastMeta = await readEpisodeMeta(add.slug, last.publicId);
    if (add.expectedPreviousLastAirdate && lastMeta.airdate !== add.expectedPreviousLastAirdate) fail(`${add.target} ${add.season}: previous last airdate drift (${lastMeta.airdate})`);
    if (lastMeta.airdate && add.date <= lastMeta.airdate) fail(`${add.target} ${add.season}: append date ${add.date} is not after last date ${lastMeta.airdate}`);
    return { add, state: 'READY_APPEND', season, bulk, last, lastMeta };
  }

  if (add.mode === 'INSERT_SHIFT_FROM_17') {
    const prev = season.rows.find(r => r.number === add.expectedPreviousEpisode);
    const next = season.rows.find(r => r.number === add.expectedNextEpisode);
    if (!prev || !next) fail(`${add.target} ${add.season}: insertion neighbors missing`);
    const prevMeta = await readEpisodeMeta(add.slug, prev.publicId);
    const nextMeta = await readEpisodeMeta(add.slug, next.publicId);
    if (prevMeta.airdate !== add.expectedPreviousAirdate || nextMeta.airdate !== add.expectedNextAirdate) fail(`${add.target} ${add.season}: insertion neighbor dates drift (${prevMeta.airdate}, ${nextMeta.airdate})`);
    if (!(prevMeta.airdate < add.date && add.date < nextMeta.airdate)) fail(`${add.target} ${add.season}: insertion date is not between E${prev.number} and E${next.number}`);
    if (!season.action || !season.action.includes(`/series/${add.slug}/official/`) || !season.action.endsWith('/saveseason')) fail(`${add.target} ${add.season}: unsafe season-save action ${season.action}`);
    const shiftRows = season.rows.filter(r => r.number >= add.episode).map(r => ({ publicId: r.publicId, internalId: r.internalId, from: r.number, to: r.number + 1 }));
    if (!shiftRows.length || shiftRows.some(r => !r.internalId || !r.publicId)) fail(`${add.target} ${add.season}: unsafe shift mapping`);
    return { add, state: 'READY_INSERT', season, bulk, prev, next, prevMeta, nextMeta, shiftRows };
  }

  fail(`${add.target}: unsupported add mode ${add.mode}`);
}

async function verifyKnownSafeState() {
  const dj = await readSeason('djilsi', 2026);
  if (dj.rows.length !== 17 || dj.rows.find(r => r.number === 11)?.publicId !== '12014131' || dj.rows.find(r => r.number === 17)?.publicId !== '12014132') fail('Djilsi 2026 known state drift');

  const r18 = await readSeason('raska', 2018);
  if (!isContiguous(r18.rows) || r18.rows.length !== 13 || r18.rows.find(r => r.number === 2)?.publicId !== '11979236' || r18.rows.find(r => r.number === 3)?.publicId !== '11960842') fail('Raska 2018 numbering drift');

  const r23 = await readSeason('raska', 2023);
  if (!isContiguous(r23.rows) || r23.rows.length !== 28 || r23.rows.find(r => r.number === 19)?.publicId !== '11978003' || r23.rows.find(r => r.number === 20)?.publicId !== '11960814') fail('Raska 2023 numbering drift');

  const r17 = await readSeason('raska', 2017);
  const e4 = r17.rows.find(r => r.number === 4);
  if (!e4 || e4.publicId !== '11960840') fail('Raska 2017 E04 mapping drift');
  const e4m = await readEpisodeMeta('raska', e4.publicId);
  if (e4.title !== 'LE RAP FÉMININ EN FORCE ! ✊' || e4m.airdate !== '2017-11-19' || e4m.runtimeMinutes !== 8) fail('Raska 2017 E04 verified state drift');

  report.verifications.push({ type: 'KNOWN_SAFE_STATE', ok: true });
}

async function submitSeasonShift(pre, direction = 'forward') {
  const add = pre.add;
  const season = await readSeason(add.slug, add.season);
  for (const map of pre.shiftRows) {
    const row = season.rows.find(r => r.publicId === map.publicId);
    const expected = direction === 'forward' ? map.from : map.to;
    if (!row || row.number !== expected) fail(`${add.target} ${add.season}: shift state drift for ${map.publicId}`);
  }
  for (const map of pre.shiftRows) {
    const row = season.rows.find(r => r.publicId === map.publicId);
    const target = direction === 'forward' ? map.to : map.from;
    await page.locator(`input[name="episodes[${row.internalId}]"]`).fill(String(target));
  }
  const form = page.locator('form').filter({ has: page.locator('input[name="season_number"]') }).first();
  const action = await form.getAttribute('action');
  if (absoluteAction(action) !== pre.season.actionUrl) fail(`${add.target} ${add.season}: season action drift`);
  const submit = form.locator('button[type="submit"], input[type="submit"]').last();
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(900);
  report.writes.push({ type: direction === 'forward' ? 'SHIFT_SEASON' : 'ROLLBACK_SHIFT_SEASON', target: add.target, season: add.season, fromEpisode: add.episode });
  const verify = await readSeason(add.slug, add.season);
  for (const map of pre.shiftRows) {
    const row = verify.rows.find(r => r.publicId === map.publicId);
    const expected = direction === 'forward' ? map.to : map.from;
    if (!row || row.number !== expected) fail(`${add.target} ${add.season}: ${direction} shift verification failed for ${map.publicId}`);
  }
}

async function submitBulkAdd(add, expectedActionUrl) {
  const url = `${BASE}/series/${add.slug}/seasons/official/${add.season}/bulkadd`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="number[]"]') }).first();
  const action = await form.getAttribute('action');
  if (absoluteAction(action) !== expectedActionUrl) fail(`${add.target} ${add.season}: bulk-add action drift`);
  await form.locator('input[name="number[]"]').first().fill(String(add.episode));
  await form.locator('input[name="name[]"]').first().fill(add.name);
  await form.locator('input[name="date[]"]').first().fill(add.date);
  const runtime = form.locator('input[name="runtime[]"]').first();
  if (await runtime.count()) await runtime.fill(add.runtimeMinutes != null ? String(add.runtimeMinutes) : '');
  const submit = form.locator('button:has-text("Add Episodes"), button[type="submit"], input[type="submit"]').last();
  if (!(await submit.isVisible().catch(() => false))) fail(`${add.target} ${add.season}: bulk-add submit missing`);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(900);
  report.writes.push({ type: 'ADD_EPISODE', target: add.target, season: add.season, episode: add.episode });
}

async function verifyAdded(add, expectedCount) {
  const season = await readSeason(add.slug, add.season);
  if (season.rows.length !== expectedCount || !isContiguous(season.rows)) fail(`${add.target} ${add.season}: post-add season verification failed`);
  const row = season.rows.find(r => r.number === add.episode);
  if (!row || !equalText(row.title, add.name)) fail(`${add.target} S${add.season}E${add.episode}: added title/number mismatch`);
  const meta = await readEpisodeMeta(add.slug, row.publicId);
  if (meta.airdate !== add.date) fail(`${add.target} S${add.season}E${add.episode}: added date mismatch`);
  if (add.runtimeMinutes != null && meta.runtimeMinutes !== add.runtimeMinutes) fail(`${add.target} S${add.season}E${add.episode}: added runtime mismatch`);
  report.verifications.push({ type: 'ADD_EPISODE', target: add.target, season: add.season, episode: add.episode, publicId: row.publicId, ok: true });
}

async function applyAddition(pre) {
  const add = pre.add;
  if (pre.state === 'ALREADY_PRESENT') {
    report.skips.push({ type: 'ADD_EPISODE', target: add.target, season: add.season, episode: add.episode, reason: 'already correct' });
    return;
  }
  if (pre.state === 'READY_APPEND') {
    await submitBulkAdd(add, pre.bulk.actionUrl);
    await verifyAdded(add, pre.season.rows.length + 1);
    return;
  }
  if (pre.state === 'READY_INSERT') {
    const beforeCount = pre.season.rows.length;
    await submitSeasonShift(pre, 'forward');
    try {
      await submitBulkAdd(add, pre.bulk.actionUrl);
      await verifyAdded(add, beforeCount + 1);
    } catch (error) {
      try {
        const current = await readSeason(add.slug, add.season);
        if (current.rows.length === beforeCount) {
          await submitSeasonShift(pre, 'rollback');
          report.rollbackAttempts.push({ target: add.target, season: add.season, ok: true });
        } else {
          report.rollbackAttempts.push({ target: add.target, season: add.season, ok: false, reason: `season count is ${current.rows.length}` });
        }
      } catch (rollbackError) {
        report.rollbackAttempts.push({ target: add.target, season: add.season, ok: false, reason: rollbackError?.message || String(rollbackError) });
      }
      throw error;
    }
  }
}

async function submitMetadataEdit(pre) {
  const { item } = pre;
  const current = await readEpisodeMeta(item.slug, item.publicId);
  if (pre.needs.firstAired && current.airdate !== pre.meta.airdate) fail(`${item.target} ${item.publicId}: airdate drift before write`);
  if (pre.needs.runtime && current.runtimeMinutes !== pre.meta.runtimeMinutes) fail(`${item.target} ${item.publicId}: runtime drift before write`);
  if (current.actionUrl !== pre.meta.actionUrl) fail(`${item.target} ${item.publicId}: metadata action drift`);
  const form = page.locator('form').filter({ has: page.locator('input[name="airdate"], input[name="runtime"]') }).first();
  if (pre.needs.firstAired) await form.locator('input[name="airdate"]').fill(item.desiredFirstAired);
  if (pre.needs.runtime) await form.locator('input[name="runtime"]').fill(String(item.desiredRuntimeMinutes));
  const submit = form.locator('button[type="submit"], input[type="submit"]').last();
  if (!(await submit.isVisible().catch(() => false))) fail(`${item.target} ${item.publicId}: metadata submit missing`);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(850);
  report.writes.push({ type: 'EDIT_METADATA', target: item.target, publicId: item.publicId, firstAired: pre.needs.firstAired, runtime: pre.needs.runtime });
  const verify = await readEpisodeMeta(item.slug, item.publicId);
  if (item.desiredFirstAired != null && verify.airdate !== item.desiredFirstAired) fail(`${item.target} ${item.publicId}: airdate verification failed`);
  if (item.desiredRuntimeMinutes != null && verify.runtimeMinutes !== item.desiredRuntimeMinutes) fail(`${item.target} ${item.publicId}: runtime verification failed`);
  report.verifications.push({ type: 'EDIT_METADATA', target: item.target, publicId: item.publicId, ok: true });
}

async function submitTranslationEdit(pre) {
  const { item } = pre;
  const current = await readFrenchTranslation(item.slug, item.publicId);
  if (current.title !== pre.translation.title) fail(`${item.target} ${item.publicId}: French title drift before write`);
  if (current.actionUrl !== pre.translation.actionUrl) fail(`${item.target} ${item.publicId}: translation action drift`);
  const form = page.locator('form').filter({ has: page.locator('input[name="episode_name"]') }).first();
  await form.locator('input[name="episode_name"]').fill(item.desiredTitle);
  const submit = form.locator('button[type="submit"], input[type="submit"]').last();
  if (!(await submit.isVisible().catch(() => false))) fail(`${item.target} ${item.publicId}: translation submit missing`);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(850);
  report.writes.push({ type: 'EDIT_FRENCH_TITLE', target: item.target, publicId: item.publicId });
  const verify = await readFrenchTranslation(item.slug, item.publicId);
  if (verify.title !== item.desiredTitle) fail(`${item.target} ${item.publicId}: French title verification failed (${verify.title})`);
  report.verifications.push({ type: 'EDIT_FRENCH_TITLE', target: item.target, publicId: item.publicId, ok: true });
}

async function applyExactEdit(pre) {
  if (!pre.any) {
    report.skips.push({ type: 'EDIT_EPISODE', target: pre.item.target, publicId: pre.item.publicId, reason: 'already correct' });
    return;
  }
  if (pre.needs.firstAired || pre.needs.runtime) await submitMetadataEdit(pre);
  if (pre.needs.title) await submitTranslationEdit(pre);
}

let exactPre = [];
let addPre = [];

try {
  report.authenticated = await login();
  if (!report.authenticated) fail('Authenticated session could not be proven');

  await context.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'DELETE' || /\/entity\/delete(?:\/|$)/i.test(url)) {
      report.unexpectedPosts.push({ method: req.method(), url, reason: 'destructive route blocked' });
      await route.abort();
      return;
    }
    await route.continue();
  });

  await verifyKnownSafeState();
  for (const item of lock.episodeEdits) {
    const pre = await inspectExactEdit(item);
    exactPre.push(pre);
    report.preflight.push({ type: 'EDIT_EPISODE', target: item.target, publicId: item.publicId, needs: pre.needs, ready: true });
  }
  for (const add of lock.episodeAdds) {
    const pre = await inspectAdd(add);
    addPre.push(pre);
    report.preflight.push({ type: 'ADD_EPISODE', target: add.target, season: add.season, episode: add.episode, state: pre.state, ready: true });
  }

  const allowedPosts = new Set();
  for (const pre of exactPre) {
    if (pre.needs.firstAired || pre.needs.runtime) allowedPosts.add(pre.meta.actionUrl);
    if (pre.needs.title) allowedPosts.add(pre.translation.actionUrl);
  }
  for (const pre of addPre) {
    if (pre.state === 'READY_APPEND') allowedPosts.add(pre.bulk.actionUrl);
    if (pre.state === 'READY_INSERT') {
      allowedPosts.add(pre.bulk.actionUrl);
      allowedPosts.add(pre.season.actionUrl);
    }
  }
  if ([...allowedPosts].some(x => !x || !x.startsWith(`${BASE}/`))) fail('Unsafe POST allowlist generated');

  await context.route('**/*', async route => {
    const req = route.request();
    if (req.method() === 'POST' && req.url().startsWith(BASE) && !allowedPosts.has(req.url())) {
      report.unexpectedPosts.push({ method: 'POST', url: req.url(), reason: 'not in exact preflight allowlist' });
      await route.abort();
      return;
    }
    await route.continue();
  });

  report.verifications.push({ type: 'GLOBAL_PREFLIGHT_COMPLETE_BEFORE_FIRST_WRITE', ok: true, editTargets: exactPre.length, addTargets: addPre.length, allowedPostCount: allowedPosts.size });

  const mastu2021 = addPre.find(x => x.add.target === 'Mastu' && x.add.season === 2021);
  if (mastu2021) await applyAddition(mastu2021);
  for (const pre of addPre.filter(x => !(x.add.target === 'Mastu' && x.add.season === 2021))) await applyAddition(pre);
  for (const pre of exactPre) await applyExactEdit(pre);

  await verifyKnownSafeState();
  for (const add of lock.episodeAdds) {
    const season = await readSeason(add.slug, add.season);
    const row = season.rows.find(r => r.number === add.episode && equalText(r.title, add.name));
    if (!row) fail(`Final verification: missing ${add.target} S${add.season}E${add.episode}`);
    const meta = await readEpisodeMeta(add.slug, row.publicId);
    if (meta.airdate !== add.date) fail(`Final verification: wrong date for ${add.target} S${add.season}E${add.episode}`);
    if (add.runtimeMinutes != null && meta.runtimeMinutes !== add.runtimeMinutes) fail(`Final verification: wrong runtime for ${add.target} S${add.season}E${add.episode}`);
  }
  for (const item of lock.episodeEdits) {
    const season = await readSeason(item.slug, item.season);
    const row = season.rows.find(r => r.number === item.episode && r.publicId === String(item.publicId));
    if (!row) fail(`Final verification: mapping missing for ${item.target} ${item.publicId}`);
    const meta = await readEpisodeMeta(item.slug, item.publicId);
    if (item.desiredFirstAired != null && meta.airdate !== item.desiredFirstAired) fail(`Final verification: airdate mismatch ${item.target} ${item.publicId}`);
    if (item.desiredRuntimeMinutes != null && meta.runtimeMinutes !== item.desiredRuntimeMinutes) fail(`Final verification: runtime mismatch ${item.target} ${item.publicId}`);
    if (item.desiredTitle != null) {
      const translation = await readFrenchTranslation(item.slug, item.publicId);
      if (translation.title !== item.desiredTitle) fail(`Final verification: French title mismatch ${item.target} ${item.publicId}`);
    }
  }

  if (report.unexpectedPosts.length) fail(`Unexpected/destructive requests were blocked: ${report.unexpectedPosts.length}`);
  report.result = 'APPLIED_AND_VERIFIED';
} catch (error) {
  report.blocked.push(error?.stack || error?.message || String(error));
  report.result = report.writes.length ? 'PARTIAL_REVIEW_REQUIRED' : 'BLOCKED_BEFORE_WRITES';
} finally {
  await browser.close();
}

await fs.writeFile('reports/batch-apply-all-v2.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Armed: ${report.armed}`,
  `Authenticated: ${report.authenticated}`,
  `Result: ${report.result}`,
  `Preflight targets: ${report.preflight.length}`,
  `Writes: ${report.writes.length}`,
  `Skipped already-correct: ${report.skips.length}`,
  `Verifications: ${report.verifications.length}`,
  `Rollback attempts: ${report.rollbackAttempts.length}`,
  `Blocked unexpected requests: ${report.unexpectedPosts.length}`,
  ''
];
for (const p of report.preflight) lines.push(`PREFLIGHT | ${p.type} | ${p.target} | ${p.publicId || `S${p.season}E${p.episode}`} | ${p.state || JSON.stringify(p.needs)}`);
for (const w of report.writes) lines.push(`WRITE | ${w.type} | ${w.target} | ${w.publicId || `S${w.season}E${w.episode || '?'}`}`);
for (const s of report.skips) lines.push(`SKIP | ${s.type} | ${s.target} | ${s.publicId || `S${s.season}E${s.episode || '?'}`} | ${s.reason}`);
for (const r of report.rollbackAttempts) lines.push(`ROLLBACK | ${r.target} | S${r.season} | ok=${r.ok} | ${r.reason || ''}`);
for (const b of report.blocked) lines.push(`BLOCKED | ${String(b).split('\n')[0]}`);
await fs.writeFile('reports/batch-apply-all-v2.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (report.result !== 'APPLIED_AND_VERIFIED') process.exitCode = 2;
