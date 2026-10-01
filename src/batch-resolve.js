import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const plan = JSON.parse(await fs.readFile('config/full-batch-plan.json', 'utf8'));

await fs.mkdir('reports', { recursive: true });

const BASE = 'https://thetvdb.com';
const TARGETS = {
  'Djilsi': { slug: 'djilsi' },
  'Elian Ventre': { slug: 'elian-ventre-462729' },
  'Raska': { slug: 'raska' },
  'Mastu': { slug: '346011-show' },
  'Amixem': { slug: '328213-show' },
  'Joyca': { slug: '335805-show' },
  'Mcfly & Carlito': { slug: '338282-show' }
};

const YOUTUBE_ITEMS = {
  elianCabins: {
    url: 'https://www.youtube.com/watch?v=xkGjW_FR8vI',
    expectedTitle: 'Nos cabanes vont-elles résister au Loup ?! (ft. Maxime Biaggi)'
  },
  mastu2021: {
    url: 'https://www.youtube.com/watch?v=qbR6r1voD5Q',
    expectedTitle: 'JE REGARDE UN EPISODE DE NEXT (10 ans après) #8',
    fallbackDate: '2021-06-26'
  },
  mastu2026: {
    url: 'https://www.youtube.com/watch?v=RyR2zY51hnI',
    expectedTitle: 'LA TABLE INFERNALE 2 (Avec Byilhan, Flamby et Elian)',
    fallbackDate: '2026-09-19',
    fallbackRuntimeSeconds: 2917
  },
  djilsiTeaser: {
    url: 'https://www.youtube.com/watch?v=uMmwt8l0FtM',
    expectedTitle: 'RDV LE SAMEDI 5 SEPTEMBRE À 11H... 🫶🏻',
    fallbackDate: '2026-08-24'
  },
  djilsiFinal: {
    url: 'https://www.youtube.com/watch?v=ersw34RPmZ8',
    expectedTitle: 'Une fin d’aventure pleine de rebondissements… - ON VA OÙ 7 ep6 FINAL',
    fallbackDate: '2026-09-23',
    fallbackRuntimeSeconds: 3708
  }
};

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'BATCH_RESOLUTION_AUTHENTICATED_READ_ONLY',
  authenticated: false,
  writeRequestsDetected: 0,
  exactReady: [],
  resolved: [],
  verifyOnly: [],
  unassigned: [],
  unresolved: [],
  diagnostics: [],
  ok: false
};

const normalize = (value = '') => value
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

function codeParts(code = '') {
  const m = String(code).match(/^S(\d{4})E(\d{1,3})$/);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

function parseIsoDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function runtimeToMinutes(seconds) {
  return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
}

if (!username || !password) {
  report.unresolved.push({ target: 'GLOBAL', reason: 'Missing TVDB credentials.' });
  await fs.writeFile('reports/batch-resolution.json', JSON.stringify(report, null, 2));
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
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

async function goto(url) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    last = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (last && last.status() < 400) {
      await page.waitForTimeout(500);
      return last;
    }
    await page.waitForTimeout(800 * attempt);
  }
  throw new Error(`GET failed: ${url} (${last?.status() ?? 'n/a'})`);
}

async function inspectSeason(slug, season) {
  const editUrl = `${BASE}/series/${slug}/seasons/official/${season}/edit`;
  await goto(editUrl);
  const form = page.locator('form').filter({ has: page.locator('input[name="season_number"]') }).first();
  const action = await form.getAttribute('action').catch(() => null);
  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map((input, index) => {
    const inputName = input.getAttribute('name') || '';
    const internalId = inputName.match(/^episodes\[(\d+)\]$/)?.[1] || null;
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
      title: (anchor?.textContent || '').replace(/\s+/g, ' ').trim(),
      rowText: (container?.textContent || '').replace(/\s+/g, ' ').trim(),
      href
    };
  }));
  rows.sort((a, b) => a.number - b.number || a.index - b.index);
  return { slug, season, editUrl, action, count: rows.length, rows };
}

