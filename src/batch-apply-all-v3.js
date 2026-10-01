import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const armed = String(process.env.TVDB_BATCH_APPLY || '').toLowerCase() === 'yes';
const BASE = 'https://thetvdb.com';

const SAFE_EDITS = [
  { target: 'Djilsi', slug: 'djilsi', season: 2026, episode: 17, publicId: '12014132', runtime: 62 },
  { target: 'Joyca', slug: '335805-show', season: 2026, episode: 7, publicId: '11719791', title: 'ON TESTE 31 FROMAGES BIZARRES ! (ft. McFly et Carlito)' },
  { target: 'Joyca', slug: '335805-show', season: 2026, episode: 8, publicId: '11749116', title: 'BLOQUÉS À LA PORTE ! (Avec Seb et Sofyan)', runtime: 59 },
  { target: 'Joyca', slug: '335805-show', season: 2026, episode: 14, publicId: '11908448', title: 'ON CLASSE TOUS LES BILLETS DU MONDE (Avec Mcfly & Carlito et Mathieu)', runtime: 112 },
  { target: 'Mcfly & Carlito', slug: '338282-show', season: 2024, episode: 63, publicId: '10714431', airdate: '2024-09-05' },
  { target: 'Mcfly & Carlito', slug: '338282-show', season: 2026, episode: 8, publicId: '11595720', title: 'La moins bonne vidéo de la chaîne ? (Mcfly et les autres ont détesté mais Carl a aimé)' },
  { target: 'Mcfly & Carlito', slug: '338282-show', season: 2026, episode: 30, publicId: '11792871', runtime: 88 }
];

const EMOJI_SKIPS = [
  { target: 'Djilsi', publicId: '12014131', desired: 'RDV LE SAMEDI 5 SEPTEMBRE À 11H... 🫶🏻' },
  { target: 'Raska', publicId: '11960839', desired: 'KRISY RAPPEUR ET PRODUCTEUR DE DAMSO ! 🖖' },
  { target: 'Mcfly & Carlito', publicId: '9381309', desired: 'Qui est le papa de qui ? Préparez les 🍿 ainsi que les 🤧' },
  { target: 'Mcfly & Carlito', publicId: '10677628', desired: 'Podcartes Feat. Océane 🌷#2' },
  { target: 'Mcfly & Carlito', publicId: '11614913', desired: 'Quel couple se connaît le mieux ? Avec Erika et Tif 💜 (y’a TOUT dans cette vidéo)' },
  { target: 'Mcfly & Carlito', publicId: '11879094', desired: 'On classe 32 friandises de cinéma avec Florent Bernard & Seb Vaniček (Mcfly n’aime pas le popcorn 🍿)' }
];

const ALREADY_ADDED = [
  { target: 'Mastu', slug: '346011-show', season: 2021, episode: 17, publicId: '12014527', title: 'JE REGARDE UN EPISODE DE NEXT (10 ans après) #8', airdate: '2021-06-26' },
  { target: 'Elian Ventre', slug: 'elian-ventre-462729', season: 2026, episode: 8, publicId: '12014528', title: "On s'affronte pour construire la meilleure cabane ! ft. Maxime Biaggi", airdate: '2026-09-30' },
  { target: 'Mastu', slug: '346011-show', season: 2026, episode: 15, publicId: '12014529', title: 'LA TABLE INFERNALE 2 (Avec Byilhan, Flamby et Elian)', airdate: '2026-09-19', runtime: 49 }
];

