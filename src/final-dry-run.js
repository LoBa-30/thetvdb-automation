import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;

await fs.mkdir('reports', { recursive: true });

const audit = JSON.parse(await fs.readFile('reports/audit.json', 'utf8'));

const SEASONS = [
  { target: 'Djilsi', slug: 'djilsi', season: 2026, editUrl: 'https://thetvdb.com/series/djilsi/seasons/official/2026/edit' },
  { target: 'Raska', slug: 'raska', season: 2018, editUrl: 'https://thetvdb.com/series/raska/seasons/official/2018/edit' },
  { target: 'Raska', slug: 'raska', season: 2023, editUrl: 'https://thetvdb.com/series/raska/seasons/official/2023/edit' }
];

const DJILSI_ADDITIONS = [
  {
    youtubeUrl: 'https://www.youtube.com/watch?v=uMmwt8l0FtM',
    videoId: 'uMmwt8l0FtM',
    canonicalTitle: 'RDV LE SAMEDI 5 SEPTEMBRE À 11H... 🫶🏻',
    expectedTitleIncludes: 'RDV LE SAMEDI 5 SEPTEMBRE À 11H',
    expectedFirstAiredIso: '2026-08-24',
    confidence: 'USER_CONFIRMED',
    reason: 'Ajout explicitement demandé par l’utilisateur. Date de référence verrouillée après vérification préalable.'
  },
  {
    youtubeUrl: 'https://www.youtube.com/watch?v=ersw34RPmZ8',
    videoId: 'ersw34RPmZ8',
    canonicalTitle: 'Une fin d’aventure pleine de rebondissements… - ON VA OÙ 7 ep6 FINAL',
    expectedTitleIncludes: 'ON VA OÙ 7 ep6 FINAL',
    expectedFirstAiredIso: '2026-09-23',
    confidence: 'HIGH',
    reason: 'Épisode final public clairement identifié comme absent de TheTVDB. Date de référence verrouillée après vérification préalable.'
  }
];

const normalize = (value = '') => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'FINAL_DRY_RUN_READ_ONLY',
  authenticated: false,
  safety: {
    editFormSubmitsAllowed: false,
    editPostsPerformed: 0,
    destructiveDeletesAllowed: false,
    applyReady: false
  },
  additions: [],
  seasons: [],
  blockedReasons: [],
  notes: []
};

if (!username || !password) {
  report.blockedReasons.push('Missing TVDB_USERNAME or TVDB_PASSWORD secret.');
  await fs.writeFile('reports/final-dry-run.json', JSON.stringify(report, null, 2));
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
  if (request.method() !== 'POST') return;
  const url = request.url();
  if (/thetvdb\.com\/series\//i.test(url)) {
    report.safety.editPostsPerformed += 1;
    report.blockedReasons.push(`Unexpected edit POST detected: ${url}`);
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
  await page.waitForTimeout(1200);
  const probe = await context.request.get('https://thetvdb.com/auth/getuser').catch(() => null);
  if (!probe?.ok()) return false;
  const text = await probe.text().catch(() => '');
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  return Boolean(payload && typeof payload === 'object' && Object.keys(payload).length);
}

function auditEpisodeMap(targetName, season) {
  const target = (audit.targets || []).find(t => t.name === targetName);
  const map = new Map();
  for (const ep of target?.tvdbEpisodes || []) {
    if (Number(ep.season) !== Number(season)) continue;
    const key = normalize(ep.title);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ep);
  }
  return map;
}