async function inspectEpisodeEdit(slug, publicId) {
  if (!publicId) return null;
  const url = `${BASE}/series/${slug}/episodes/${publicId}/0/edit`;
  await goto(url);
  const forms = await page.locator('form').evaluateAll(forms => forms.map((form, index) => ({
    index,
    action: form.getAttribute('action'),
    method: (form.getAttribute('method') || 'GET').toUpperCase()
  })));
  const fields = await page.locator('input, textarea, select').evaluateAll(nodes => nodes.map(node => {
    const name = node.getAttribute('name');
    if (!name) return null;
    let value = '';
    if (node.tagName === 'SELECT') value = [...node.selectedOptions].map(o => o.value).join('|');
    else if ((node.type === 'checkbox' || node.type === 'radio')) value = node.checked ? node.value : '';
    else value = node.value || '';
    return { name, type: node.type || node.tagName.toLowerCase(), value };
  }).filter(Boolean));
  const useful = fields.filter(f => /airdate|runtime|name|title|translation|season|episode|productioncode/i.test(f.name));
  const valueByName = Object.fromEntries(fields.map(f => [f.name, f.value]));
  const airdate = valueByName.airdate || valueByName['episode[airdate]'] || useful.find(f => /airdate/i.test(f.name))?.value || null;
  const runtimeRaw = valueByName.runtime || valueByName['episode[runtime]'] || useful.find(f => /runtime/i.test(f.name))?.value || null;
  const titleCandidates = useful.filter(f => /name|title/i.test(f.name) && f.value).map(f => ({ name: f.name, value: f.value }));
  return {
    publicId,
    url,
    forms,
    action: forms.find(f => f.method === 'POST' && /\/update$/.test(f.action || ''))?.action || forms.find(f => f.method === 'POST')?.action || null,
    airdate: parseIsoDate(airdate),
    runtimeRaw,
    runtimeMinutes: runtimeRaw && /^\d+$/.test(String(runtimeRaw)) ? Number(runtimeRaw) : null,
    titleCandidates,
    usefulFields: useful
  };
}

async function inspectPublicSeason(slug, season) {
  const url = `${BASE}/series/${slug}/seasons/official/${season}`;
  await goto(url);
  const rows = await page.locator('a[href*="/episodes/"]').evaluateAll(anchors => {
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const href = a.href || '';
      const id = href.match(/\/episodes\/(\d+)/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let container = a.closest('tr');
      if (!container) container = a.closest('.row');
      if (!container) container = a.closest('li');
      if (!container) container = a.parentElement?.parentElement || a.parentElement;
      const text = (container?.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({ publicId: id, title: (a.textContent || '').replace(/\s+/g, ' ').trim(), rowText: text, href });
    }
    return out;
  });
  return { url, rows };
}

async function discoverUnassigned(targetName) {
  const { slug } = TARGETS[targetName];
  const allUrl = `${BASE}/series/${slug}/allseasons/official`;
  await goto(allUrl);
  const candidates = await page.locator('a').evaluateAll(anchors => anchors.map(a => ({
    text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
    href: a.href || ''
  })).filter(x => /unassigned/i.test(`${x.text} ${x.href}`)));
  const urls = [...new Set(candidates.map(x => x.href).filter(Boolean))];
  if (!urls.length) {
    report.diagnostics.push({ target: targetName, type: 'UNASSIGNED', note: 'No Unassigned link discovered on all-seasons page.' });
    return { target: targetName, links: candidates, entries: [] };
  }
  const entries = [];
  for (const url of urls) {
    await goto(url);
    const found = await page.locator('a[href*="/episodes/"]').evaluateAll(anchors => {
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        const href = a.href || '';
        const id = href.match(/\/episodes\/(\d+)/)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        let container = a.closest('tr');
        if (!container) container = a.closest('.row');
        if (!container) container = a.closest('li');
        if (!container) container = a.parentElement?.parentElement || a.parentElement;
        out.push({
          publicId: id,
          title: (a.textContent || '').replace(/\s+/g, ' ').trim(),
          rowText: (container?.textContent || '').replace(/\s+/g, ' ').trim(),
          href
        });
      }
      return out;
    });
    for (const item of found) entries.push({ sourceUrl: url, ...item });
  }
  return { target: targetName, links: candidates, entries };
}