await fs.mkdir('reports', { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  mode: 'BATCH_APPLY_ALL_V3_SAFE_RESUME',
  armed,
  authenticated: false,
  preflight: [],
  writes: [],
  skips: EMOJI_SKIPS.map(x => ({ ...x, reason: 'SKIPPED_BACKEND_EMOJI_UNSUPPORTED' })),
  verifications: [],
  blocked: [],
  result: 'NOT_STARTED'
};

function fail(msg) { throw new Error(msg); }
function same(a = '', b = '') { return String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim(); }
function hasAstralEmoji(text = '') { return /[\u{10000}-\u{10FFFF}]/u.test(text); }

if (!armed) fail('TVDB_BATCH_APPLY is not armed');
if (!username || !password) fail('Missing TVDB credentials');
if (SAFE_EDITS.some(x => x.title && hasAstralEmoji(x.title))) fail('Unsafe configuration: emoji title found in SAFE_EDITS');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36' });
const page = await context.newPage();

async function goto(url) {
  let last;
  for (let i = 1; i <= 4; i++) {
    last = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (last && last.status() < 400) { await page.waitForTimeout(500); return; }
    await page.waitForTimeout(i * 700);
  }
  fail(`GET failed ${url} (${last?.status() ?? 'n/a'})`);
}

async function login() {
  await goto(`${BASE}/auth/login`);
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  await form.locator('input[name="email"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), form.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(700);
  const probe = await context.request.get(`${BASE}/auth/getuser`).catch(() => null);
  return Boolean(probe?.ok());
}

async function readSeason(slug, season) {
  await goto(`${BASE}/series/${slug}/seasons/official/${season}/edit`);
  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map(input => {
    const box = input.closest('tr') || input.closest('.row') || input.parentElement?.parentElement || input.parentElement;
    const a = box?.querySelector('a[href*="/episodes/"]');
    return {
      number: Number(input.value),
      publicId: (a?.href || '').match(/\/episodes\/(\d+)/)?.[1] || null,
      title: (a?.textContent || '').replace(/\s+/g, ' ').trim()
    };
  }));
  return rows.sort((a,b) => a.number - b.number);
}

async function readMeta(slug, publicId) {
  await goto(`${BASE}/series/${slug}/episodes/${publicId}/0/edit`);
  const form = page.locator('form').filter({ has: page.locator('input[name="airdate"],input[name="runtime"]') }).first();
  if (!(await form.count())) fail(`Meta form missing for ${publicId}`);
  const action = await form.getAttribute('action');
  if (!action || !action.includes(`/series/${slug}/season/official/episodes/${publicId}/update`)) fail(`Unexpected meta action for ${publicId}: ${action}`);
  const air = form.locator('input[name="airdate"]').first();
  const runtime = form.locator('input[name="runtime"]').first();
  return {
    actionUrl: new URL(action, BASE).href,
    airdate: await air.inputValue().catch(() => ''),
    runtime: Number(await runtime.inputValue().catch(() => '')),
    form
  };
}

async function readTranslation(slug, publicId) {
  await goto(`${BASE}/series/${slug}/episodes/${publicId}/translate/fra/0/single`);
  const form = page.locator('form').filter({ has: page.locator('input[name="episode_name"]') }).first();
  if (!(await form.count())) fail(`French translation form missing for ${publicId}`);
  const action = await form.getAttribute('action');
  const language = await form.locator('[name="language"]').inputValue().catch(() => '');
  if (action !== '/episodes/translatestore' || language !== 'fra') fail(`Unexpected translation form for ${publicId}`);
  return { actionUrl: `${BASE}/episodes/translatestore`, title: await form.locator('input[name="episode_name"]').inputValue(), form };
}

async function verifyExistingAdds() {
  for (const x of ALREADY_ADDED) {
    const rows = await readSeason(x.slug, x.season);
    const row = rows.find(r => r.number === x.episode);
    if (!row || row.publicId !== x.publicId || !same(row.title, x.title)) fail(`Previously-added episode drift: ${x.target} S${x.season}E${x.episode}`);
    const meta = await readMeta(x.slug, x.publicId);
    if (meta.airdate !== x.airdate) fail(`Previously-added airdate drift: ${x.target} S${x.season}E${x.episode}`);
    if (x.runtime != null && meta.runtime !== x.runtime) fail(`Previously-added runtime drift: ${x.target} S${x.season}E${x.episode}`);
    report.verifications.push({ type: 'PREVIOUS_ADD_STILL_CORRECT', target: x.target, season: x.season, episode: x.episode, publicId: x.publicId, ok: true });
  }
}

async function preflightEdit(x) {
  const rows = await readSeason(x.slug, x.season);
  const row = rows.find(r => r.number === x.episode);
  if (!row || row.publicId !== x.publicId) fail(`Mapping drift ${x.target} S${x.season}E${x.episode}`);
  const meta = await readMeta(x.slug, x.publicId);
  const translation = x.title ? await readTranslation(x.slug, x.publicId) : null;
  const needs = {
    title: Boolean(x.title && translation.title !== x.title),
    airdate: Boolean(x.airdate && meta.airdate !== x.airdate),
    runtime: Boolean(x.runtime != null && meta.runtime !== x.runtime)
  };
  return { x, meta, translation, needs, any: Object.values(needs).some(Boolean) };
}

async function submitMeta(pre) {
  const { x } = pre;
  const current = await readMeta(x.slug, x.publicId);
  const form = current.form;
  if (pre.needs.airdate) await form.locator('input[name="airdate"]').fill(x.airdate);
  if (pre.needs.runtime) await form.locator('input[name="runtime"]').fill(String(x.runtime));
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), form.locator('button[type="submit"],input[type="submit"]').last().click()]);
  await page.waitForTimeout(700);
  report.writes.push({ type: 'EDIT_METADATA', target: x.target, publicId: x.publicId, airdate: pre.needs.airdate, runtime: pre.needs.runtime });
  const verify = await readMeta(x.slug, x.publicId);
  if (x.airdate && verify.airdate !== x.airdate) fail(`Airdate verify failed ${x.publicId}`);
  if (x.runtime != null && verify.runtime !== x.runtime) fail(`Runtime verify failed ${x.publicId}`);
  report.verifications.push({ type: 'EDIT_METADATA', target: x.target, publicId: x.publicId, ok: true });
}

