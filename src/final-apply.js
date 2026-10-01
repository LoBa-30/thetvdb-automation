import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const armed = String(process.env.TVDB_FINAL_APPLY || '').toLowerCase() === 'yes';

await fs.mkdir('reports', { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'FINAL_APPLY_EXACT_ALLOWLIST',
  armed,
  authenticated: false,
  writes: [],
  verifications: [],
  rollbackAttempts: [],
  result: 'NOT_STARTED',
  safety: {
    destructiveDeletesAllowed: false,
    arbitrarySeriesAllowed: false,
    exactAllowlistOnly: true,
    stopOnStateDrift: true,
    verifyAfterEveryWrite: true
  }
};

const BASE = 'https://thetvdb.com';

const SEASON_PLANS = [
  {
    target: 'Raska', slug: 'raska', season: 2018,
    editUrl: `${BASE}/series/raska/seasons/official/2018/edit`,
    expectedCount: 13,
    changes: [
      ['11960842', 2, 3], ['11960843', 3, 4], ['11960844', 4, 5], ['11960845', 5, 6],
      ['11960846', 6, 7], ['11960847', 7, 8], ['11960848', 8, 9], ['11960849', 9, 10],
      ['11960850', 10, 11], ['11960851', 11, 12], ['11960852', 12, 13]
    ],
    anchors: [['11960841', 1], ['11979236', 2]]
  },
  {
    target: 'Raska', slug: 'raska', season: 2023,
    editUrl: `${BASE}/series/raska/seasons/official/2023/edit`,
    expectedCount: 28,
    changes: [
      ['11960814', 19, 20], ['11960815', 20, 21], ['11960816', 21, 22], ['11960817', 22, 23],
      ['11960818', 23, 24], ['11960819', 24, 25], ['11960820', 25, 26], ['11960821', 26, 27],
      ['11960835', 27, 28]
    ],
    anchors: [['11960813', 18], ['11978003', 19]]
  },
  {
    target: 'Djilsi', slug: 'djilsi', season: 2026,
    editUrl: `${BASE}/series/djilsi/seasons/official/2026/edit`,
    expectedCount: 15,
    changes: [
      ['11964028', 11, 12], ['11971086', 12, 13], ['11976892', 13, 14], ['11998871', 14, 15], ['11998872', 15, 16]
    ],
    anchors: [['11962149', 10]]
  }
];

const DJILSI_ADDITIONS = [
  {
    number: 11,
    name: 'RDV LE SAMEDI 5 SEPTEMBRE À 11H... 🫶🏻',
    date: '2026-08-24',
    youtubeUrl: 'https://www.youtube.com/watch?v=uMmwt8l0FtM'
  },
  {
    number: 17,
    name: 'Une fin d’aventure pleine de rebondissements… - ON VA OÙ 7 ep6 FINAL',
    date: '2026-09-23',
    youtubeUrl: 'https://www.youtube.com/watch?v=ersw34RPmZ8'
  }
];

if (!armed) {
  report.result = 'BLOCKED_NOT_ARMED';
  await fs.writeFile('reports/final-apply.json', JSON.stringify(report, null, 2));
  console.log('Final apply is not armed. Set TVDB_FINAL_APPLY=yes explicitly.');
  process.exit(2);
}
if (!username || !password) {
  report.result = 'BLOCKED_MISSING_SECRETS';
  await fs.writeFile('reports/final-apply.json', JSON.stringify(report, null, 2));
  console.log('Missing TVDB credentials in GitHub Actions secrets.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
});
const page = await context.newPage();

async function login() {
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  const email = form.locator('input[name="email"]').first();
  const pass = form.locator('input[name="password"]').first();
  const submit = form.locator('button[type="submit"], input[type="submit"]').first();
  if (!(await email.isVisible().catch(() => false)) || !(await pass.isVisible().catch(() => false)) || !(await submit.isVisible().catch(() => false))) return false;
  await email.fill(username);
  await pass.fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit.click()]);
  await page.waitForTimeout(1000);
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

async function readSeason(def) {
  const response = await page.goto(def.editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (!response || response.status() >= 400) throw new Error(`${def.target} ${def.season}: edit page unavailable (${response?.status() ?? 'n/a'})`);
  await page.waitForTimeout(500);
  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map(input => {
    const name = input.getAttribute('name') || '';
    const internalId = name.match(/^episodes\[(\d+)\]$/)?.[1] || null;
    let container = input.closest('tr');
    if (!container) container = input.closest('.row');
    if (!container) container = input.parentElement?.parentElement || input.parentElement;
    const anchor = container?.querySelector('a[href*="/episodes/"]') || null;
    const href = anchor?.href || '';
    return {
      internalId,
      publicId: href.match(/\/episodes\/(\d+)/)?.[1] || null,
      title: (anchor?.textContent || '').replace(/\s+/g, ' ').trim(),
      number: Number(input.value)
    };
  }));
  return rows;
}