async function youtubeMeta(def) {
  await goto(def.url);
  const title = await page.title().catch(() => '');
  const data = await page.evaluate(() => {
    const p = window.ytInitialPlayerResponse || null;
    const m = p?.microformat?.playerMicroformatRenderer || null;
    const v = p?.videoDetails || null;
    return {
      publishDate: m?.publishDate || null,
      uploadDate: m?.uploadDate || null,
      lengthSeconds: v?.lengthSeconds ? Number(v.lengthSeconds) : null,
      videoTitle: v?.title || null
    };
  }).catch(() => ({ publishDate: null, uploadDate: null, lengthSeconds: null, videoTitle: null }));
  const html = await page.content().catch(() => '');
  const regexDate = html.match(/\"publishDate\":\"(\d{4}-\d{2}-\d{2})\"/)?.[1]
    || html.match(/\"uploadDate\":\"(\d{4}-\d{2}-\d{2})\"/)?.[1]
    || null;
  const date = data.publishDate || data.uploadDate || regexDate || def.fallbackDate || null;
  const seconds = data.lengthSeconds || def.fallbackRuntimeSeconds || null;
  return {
    url: def.url,
    expectedTitle: def.expectedTitle,
    pageTitle: title,
    videoTitle: data.videoTitle,
    publishDate: parseIsoDate(date),
    durationSeconds: seconds,
    runtimeMinutes: runtimeToMinutes(seconds),
    dateSource: data.publishDate ? 'ytInitialPlayerResponse.publishDate' : data.uploadDate ? 'ytInitialPlayerResponse.uploadDate' : regexDate ? 'page-source' : def.fallbackDate ? 'validated-fallback' : null
  };
}

function findByTitle(rows, title) {
  const needle = normalize(title);
  return rows.find(r => normalize(r.title) === needle) || rows.find(r => normalize(r.title).includes(needle) || needle.includes(normalize(r.title)));
}

async function resolveExactReadyItems() {
  const cache = new Map();
  for (const item of plan.items.filter(x => x.batchStatus === 'Prête')) {
    const cp = codeParts(item['Code / zone']);
    const meta = TARGETS[item.YouTubeur];
    if (!cp || !meta) {
      report.unresolved.push({ target: item.YouTubeur, code: item['Code / zone'], reason: 'Exact target metadata unavailable.' });
      continue;
    }
    const key = `${meta.slug}:${cp.season}`;
    if (!cache.has(key)) cache.set(key, await inspectSeason(meta.slug, cp.season));
    const season = cache.get(key);
    const row = season.rows.find(r => r.number === cp.episode);
    if (!row?.publicId) {
      report.unresolved.push({ target: item.YouTubeur, code: item['Code / zone'], reason: 'Episode not found on authenticated season edit page.' });
      continue;
    }
    const detail = await inspectEpisodeEdit(meta.slug, row.publicId);
    report.exactReady.push({
      target: item.YouTubeur,
      code: item['Code / zone'],
      publicId: row.publicId,
      internalSeasonEpisodeId: row.internalId,
      currentTitle: row.title,
      currentAirdate: detail?.airdate || null,
      currentRuntimeMinutes: detail?.runtimeMinutes ?? null,
      desired: item.desired || null,
      episodeEditAction: detail?.action || null,
      seasonSaveAction: season.action || null,
      status: 'RESOLVED_EXACT_TARGET'
    });
  }
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session could not be proven.');
  loginComplete = true;

  // Exact ready items first: map every intended write to a public ID + current values.
  await resolveExactReadyItems();

  // Djilsi: inspect the real 17-episode state after the previous partial apply. Never add again here.
  const djSeason = await inspectSeason(TARGETS.Djilsi.slug, 2026);
  const djMetaTeaser = await youtubeMeta(YOUTUBE_ITEMS.djilsiTeaser);
  const djMetaFinal = await youtubeMeta(YOUTUBE_ITEMS.djilsiFinal);
  const djTeaser = findByTitle(djSeason.rows, YOUTUBE_ITEMS.djilsiTeaser.expectedTitle) || djSeason.rows.find(r => r.number === 11);
  const djFinal = findByTitle(djSeason.rows, YOUTUBE_ITEMS.djilsiFinal.expectedTitle) || djSeason.rows.find(r => r.number === 17);
  const djTeaserDetail = await inspectEpisodeEdit(TARGETS.Djilsi.slug, djTeaser?.publicId);
  const djFinalDetail = await inspectEpisodeEdit(TARGETS.Djilsi.slug, djFinal?.publicId);
  report.resolved.push({
    target: 'Djilsi',
    kind: 'POST_APPLY_IDENTIFICATION',
    seasonCount: djSeason.count,
    teaser: { row: djTeaser || null, youtube: djMetaTeaser, detail: djTeaserDetail },
    finale: { row: djFinal || null, youtube: djMetaFinal, detail: djFinalDetail },
    expectedFinalNumbering: { teaser: 11, finale: 17 },
    note: 'Use actual YouTube publish date for First Aired; title text in the audit date column is not treated as publication date.'
  });

  // Elian: resolve the missing 2026 upload and confirm E08 position.
  const elianSeason = await inspectSeason(TARGETS['Elian Ventre'].slug, 2026);
  const elianYt = await youtubeMeta(YOUTUBE_ITEMS.elianCabins);
  const elianAlready = findByTitle(elianSeason.rows, YOUTUBE_ITEMS.elianCabins.expectedTitle);
  const elianLast = elianSeason.rows.at(-1) || null;
  const elianLastDetail = await inspectEpisodeEdit(TARGETS['Elian Ventre'].slug, elianLast?.publicId);
  report.resolved.push({
    target: 'Elian Ventre',
    kind: 'MISSING_EPISODE_POSITION',
    youtube: elianYt,
    seasonCount: elianSeason.count,
    alreadyPresent: elianAlready || null,
    currentLastEpisode: elianLast,
    currentLastAirdate: elianLastDetail?.airdate || null,
    proposedEpisodeNumber: !elianAlready && elianSeason.count === 7 && elianYt.publishDate && (!elianLastDetail?.airdate || elianYt.publishDate > elianLastDetail.airdate) ? 8 : null,
    bulkAddUrl: `${BASE}/series/${TARGETS['Elian Ventre'].slug}/seasons/official/2026/bulkadd`
  });

  // Raska 2017 exact state and page-vs-edit comparison.
  const raska2017 = await inspectSeason(TARGETS.Raska.slug, 2017);
  for (const n of [3, 4]) {
    const row = raska2017.rows.find(r => r.number === n);
    const detail = await inspectEpisodeEdit(TARGETS.Raska.slug, row?.publicId);
    report.resolved.push({ target: 'Raska', kind: `S2017E${String(n).padStart(2, '0')}`, row, detail });
  }
  const raskaPublic2017 = await inspectPublicSeason(TARGETS.Raska.slug, 2017);
  report.diagnostics.push({ target: 'Raska', season: 2017, publicRows: raskaPublic2017.rows });

  // Mastu 2021 insertion and 2026 append.
  const mastu2021 = await inspectSeason(TARGETS.Mastu.slug, 2021);
  const mastu2026 = await inspectSeason(TARGETS.Mastu.slug, 2026);
  const mastuYt2021 = await youtubeMeta(YOUTUBE_ITEMS.mastu2021);
  const mastuYt2026 = await youtubeMeta(YOUTUBE_ITEMS.mastu2026);
  const mastu2021Existing = findByTitle(mastu2021.rows, YOUTUBE_ITEMS.mastu2021.expectedTitle);
  const mastu2026Existing = findByTitle(mastu2026.rows, YOUTUBE_ITEMS.mastu2026.expectedTitle);
  const m21e16 = mastu2021.rows.find(r => r.number === 16);
  const m21e17 = mastu2021.rows.find(r => r.number === 17);
  const m21d16 = await inspectEpisodeEdit(TARGETS.Mastu.slug, m21e16?.publicId);
  const m21d17 = await inspectEpisodeEdit(TARGETS.Mastu.slug, m21e17?.publicId);
  const m26last = mastu2026.rows.at(-1) || null;
  const m26lastDetail = await inspectEpisodeEdit(TARGETS.Mastu.slug, m26last?.publicId);
  report.resolved.push({
    target: 'Mastu', kind: 'S2021_INSERT', youtube: mastuYt2021, alreadyPresent: mastu2021Existing || null,
    seasonCount: mastu2021.count, e16: { row: m21e16, airdate: m21d16?.airdate || null }, e17: { row: m21e17, airdate: m21d17?.airdate || null },
    proposedEpisodeNumber: !mastu2021Existing && mastuYt2021.publishDate === '2021-06-26' && m21d16?.airdate === '2021-06-19' && m21d17?.airdate === '2021-07-03' ? 17 : null,
    renumberRequiredFrom: 17, seasonSaveAction: mastu2021.action,
    bulkAddUrl: `${BASE}/series/${TARGETS.Mastu.slug}/seasons/official/2021/bulkadd`
  });
  report.resolved.push({
    target: 'Mastu', kind: 'S2026_APPEND', youtube: mastuYt2026, alreadyPresent: mastu2026Existing || null,
    seasonCount: mastu2026.count, currentLast: m26last, currentLastAirdate: m26lastDetail?.airdate || null,
    proposedEpisodeNumber: !mastu2026Existing && mastu2026.count === 14 && mastuYt2026.publishDate === '2026-09-19' ? 15 : null,
    bulkAddUrl: `${BASE}/series/${TARGETS.Mastu.slug}/seasons/official/2026/bulkadd`
  });

  // Unassigned entries: enumerate individually, no write or mass reassignment.
  for (const targetName of ['Amixem', 'Joyca', 'Mcfly & Carlito']) {
    const result = await discoverUnassigned(targetName);
    report.unassigned.push(result);
  }

  // Squeezie Japan Expo: recognize the existing S2012E56 reupload match and keep the second upload as review-only.
  report.verifyOnly.push({
    target: 'Squeezie',
    item: 'Japan Expo 2012',
    status: 'REVIEW_ONLY_NO_AUTOMATIC_CREATE',
    reason: 'Audit already contains S2012E56 “Japan Expo 2012 [Réupload]” matched to a different public YouTube ID; the extra current public upload must not be auto-created without proving it is a distinct original episode.'
  });

  report.ok = report.authenticated && report.writeRequestsDetected === 0;
} catch (error) {
  report.unresolved.push({ target: 'GLOBAL', reason: error?.stack || error?.message || String(error) });
} finally {
  await browser.close();
}

await fs.writeFile('reports/batch-resolution.json', JSON.stringify(report, null, 2));
const lines = [
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Write requests detected: ${report.writeRequestsDetected}`,
  `Exact ready targets mapped: ${report.exactReady.length}`,
  `Resolved groups: ${report.resolved.length}`,
  `Unassigned groups inspected: ${report.unassigned.length}`,
  `Unresolved: ${report.unresolved.length}`,
  `OK: ${report.ok}`,
  ''
];
for (const x of report.exactReady) lines.push(`READY-ID | ${x.target} | ${x.code} | TVDB ${x.publicId} | ${x.currentTitle}`);
for (const x of report.resolved) {
  if (x.target === 'Djilsi') lines.push(`RESOLVED | Djilsi | count=${x.seasonCount} | teaser=${x.teaser?.row?.publicId || '?'} E${x.teaser?.row?.number || '?'} | finale=${x.finale?.row?.publicId || '?'} E${x.finale?.row?.number || '?'}`);
  else if (x.target === 'Elian Ventre') lines.push(`RESOLVED | Elian | date=${x.youtube?.publishDate || '?'} | proposed=E${x.proposedEpisodeNumber || '?'}`);
  else if (x.target === 'Mastu') lines.push(`RESOLVED | Mastu | ${x.kind} | date=${x.youtube?.publishDate || '?'} | proposed=E${x.proposedEpisodeNumber || '?'}`);
  else if (x.target === 'Raska') lines.push(`RESOLVED | Raska | ${x.kind} | TVDB ${x.row?.publicId || '?'} | ${x.row?.title || ''} | date=${x.detail?.airdate || '?'} | runtime=${x.detail?.runtimeMinutes ?? '?'}`);
}
for (const x of report.unassigned) lines.push(`UNASSIGNED | ${x.target} | entries=${x.entries.length} | links=${x.links.length}`);
for (const x of report.verifyOnly) lines.push(`VERIFY | ${x.target} | ${x.item} | ${x.status}`);
for (const x of report.unresolved) lines.push(`UNRESOLVED | ${x.target} | ${x.reason}`);
await fs.writeFile('reports/batch-resolution.txt', lines.join('\n'));
console.log(lines.join('\n'));
if (!report.ok || report.unresolved.length) process.exitCode = 2;
