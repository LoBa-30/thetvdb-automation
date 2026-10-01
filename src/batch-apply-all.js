import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const armed = String(process.env.TVDB_BATCH_APPLY || '').toLowerCase() === 'yes';
const lock = JSON.parse(await fs.readFile('config/apply-all-locks.json', 'utf8'));

await fs.mkdir('reports', { recursive: true });

const BASE = 'https://thetvdb.com';
const report = {
  generatedAt: new Date().toISOString(),
  mode: 'BATCH_APPLY_ALL_EXACT_ALLOWLIST',
  armed,
  authenticated: false,
  preflight: [],
  writes: [],
  skips: [],
  verifications: [],
  rollbackAttempts: [],
  blocked: [],
  result: 'NOT_STARTED',
  safety: {
    noDeletes: true,
    noUnassignedWrites: true,
    noJapanExpoAutomaticCreate: true,
    exactAllowlistOnly: true,
    preflightBeforeFirstWrite: true,
    stopOnStateDrift: true,
    verifyAfterEveryWrite: true
  }
};

function normalize(value = '') {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function equalText(a = '', b = '') {
  return a === b || normalize(a) === normalize(b);
}

function isContiguous(rows) {
  const nums = rows.map(r => r.number).sort((a, b) => a - b);
  return nums.every((n, i) => n === i + 1);
}

if (!armed) {
  report.result = 'BLOCKED_NOT_ARMED';
  await fs.writeFile('reports/batch-apply-all.json', JSON.stringify(report, null, 2));
  console.log('Batch apply-all is not armed. Set TVDB_BATCH_APPLY=yes explicitly.');
  process.exit(2);
}
if (!username || !password) {
  report.result = 'BLOCKED_MISSING_SECRETS';
  await fs.writeFile('reports/batch-apply-all.json', JSON.stringify(report, null, 2));
  console.log('Missing TVDB credentials.');
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    last = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (last && last.status() < 400) {
      await page.waitForTimeout(500);
      return last;
    }
    await page.waitForTimeout(attempt * 800);
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

async function readSeason(slug, season) {
  const editUrl = `${BASE}/series/${slug}/seasons/official/${season}/edit`;
  await goto(editUrl);
  const form = page.locator('form').filter({ has: page.locator('input[name="season_number"]') }).first();
  const action = await form.getAttribute('action').catch(() => null);
  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map((input, index) => {
    const name = input.getAttribute('name') || '';
    const internalId = name.match(/^episodes\[(\d+)\]$/)?.[1] || null;
    let container = input.closest('tr');
    if (!container) container = input.closest('.row');
    if (!container) container = input.parentElement?.parentElement || input.parentElement;
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
  return { slug, season, editUrl, action, rows };
}

async function readEpisodeEdit(slug, publicId, rowTitle = '') {
  const url = `${BASE}/series/${slug}/episodes/${publicId}/0/edit`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="airdate"], input[name="runtime"], input[name*="translation"], textarea[name*="translation"]') }).first();
  if (!(await form.count())) throw new Error(`Episode ${publicId}: edit form not found`);
  const action = await form.getAttribute('action').catch(() => null);
  if (!action || !action.includes(`/series/${slug}/season/official/episodes/${publicId}/update`)) {
    throw new Error(`Episode ${publicId}: unexpected update action ${action}`);
  }
  const fields = await form.locator('input, textarea, select').evaluateAll(nodes => nodes.map((node, index) => {
    const name = node.getAttribute('name');
    if (!name) return null;
    let value = '';
    if (node.tagName === 'SELECT') value = [...node.selectedOptions].map(o => o.value).join('|');
    else if (node.type === 'checkbox' || node.type === 'radio') value = node.checked ? node.value : '';
    else value = node.value || '';
    return { index, name, tag: node.tagName.toLowerCase(), type: node.type || '', value, visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length) };
  }).filter(Boolean));
  const byName = new Map(fields.map(f => [f.name, f]));
  const air = byName.get('airdate') || fields.find(f => /airdate/i.test(f.name));
  const runtime = byName.get('runtime') || fields.find(f => /runtime/i.test(f.name));
  const titleCandidates = fields.filter(f => f.visible && /name|title/i.test(f.name) && !/company|rating|tag/i.test(f.name));
  const titleField = titleCandidates.find(f => f.value === rowTitle)
    || titleCandidates.find(f => equalText(f.value, rowTitle))
    || null;
  return {
    url,
    action,
    fields,
    airdateFieldName: air?.name || null,
    airdate: air?.value || null,
    runtimeFieldName: runtime?.name || null,
    runtimeMinutes: runtime && /^\d+$/.test(String(runtime.value)) ? Number(runtime.value) : null,
    titleFieldName: titleField?.name || null,
    titleValue: titleField?.value || rowTitle || null
  };
}

async function bulkAddPreflight(add) {
  const url = `${BASE}/series/${add.slug}/seasons/official/${add.season}/bulkadd`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="number[]"]') }).first();
  if (!(await form.count())) throw new Error(`${add.target} ${add.season}: bulk-add form not found`);
  const action = await form.getAttribute('action');
  const expected = `/series/${add.slug}/seasons/official/${add.season}/savebulkadd`;
  if (action !== expected) throw new Error(`${add.target} ${add.season}: unexpected bulk-add action ${action}`);
  if ((await form.locator('input[name="number[]"]').count()) < 1 || (await form.locator('input[name="name[]"]').count()) < 1 || (await form.locator('input[name="date[]"]').count()) < 1) {
    throw new Error(`${add.target} ${add.season}: incomplete bulk-add fields`);
  }
  return { url, action };
}

async function inspectExactEdit(item) {
  const season = await readSeason(item.slug, item.season);
  const row = season.rows.find(r => r.number === item.episode);
  if (!row || row.publicId !== item.publicId) {
    throw new Error(`${item.target} S${item.season}E${item.episode}: expected TVDB ${item.publicId}, found ${row?.publicId || 'missing'}`);
  }
  const detail = await readEpisodeEdit(item.slug, item.publicId, row.title);
  const needs = {
    title: item.desiredTitle != null && row.title !== item.desiredTitle,
    firstAired: item.desiredFirstAired != null && detail.airdate !== item.desiredFirstAired,
    runtime: item.desiredRuntimeMinutes != null && detail.runtimeMinutes !== item.desiredRuntimeMinutes
  };
  if (needs.title && !detail.titleFieldName) throw new Error(`${item.target} ${item.publicId}: cannot identify the current title field safely`);
  if (needs.firstAired && !detail.airdateFieldName) throw new Error(`${item.target} ${item.publicId}: airdate field missing`);
  if (needs.runtime && !detail.runtimeFieldName) throw new Error(`${item.target} ${item.publicId}: runtime field missing`);
  return { item, row, detail, needs, any: Object.values(needs).some(Boolean) };
}

async function applyExactEdit(pre) {
  const { item } = pre;
  const season = await readSeason(item.slug, item.season);
  const row = season.rows.find(r => r.number === item.episode);
  if (!row || row.publicId !== item.publicId) throw new Error(`${item.target} ${item.publicId}: state drift before write`);
  const detail = await readEpisodeEdit(item.slug, item.publicId, row.title);
  if (pre.needs.title && detail.titleValue !== pre.detail.titleValue) throw new Error(`${item.target} ${item.publicId}: title changed since preflight`);
  if (pre.needs.firstAired && detail.airdate !== pre.detail.airdate) throw new Error(`${item.target} ${item.publicId}: airdate changed since preflight`);
  if (pre.needs.runtime && detail.runtimeMinutes !== pre.detail.runtimeMinutes) throw new Error(`${item.target} ${item.publicId}: runtime changed since preflight`);

  const form = page.locator('form').filter({ has: page.locator('input[name="airdate"], input[name="runtime"], input[name*="translation"], textarea[name*="translation"]') }).first();
  if (pre.needs.title) await form.locator(`[name="${CSS.escape(detail.titleFieldName)}"]`).fill(item.desiredTitle);
  if (pre.needs.firstAired) await form.locator(`[name="${CSS.escape(detail.airdateFieldName)}"]`).fill(item.desiredFirstAired);
  if (pre.needs.runtime) await form.locator(`[name="${CSS.escape(detail.runtimeFieldName)}"]`).fill(String(item.desiredRuntimeMinutes));
  const submit = form.locator('button[type="submit"], input[type="submit"]').last();
  if (!(await submit.isVisible().catch(() => false))) throw new Error(`${item.target} ${item.publicId}: submit button missing`);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(800);
  report.writes.push({ type: 'EDIT_EPISODE', target: item.target, publicId: item.publicId, season: item.season, episode: item.episode, changes: pre.needs });

  const verifySeason = await readSeason(item.slug, item.season);
  const verifyRow = verifySeason.rows.find(r => r.number === item.episode);
  if (!verifyRow || verifyRow.publicId !== item.publicId) throw new Error(`${item.target} ${item.publicId}: post-write episode mapping changed`);
  const verifyDetail = await readEpisodeEdit(item.slug, item.publicId, verifyRow.title);
  if (item.desiredTitle != null && verifyRow.title !== item.desiredTitle) throw new Error(`${item.target} ${item.publicId}: title verification failed (${verifyRow.title})`);
  if (item.desiredFirstAired != null && verifyDetail.airdate !== item.desiredFirstAired) throw new Error(`${item.target} ${item.publicId}: airdate verification failed (${verifyDetail.airdate})`);
  if (item.desiredRuntimeMinutes != null && verifyDetail.runtimeMinutes !== item.desiredRuntimeMinutes) throw new Error(`${item.target} ${item.publicId}: runtime verification failed (${verifyDetail.runtimeMinutes})`);
  report.verifications.push({ type: 'EPISODE_EDIT', target: item.target, publicId: item.publicId, ok: true });
}

async function inspectAdd(add) {
  const season = await readSeason(add.slug, add.season);
  const byTitle = season.rows.find(r => equalText(r.title, add.name));
  if (byTitle) {
    if (byTitle.number !== add.episode) throw new Error(`${add.target} ${add.season}: existing target title is E${byTitle.number}, expected E${add.episode}`);
    const detail = await readEpisodeEdit(add.slug, byTitle.publicId, byTitle.title);
    if (detail.airdate !== add.date) throw new Error(`${add.target} ${add.season}E${add.episode}: existing target date ${detail.airdate}, expected ${add.date}`);
    if (add.runtimeMinutes != null && detail.runtimeMinutes !== add.runtimeMinutes) throw new Error(`${add.target} ${add.season}E${add.episode}: existing target runtime ${detail.runtimeMinutes}, expected ${add.runtimeMinutes}`);
    return { add, state: 'ALREADY_PRESENT', season, row: byTitle, detail };
  }

  if (!isContiguous(season.rows)) throw new Error(`${add.target} ${add.season}: current numbering is not contiguous`);
  await bulkAddPreflight(add);

  if (add.mode === 'APPEND') {
    if (season.rows.length !== add.expectedSeasonCountBefore) throw new Error(`${add.target} ${add.season}: expected ${add.expectedSeasonCountBefore} episodes, found ${season.rows.length}`);
    const last = season.rows.at(-1);
    if (!last || last.number !== add.episode - 1) throw new Error(`${add.target} ${add.season}: expected last episode E${add.episode - 1}`);
    const lastDetail = await readEpisodeEdit(add.slug, last.publicId, last.title);
    if (add.expectedPreviousLastAirdate && lastDetail.airdate !== add.expectedPreviousLastAirdate) throw new Error(`${add.target} ${add.season}: previous last airdate drift (${lastDetail.airdate})`);
    if (lastDetail.airdate && add.date <= lastDetail.airdate) throw new Error(`${add.target} ${add.season}: append date ${add.date} is not after last airdate ${lastDetail.airdate}`);
    return { add, state: 'READY_APPEND', season, last, lastDetail };
  }

  if (add.mode === 'INSERT_SHIFT_FROM_17') {
    const prev = season.rows.find(r => r.number === add.expectedPreviousEpisode);
    const next = season.rows.find(r => r.number === add.expectedNextEpisode);
    if (!prev || !next) throw new Error(`${add.target} ${add.season}: insertion neighbors missing`);
    const prevDetail = await readEpisodeEdit(add.slug, prev.publicId, prev.title);
    const nextDetail = await readEpisodeEdit(add.slug, next.publicId, next.title);
    if (prevDetail.airdate !== add.expectedPreviousAirdate || nextDetail.airdate !== add.expectedNextAirdate) {
      throw new Error(`${add.target} ${add.season}: insertion neighbor dates drift (${prevDetail.airdate}, ${nextDetail.airdate})`);
    }
    if (!(prevDetail.airdate < add.date && add.date < nextDetail.airdate)) throw new Error(`${add.target} ${add.season}: insertion date is not between E${prev.number} and E${next.number}`);
    if (!season.action || !season.action.includes(`/series/${add.slug}/official/`) || !season.action.endsWith('/saveseason')) throw new Error(`${add.target} ${add.season}: unsafe season-save action ${season.action}`);
    const shiftRows = season.rows.filter(r => r.number >= add.episode).map(r => ({ publicId: r.publicId, internalId: r.internalId, from: r.number, to: r.number + 1 }));
    if (!shiftRows.length) throw new Error(`${add.target} ${add.season}: no rows to shift`);
    return { add, state: 'READY_INSERT', season, prev, next, prevDetail, nextDetail, shiftRows };
  }

  throw new Error(`${add.target}: unsupported add mode ${add.mode}`);
}

async function submitBulkAdd(add) {
  const url = `${BASE}/series/${add.slug}/seasons/official/${add.season}/bulkadd`;
  await goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[name="number[]"]') }).first();
  const action = await form.getAttribute('action');
  const expected = `/series/${add.slug}/seasons/official/${add.season}/savebulkadd`;
  if (action !== expected) throw new Error(`${add.target} ${add.season}: bulk-add action drift ${action}`);
  await form.locator('input[name="number[]"]').first().fill(String(add.episode));
  await form.locator('input[name="name[]"]').first().fill(add.name);
  await form.locator('input[name="date[]"]').first().fill(add.date);
  const runtime = form.locator('input[name="runtime[]"]').first();
  if (await runtime.count()) await runtime.fill(add.runtimeMinutes != null ? String(add.runtimeMinutes) : '');
  const submit = form.locator('button:has-text("Add Episodes"), button[type="submit"], input[type="submit"]').last();
  if (!(await submit.isVisible().catch(() => false))) throw new Error(`${add.target} ${add.season}: bulk-add submit missing`);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(900);
  report.writes.push({ type: 'ADD_EPISODE', target: add.target, season: add.season, episode: add.episode, name: add.name, date: add.date });
}

async function verifyAdded(add, expectedCount) {
  const season = await readSeason(add.slug, add.season);
  if (season.rows.length !== expectedCount) throw new Error(`${add.target} ${add.season}: expected ${expectedCount} episodes after add, found ${season.rows.length}`);
  if (!isContiguous(season.rows)) throw new Error(`${add.target} ${add.season}: numbering not contiguous after add`);
  const row = season.rows.find(r => r.number === add.episode);
  if (!row || !equalText(row.title, add.name)) throw new Error(`${add.target} ${add.season}E${add.episode}: added episode title/number verification failed`);
  const detail = await readEpisodeEdit(add.slug, row.publicId, row.title);
  if (detail.airdate !== add.date) throw new Error(`${add.target} ${add.season}E${add.episode}: added date verification failed (${detail.airdate})`);
  if (add.runtimeMinutes != null && detail.runtimeMinutes !== add.runtimeMinutes) throw new Error(`${add.target} ${add.season}E${add.episode}: added runtime verification failed (${detail.runtimeMinutes})`);
  report.verifications.push({ type: 'ADD_EPISODE', target: add.target, season: add.season, episode: add.episode, publicId: row.publicId, ok: true });
  return row;
}

async function submitSeasonShift(pre, direction = 'forward') {
  const add = pre.add;
  const season = await readSeason(add.slug, add.season);
  const shift = pre.shiftRows;
  for (const map of shift) {
    const row = season.rows.find(r => r.publicId === map.publicId);
    const expected = direction === 'forward' ? map.from : map.to;
    if (!row || row.number !== expected) throw new Error(`${add.target} ${add.season}: state drift for ${map.publicId}; expected E${expected}, found E${row?.number ?? '?'}`);
  }
  for (const map of shift) {
    const row = season.rows.find(r => r.publicId === map.publicId);
    const target = direction === 'forward' ? map.to : map.from;
    await page.locator(`input[name="episodes[${row.internalId}]"]`).fill(String(target));
  }
  const form = page.locator('form').filter({ has: page.locator('input[name="season_number"]') }).first();
  const action = await form.getAttribute('action');
  if (!action || !action.includes(`/series/${add.slug}/official/`) || !action.endsWith('/saveseason')) throw new Error(`${add.target} ${add.season}: season-save action drift ${action}`);
  const submit = form.locator('button[type="submit"], input[type="submit"]').last();
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(900);
  report.writes.push({ type: direction === 'forward' ? 'SHIFT_SEASON' : 'ROLLBACK_SHIFT_SEASON', target: add.target, season: add.season, fromEpisode: add.episode, direction });
  const verify = await readSeason(add.slug, add.season);
  for (const map of shift) {
    const row = verify.rows.find(r => r.publicId === map.publicId);
    const expected = direction === 'forward' ? map.to : map.from;
    if (!row || row.number !== expected) throw new Error(`${add.target} ${add.season}: ${direction} shift verification failed for ${map.publicId}`);
  }
  return verify;
}

async function applyAddition(pre) {
  const add = pre.add;
  if (pre.state === 'ALREADY_PRESENT') {
    report.skips.push({ type: 'ADD_EPISODE', target: add.target, season: add.season, episode: add.episode, reason: 'already correct' });
    report.verifications.push({ type: 'ADD_EPISODE_ALREADY_PRESENT', target: add.target, season: add.season, episode: add.episode, publicId: pre.row.publicId, ok: true });
    return;
  }
  if (pre.state === 'READY_APPEND') {
    await submitBulkAdd(add);
    await verifyAdded(add, pre.season.rows.length + 1);
    return;
  }
  if (pre.state === 'READY_INSERT') {
    const beforeCount = pre.season.rows.length;
    await submitSeasonShift(pre, 'forward');
    try {
      await submitBulkAdd(add);
      await verifyAdded(add, beforeCount + 1);
    } catch (error) {
      try {
        const current = await readSeason(add.slug, add.season);
        if (current.rows.length === beforeCount) {
          await submitSeasonShift(pre, 'rollback');
          report.rollbackAttempts.push({ target: add.target, season: add.season, ok: true, reason: 'Add failed before a new episode was present.' });
        } else {
          report.rollbackAttempts.push({ target: add.target, season: add.season, ok: false, reason: `Unsafe rollback: season now has ${current.rows.length} episodes.` });
        }
      } catch (rollbackError) {
        report.rollbackAttempts.push({ target: add.target, season: add.season, ok: false, reason: rollbackError?.message || String(rollbackError) });
      }
      throw error;
    }
  }
}

async function verifyKnownSafeState() {
  const dj = await readSeason('djilsi', 2026);
  if (dj.rows.length !== 17 || dj.rows.find(r => r.number === 11)?.publicId !== '12014131' || dj.rows.find(r => r.number === 17)?.publicId !== '12014132') throw new Error('Djilsi 2026 known post-apply state drift');

  const r18 = await readSeason('raska', 2018);
  if (!isContiguous(r18.rows) || r18.rows.length !== 13 || r18.rows.find(r => r.number === 2)?.publicId !== '11979236' || r18.rows.find(r => r.number === 3)?.publicId !== '11960842') throw new Error('Raska 2018 numbering drift');

  const r23 = await readSeason('raska', 2023);
  if (!isContiguous(r23.rows) || r23.rows.length !== 28 || r23.rows.find(r => r.number === 19)?.publicId !== '11978003' || r23.rows.find(r => r.number === 20)?.publicId !== '11960814') throw new Error('Raska 2023 numbering drift');

  const r17 = await readSeason('raska', 2017);
  const e4 = r17.rows.find(r => r.number === 4);
  if (!e4 || e4.publicId !== '11960840') throw new Error('Raska 2017 E04 mapping drift');
  const e4d = await readEpisodeEdit('raska', e4.publicId, e4.title);
  if (e4.title !== 'LE RAP FÉMININ EN FORCE ! ✊' || e4d.airdate !== '2017-11-19' || e4d.runtimeMinutes !== 8) throw new Error('Raska 2017 E04 no longer matches verified title/date/runtime');

  report.verifications.push({ type: 'KNOWN_SAFE_STATE', targets: ['Djilsi 2026', 'Raska 2018', 'Raska 2023', 'Raska 2017 E04'], ok: true });
}

let exactPre = [];
let addPre = [];

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session could not be proven.');

  // Global read-only preflight. Nothing is written until every allowlisted target is proven safe.
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

  report.verifications.push({ type: 'GLOBAL_PREFLIGHT_COMPLETE_BEFORE_FIRST_WRITE', ok: true, editTargets: exactPre.length, addTargets: addPre.length });

  // Riskier structural insertion first; it has an automatic rollback only if no episode was created.
  const mastu2021 = addPre.find(x => x.add.target === 'Mastu' && x.add.season === 2021);
  if (mastu2021) await applyAddition(mastu2021);

  // Independent append-only additions.
  for (const pre of addPre.filter(x => !(x.add.target === 'Mastu' && x.add.season === 2021))) await applyAddition(pre);

  // Exact episode edits. Already-correct rows are skipped.
  for (const pre of exactPre) {
    if (!pre.any) {
      report.skips.push({ type: 'EDIT_EPISODE', target: pre.item.target, publicId: pre.item.publicId, reason: 'already correct' });
      continue;
    }
    await applyExactEdit(pre);
  }

  // Final targeted verification after every requested operation.
  await verifyKnownSafeState();
  for (const add of lock.episodeAdds) {
    const season = await readSeason(add.slug, add.season);
    const row = season.rows.find(r => r.number === add.episode && equalText(r.title, add.name));
    if (!row) throw new Error(`Final verification: missing ${add.target} S${add.season}E${add.episode}`);
    const detail = await readEpisodeEdit(add.slug, row.publicId, row.title);
    if (detail.airdate !== add.date) throw new Error(`Final verification: wrong date for ${add.target} S${add.season}E${add.episode}`);
  }
  for (const item of lock.episodeEdits) {
    const season = await readSeason(item.slug, item.season);
    const row = season.rows.find(r => r.number === item.episode && r.publicId === item.publicId);
    if (!row) throw new Error(`Final verification: mapping missing for ${item.target} ${item.publicId}`);
    const detail = await readEpisodeEdit(item.slug, item.publicId, row.title);
    if (item.desiredTitle != null && row.title !== item.desiredTitle) throw new Error(`Final verification: title mismatch ${item.target} ${item.publicId}`);
    if (item.desiredFirstAired != null && detail.airdate !== item.desiredFirstAired) throw new Error(`Final verification: airdate mismatch ${item.target} ${item.publicId}`);
    if (item.desiredRuntimeMinutes != null && detail.runtimeMinutes !== item.desiredRuntimeMinutes) throw new Error(`Final verification: runtime mismatch ${item.target} ${item.publicId}`);
  }

  report.result = 'APPLIED_AND_VERIFIED';
} catch (error) {
  report.blocked.push(error?.stack || error?.message || String(error));
  report.result = report.writes.length ? 'PARTIAL_REVIEW_REQUIRED' : 'BLOCKED_BEFORE_WRITES';
} finally {
  await browser.close();
}

await fs.writeFile('reports/batch-apply-all.json', JSON.stringify(report, null, 2));
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
  ''
];
for (const p of report.preflight) lines.push(`PREFLIGHT | ${p.type} | ${p.target} | ${p.publicId || `S${p.season}E${p.episode}`} | ${p.state || JSON.stringify(p.needs)}`);
for (const w of report.writes) lines.push(`WRITE | ${w.type} | ${w.target} | ${w.publicId || `S${w.season}E${w.episode || '?'}`}`);
for (const s of report.skips) lines.push(`SKIP | ${s.type} | ${s.target} | ${s.publicId || `S${s.season}E${s.episode || '?'}`} | ${s.reason}`);
for (const r of report.rollbackAttempts) lines.push(`ROLLBACK | ${r.target} | S${r.season} | ok=${r.ok} | ${r.reason}`);
for (const b of report.blocked) lines.push(`BLOCKED | ${String(b).split('\n')[0]}`);
await fs.writeFile('reports/batch-apply-all.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (report.result !== 'APPLIED_AND_VERIFIED') process.exitCode = 2;