async function readSeasonRows(def) {
  const nav = await page.goto(def.editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(700);
  if (!nav || nav.status() >= 400) throw new Error(`${def.target} ${def.season}: season edit page HTTP ${nav?.status() ?? 'n/a'}`);

  const rows = await page.locator('input[name^="episodes["]').evaluateAll(inputs => inputs.map((input, domIndex) => {
    const name = input.getAttribute('name') || '';
    const internalId = name.match(/^episodes\[(\d+)\]$/)?.[1] || null;
    let container = input.closest('tr');
    if (!container) container = input.closest('.row');
    if (!container) container = input.parentElement?.parentElement || input.parentElement;
    const anchor = container?.querySelector('a[href*="/episodes/"]') || null;
    const href = anchor?.href || null;
    const publicEpisodeId = href?.match(/\/episodes\/(\d+)/)?.[1] || null;
    const title = (anchor?.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      domIndex,
      internalSeasonEpisodeId: internalId,
      publicEpisodeId,
      title,
      currentNumberRaw: input.value,
      currentNumber: Number(input.value)
    };
  }));

  const map = auditEpisodeMap(def.target, def.season);
  return rows.map(row => {
    const candidates = map.get(normalize(row.title)) || [];
    const auditEpisode = candidates[0] || null;
    return {
      ...row,
      firstAiredIso: auditEpisode?.firstAiredIso || null,
      auditCode: auditEpisode?.code || null
    };
  });
}

async function dismissYouTubeConsent(ytPage) {
  for (const selector of ['button:has-text("Tout accepter")', 'button:has-text("Accept all")', 'button:has-text("Tout refuser")', 'button:has-text("Reject all")']) {
    const button = ytPage.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await ytPage.waitForTimeout(800);
      break;
    }
  }
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

async function youtubeMetadata(def) {
  const ytPage = await context.newPage();
  try {
    const response = await ytPage.goto(def.youtubeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await dismissYouTubeConsent(ytPage);
    await ytPage.waitForTimeout(1500);
    if (!response || response.status() >= 400) {
      return {
        ...def,
        ok: validIsoDate(def.expectedFirstAiredIso),
        title: def.canonicalTitle,
        firstAiredIso: def.expectedFirstAiredIso,
        durationIso: null,
        metadataSource: 'LOCKED_REFERENCE_DATE',
        youtubeReachable: false,
        warning: `YouTube page HTTP ${response?.status() ?? 'n/a'}; locked reference date used.`
      };
    }

    const meta = await ytPage.evaluate(() => {
      const get = selectors => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const value = el?.getAttribute('content') || el?.textContent || '';
          if (value.trim()) return value.trim();
        }
        return null;
      };

      let structured = null;
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(script.textContent || 'null');
          const list = Array.isArray(parsed) ? parsed : [parsed];
          structured = list.find(x => x && typeof x === 'object' && (x.uploadDate || x.datePublished || x.name)) || structured;
        } catch {}
      }

      let player = null;
      try {
        player = globalThis.ytInitialPlayerResponse || null;
      } catch {}

      const micro = player?.microformat?.playerMicroformatRenderer || null;
      const videoDetails = player?.videoDetails || null;

      return {
        title: get(['meta[name="title"]', 'meta[property="og:title"]']) || videoDetails?.title || structured?.name || document.title,
        published: get(['meta[itemprop="datePublished"]', 'meta[itemprop="uploadDate"]']) || micro?.publishDate || micro?.uploadDate || structured?.uploadDate || structured?.datePublished || null,
        durationIso: get(['meta[itemprop="duration"]']) || structured?.duration || null,
        videoId: videoDetails?.videoId || null
      };
    });

    const pageDate = meta.published ? String(meta.published).slice(0, 10) : null;
    const exactVideoConfirmed = !meta.videoId || meta.videoId === def.videoId;
    const pageDateValid = validIsoDate(pageDate);
    const lockedDateValid = validIsoDate(def.expectedFirstAiredIso);

    let firstAiredIso = null;
    let metadataSource = null;
    let warning = null;

    if (pageDateValid) {
      firstAiredIso = pageDate;
      metadataSource = 'YOUTUBE_PAGE';
      if (lockedDateValid && pageDate !== def.expectedFirstAiredIso) {
        warning = `YouTube page date ${pageDate} differs from locked reference ${def.expectedFirstAiredIso}.`;
      }
    } else if (lockedDateValid) {
      firstAiredIso = def.expectedFirstAiredIso;
      metadataSource = 'LOCKED_REFERENCE_DATE';
      warning = 'YouTube did not expose a machine-readable publish date; locked reference date used.';
    }

    const title = def.canonicalTitle || meta.title;
    const ok = Boolean(firstAiredIso && exactVideoConfirmed && (!pageDateValid || pageDate === def.expectedFirstAiredIso));

    return {
      ...def,
      ok,
      title,
      youtubePageTitle: meta.title,
      firstAiredIso,
      durationIso: meta.durationIso,
      metadataSource,
      youtubeReachable: true,
      exactVideoConfirmed,
      pagePublishedIso: pageDate,
      warning
    };
  } finally {
    await ytPage.close();
  }
}

function sortChronologically(items) {
  return [...items].sort((a, b) => {
    const ad = a.firstAiredIso || '9999-99-99';
    const bd = b.firstAiredIso || '9999-99-99';
    if (ad !== bd) return ad.localeCompare(bd);
    return (a.domIndex ?? 99999) - (b.domIndex ?? 99999);
  });
}