async function submitTitle(pre) {
  const { x } = pre;
  const current = await readTranslation(x.slug, x.publicId);
  if (current.title === x.title) return;
  await current.form.locator('input[name="episode_name"]').fill(x.title);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), current.form.locator('button[type="submit"],input[type="submit"]').last().click()]);
  await page.waitForTimeout(700);
  report.writes.push({ type: 'EDIT_FRENCH_TITLE', target: x.target, publicId: x.publicId });
  const verify = await readTranslation(x.slug, x.publicId);
  if (verify.title !== x.title) fail(`Title verify failed ${x.publicId} (${verify.title})`);
  report.verifications.push({ type: 'EDIT_FRENCH_TITLE', target: x.target, publicId: x.publicId, ok: true });
}

let preflight = [];
try {
  report.authenticated = await login();
  if (!report.authenticated) fail('Authenticated session not proven');

  await verifyExistingAdds();

  for (const x of SAFE_EDITS) {
    const pre = await preflightEdit(x);
    preflight.push(pre);
    report.preflight.push({ target: x.target, publicId: x.publicId, needs: pre.needs, ready: true });
  }

  const allowedPaths = new Set();
  for (const pre of preflight) {
    if (pre.needs.airdate || pre.needs.runtime) allowedPaths.add(new URL(pre.meta.actionUrl).pathname);
    if (pre.needs.title) allowedPaths.add('/episodes/translatestore');
  }

  await context.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'DELETE' || /\/entity\/delete(?:\/|$)/i.test(u.pathname)) {
      report.blocked.push(`Blocked destructive request ${req.method()} ${u.pathname}`);
      await route.abort(); return;
    }
    if (u.origin === BASE && req.method() === 'POST' && !allowedPaths.has(u.pathname)) {
      report.blocked.push(`Blocked unexpected POST ${u.pathname}`);
      await route.abort(); return;
    }
    await route.continue();
  });

  for (const pre of preflight) {
    if (!pre.any) {
      report.skips.push({ target: pre.x.target, publicId: pre.x.publicId, reason: 'ALREADY_CORRECT' });
      continue;
    }
    if (pre.needs.airdate || pre.needs.runtime) await submitMeta(pre);
    if (pre.needs.title) await submitTitle(pre);
  }

  await verifyExistingAdds();
  for (const x of SAFE_EDITS) {
    const rows = await readSeason(x.slug, x.season);
    const row = rows.find(r => r.number === x.episode && r.publicId === x.publicId);
    if (!row) fail(`Final mapping verify failed ${x.publicId}`);
    const meta = await readMeta(x.slug, x.publicId);
    if (x.airdate && meta.airdate !== x.airdate) fail(`Final airdate verify failed ${x.publicId}`);
    if (x.runtime != null && meta.runtime !== x.runtime) fail(`Final runtime verify failed ${x.publicId}`);
    if (x.title) {
      const tr = await readTranslation(x.slug, x.publicId);
      if (tr.title !== x.title) fail(`Final title verify failed ${x.publicId}`);
    }
  }

  report.result = 'SAFE_REMAINDER_APPLIED_AND_VERIFIED';
} catch (error) {
  report.blocked.push(error?.stack || error?.message || String(error));
  report.result = report.writes.length ? 'PARTIAL_REVIEW_REQUIRED' : 'BLOCKED_BEFORE_WRITES';
} finally {
  await browser.close();
}

await fs.writeFile('reports/batch-apply-all-v3.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Result: ${report.result}`,
  `Preflight: ${report.preflight.length}`,
  `Writes: ${report.writes.length}`,
  `Skips: ${report.skips.length}`,
  `Verifications: ${report.verifications.length}`,
  ''
];
for (const w of report.writes) lines.push(`WRITE | ${w.type} | ${w.target} | ${w.publicId}`);
for (const s of report.skips) lines.push(`SKIP | ${s.target} | ${s.publicId || ''} | ${s.reason}`);
for (const b of report.blocked) lines.push(`BLOCKED | ${String(b).split('\n')[0]}`);
await fs.writeFile('reports/batch-apply-all-v3.txt', lines.join('\n'));
console.log(lines.join('\n'));
if (report.result !== 'SAFE_REMAINDER_APPLIED_AND_VERIFIED') process.exitCode = 2;