function validateExpectedState(def, rows, useNewNumbers = false) {
  if (rows.length !== def.expectedCount) throw new Error(`${def.target} ${def.season}: expected ${def.expectedCount} episodes, found ${rows.length}`);
  const byPublicId = new Map(rows.map(r => [r.publicId, r]));
  for (const [id, oldN, newN] of def.changes) {
    const row = byPublicId.get(id);
    if (!row) throw new Error(`${def.target} ${def.season}: expected episode ${id} not found`);
    const expected = useNewNumbers ? newN : oldN;
    if (row.number !== expected) throw new Error(`${def.target} ${def.season}: state drift for ${id}; expected E${expected}, found E${row.number}`);
  }
  for (const [id, n] of def.anchors) {
    const row = byPublicId.get(id);
    if (!row || row.number !== n) throw new Error(`${def.target} ${def.season}: anchor ${id} expected E${n}, found ${row?.number ?? 'missing'}`);
  }
  return byPublicId;
}

async function submitSeasonRenumber(def, direction = 'forward') {
  const rows = await readSeason(def);
  const forward = direction === 'forward';
  const byPublicId = validateExpectedState(def, rows, !forward);

  for (const [publicId, oldN, newN] of def.changes) {
    const row = byPublicId.get(publicId);
    const targetN = forward ? newN : oldN;
    await page.locator(`input[name="episodes[${row.internalId}]" ]`).fill(String(targetN));
  }

  const form = page.locator('form').filter({ has: page.locator('input[name="season_number"]') }).first();
  const submit = form.locator('button[type="submit"], input[type="submit"]').last();
  if (!(await submit.isVisible().catch(() => false))) throw new Error(`${def.target} ${def.season}: season save button not found`);
  const action = await form.getAttribute('action');
  if (!action || !action.includes(`/series/${def.slug}/official/`) || !action.endsWith('/saveseason')) throw new Error(`${def.target} ${def.season}: unexpected season form action ${action}`);

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submit.click()
  ]);
  await page.waitForTimeout(900);
  report.writes.push({ type: forward ? 'RENUMBER_SEASON' : 'ROLLBACK_RENUMBER_SEASON', target: def.target, season: def.season, changes: def.changes.map(([id, oldN, newN]) => ({ id, from: forward ? oldN : newN, to: forward ? newN : oldN })) });

  const verifyRows = await readSeason(def);
  validateExpectedState(def, verifyRows, forward);
  report.verifications.push({ target: def.target, season: def.season, type: 'SEASON_NUMBERING', ok: true, direction });
}

async function addDjilsiEpisodes() {
  const url = `${BASE}/series/djilsi/seasons/official/2026/bulkadd`;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (!response || response.status() >= 400) throw new Error(`Djilsi bulkadd unavailable (${response?.status() ?? 'n/a'})`);
  await page.waitForTimeout(500);

  const form = page.locator('form').filter({ has: page.locator('input[name="number[]"]') }).first();
  const action = await form.getAttribute('action');
  if (action !== '/series/djilsi/seasons/official/2026/savebulkadd') throw new Error(`Unexpected Djilsi bulkadd action: ${action}`);

  let numbers = form.locator('input[name="number[]"]');
  if (await numbers.count() < 2) {
    const addAnother = form.locator('button:has-text("Add Another"), a:has-text("Add Another")').first();
    if (!(await addAnother.isVisible().catch(() => false))) throw new Error('Djilsi bulkadd: Add Another control not found');
    await addAnother.click();
    await page.waitForTimeout(250);
  }

  numbers = form.locator('input[name="number[]"]');
  const names = form.locator('input[name="name[]"]');
  const dates = form.locator('input[name="date[]"]');
  const runtimes = form.locator('input[name="runtime[]"]');
  if ((await numbers.count()) < 2 || (await names.count()) < 2 || (await dates.count()) < 2) throw new Error('Djilsi bulkadd: two episode rows are not available');

  for (let i = 0; i < DJILSI_ADDITIONS.length; i += 1) {
    const item = DJILSI_ADDITIONS[i];
    await numbers.nth(i).fill(String(item.number));
    await names.nth(i).fill(item.name);
    await dates.nth(i).fill(item.date);
    if ((await runtimes.count()) > i) await runtimes.nth(i).fill('');
  }

  const submit = form.locator('button:has-text("Add Episodes"), button[type="submit"], input[type="submit"]').last();
  if (!(await submit.isVisible().catch(() => false))) throw new Error('Djilsi bulkadd: submit button not found');
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submit.click()
  ]);
  await page.waitForTimeout(1000);
  report.writes.push({ type: 'ADD_EPISODES', target: 'Djilsi', season: 2026, episodes: DJILSI_ADDITIONS });
}