try {
  report.authenticated = await login();
  if (!report.authenticated) throw new Error('Authenticated session could not be proven.');
  loginComplete = true;

  for (const addition of DJILSI_ADDITIONS) {
    const resolved = await youtubeMetadata(addition);
    report.additions.push(resolved);
    if (resolved.warning) report.notes.push(`${addition.videoId}: ${resolved.warning}`);
    if (!resolved.ok) report.blockedReasons.push(`Djilsi addition metadata unresolved or date mismatch: ${addition.youtubeUrl}`);
  }

  for (const def of SEASONS) {
    const rows = await readSeasonRows(def);
    if (!rows.length) {
      report.blockedReasons.push(`${def.target} ${def.season}: no episode-number fields found.`);
      continue;
    }

    const missingDates = rows.filter(r => !r.firstAiredIso);
    if (missingDates.length) report.blockedReasons.push(`${def.target} ${def.season}: ${missingDates.length} existing episode(s) could not be mapped to an air date.`);

    let merged = rows.map(r => ({ ...r, kind: 'EXISTING' }));
    if (def.target === 'Djilsi' && def.season === 2026) {
      merged.push(...report.additions.map((a, index) => ({
        kind: 'NEW',
        domIndex: 100000 + index,
        publicEpisodeId: null,
        internalSeasonEpisodeId: null,
        title: a.title || a.canonicalTitle || a.expectedTitleIncludes,
        firstAiredIso: a.firstAiredIso,
        youtubeUrl: a.youtubeUrl,
        confidence: a.confidence,
        reason: a.reason,
        metadataSource: a.metadataSource
      })));
    }

    const ordered = sortChronologically(merged);
    const operations = ordered.map((item, index) => ({
      ...item,
      proposedNumber: index + 1,
      changeRequired: item.kind === 'NEW' || Number(item.currentNumber) !== index + 1
    }));

    const duplicatesBefore = new Map();
    for (const row of rows) {
      const n = Number(row.currentNumber);
      if (!duplicatesBefore.has(n)) duplicatesBefore.set(n, []);
      duplicatesBefore.get(n).push(row.title);
    }

    report.seasons.push({
      target: def.target,
      season: def.season,
      editUrl: def.editUrl,
      existingCount: rows.length,
      finalCount: operations.length,
      duplicateNumbersBefore: [...duplicatesBefore.entries()].filter(([, titles]) => titles.length > 1).map(([number, titles]) => ({ number, titles })),
      operations
    });
  }

  if (report.safety.editPostsPerformed > 0) report.blockedReasons.push('One or more edit POSTs occurred unexpectedly.');
  report.safety.applyReady = report.authenticated && report.safety.editPostsPerformed === 0 && report.blockedReasons.length === 0;
  report.notes.push('Dry-run only. Season edit forms and YouTube metadata were read; no TheTVDB edit form was submitted.');
} catch (error) {
  report.blockedReasons.push(error?.message || String(error));
} finally {
  await browser.close();
}

await fs.writeFile('reports/final-dry-run.json', JSON.stringify(report, null, 2));

const lines = [
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Edit POSTs performed: ${report.safety.editPostsPerformed}`,
  `Apply-ready: ${report.safety.applyReady}`,
  ''
];
for (const add of report.additions) {
  lines.push(`ADD Djilsi | ${add.firstAiredIso || 'DATE?'} | ${add.title || add.canonicalTitle || add.expectedTitleIncludes} | ${add.youtubeUrl} | ${add.confidence} | source=${add.metadataSource || 'n/a'} | ok=${add.ok}`);
}
lines.push('');
for (const season of report.seasons) {
  lines.push(`## ${season.target} ${season.season} | existing=${season.existingCount} | final=${season.finalCount}`);
  for (const dup of season.duplicateNumbersBefore) lines.push(`DUPLICATE BEFORE E${dup.number}: ${dup.titles.join(' / ')}`);
  for (const op of season.operations) {
    const oldNumber = op.kind === 'NEW' ? 'NEW' : `E${op.currentNumber}`;
    lines.push(`${op.changeRequired ? 'CHANGE' : 'KEEP'} | ${oldNumber} -> E${op.proposedNumber} | ${op.firstAiredIso || 'DATE?'} | ${op.title}${op.publicEpisodeId ? ` | TVDB ${op.publicEpisodeId}` : ''}${op.youtubeUrl ? ` | ${op.youtubeUrl}` : ''}${op.metadataSource ? ` | source=${op.metadataSource}` : ''}`);
  }
  lines.push('');
}
if (report.blockedReasons.length) {
  lines.push('BLOCKED REASONS:');
  for (const reason of report.blockedReasons) lines.push(`- ${reason}`);
}
if (report.notes.length) {
  lines.push('NOTES:');
  for (const note of report.notes) lines.push(`- ${note}`);
}
await fs.writeFile('reports/final-dry-run.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (!report.safety.applyReady) process.exitCode = 2;