async function verifyDjilsiFinal() {
  const response = await page.goto(`${BASE}/series/djilsi/seasons/official/2026`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (!response || response.status() >= 400) throw new Error('Djilsi 2026 verification page unavailable');
  await page.waitForTimeout(500);
  const body = await page.locator('body').innerText();
  for (const item of DJILSI_ADDITIONS) {
    if (!body.includes(item.name)) throw new Error(`Djilsi verification failed: added title missing: ${item.name}`);
  }
  const editDef = SEASON_PLANS.find(x => x.target === 'Djilsi');
  const rows = await readSeason(editDef);
  if (rows.length !== 17) throw new Error(`Djilsi verification failed: expected 17 episodes after additions, found ${rows.length}`);
  const numbers = rows.map(r => r.number).sort((a, b) => a - b);
  const expected = Array.from({ length: 17 }, (_, i) => i + 1);
  if (numbers.join(',') !== expected.join(',')) throw new Error(`Djilsi verification failed: numbering is not contiguous 1..17 (${numbers.join(',')})`);
  report.verifications.push({ target: 'Djilsi', season: 2026, type: 'FINAL_17_EPISODES_CONTIGUOUS', ok: true });
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session could not be proven.');

  // Preflight every target before the first write. If anything changed since the dry-run, abort with zero writes.
  for (const def of SEASON_PLANS) {
    const rows = await readSeason(def);
    validateExpectedState(def, rows, false);
  }
  report.verifications.push({ type: 'GLOBAL_PREFLIGHT_STATE_MATCH', ok: true });

  // Fix Raska independently and verify each atomic season save.
  await submitSeasonRenumber(SEASON_PLANS[0], 'forward');
  await submitSeasonRenumber(SEASON_PLANS[1], 'forward');

  // Djilsi: make E11 available, then add both approved episodes in a single bulk-add.
  const djilsiPlan = SEASON_PLANS[2];
  await submitSeasonRenumber(djilsiPlan, 'forward');
  try {
    await addDjilsiEpisodes();
    await verifyDjilsiFinal();
  } catch (error) {
    // If the add did not complete, attempt to restore Djilsi numbering only when the page still has 15 episodes.
    try {
      const rows = await readSeason(djilsiPlan);
      if (rows.length === 15) {
        await submitSeasonRenumber(djilsiPlan, 'rollback');
        report.rollbackAttempts.push({ target: 'Djilsi', season: 2026, ok: true, reason: 'Bulk-add failed before new episodes were present.' });
      } else {
        report.rollbackAttempts.push({ target: 'Djilsi', season: 2026, ok: false, reason: `Not safe to rollback automatically because season now has ${rows.length} episodes.` });
      }
    } catch (rollbackError) {
      report.rollbackAttempts.push({ target: 'Djilsi', season: 2026, ok: false, reason: rollbackError?.message || String(rollbackError) });
    }
    throw error;
  }

  report.result = 'APPLIED_AND_VERIFIED';
} catch (error) {
  report.result = report.writes.length ? 'PARTIAL_OR_FAILED_REVIEW_REQUIRED' : 'BLOCKED_BEFORE_WRITES';
  report.error = error?.message || String(error);
} finally {
  await browser.close();
}

await fs.writeFile('reports/final-apply.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Armed: ${report.armed}`,
  `Authenticated: ${report.authenticated}`,
  `Result: ${report.result}`,
  `Writes recorded: ${report.writes.length}`,
  `Verifications: ${report.verifications.length}`,
  `Rollback attempts: ${report.rollbackAttempts.length}`
];
for (const write of report.writes) lines.push(`WRITE ${write.type} | ${write.target} ${write.season}`);
for (const check of report.verifications) lines.push(`VERIFY ${check.type} | ${check.target || 'GLOBAL'} ${check.season || ''} | ok=${check.ok}`);
for (const rollback of report.rollbackAttempts) lines.push(`ROLLBACK ${rollback.target} ${rollback.season} | ok=${rollback.ok} | ${rollback.reason}`);
if (report.error) lines.push(`ERROR: ${report.error}`);
await fs.writeFile('reports/final-apply.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (report.result !== 'APPLIED_AND_VERIFIED') process.exitCode = 2;
