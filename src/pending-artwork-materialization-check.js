import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
if (!username || !password) throw new Error('Missing TVDB credentials');

const BASE = 'https://thetvdb.com';
const OUT = 'reports/pending-artwork-materialization-2026-10-07';
const artworkTargets = [
  { target: 'Elian Ventre', code: 'S2023E04', slug: 'elian-ventre-462729', episodeId: '11092251', priorSubmission: 'reports/elian-artwork-pilot/report.json' },
  { target: 'Elian Ventre', code: 'S2023E06', slug: 'elian-ventre-462729', episodeId: '11092253', priorSubmission: 'reports/elian-artwork-file-canary/report.json' },
  { target: 'Mcfly & Carlito', code: 'S2015E01', slug: '338282-show', episodeId: '12023296', priorSubmission: 'reports/mcfly-grosse-annonce-artwork-apply/report.json' }
];
const titleTarget = {
  target: 'Elian Ventre',
  code: 'S2026E08',
  slug: 'elian-ventre-462729',
  episodeId: '12014528',
  expectedCurrentTitle: "On s'affronte pour construire la meilleure cabane ! ft. Maxime Biaggi"
};

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'fr-FR',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'
});
const page = await context.newPage();

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'READ_ONLY_PENDING_ARTWORK_AND_TITLE_DRIFT_RECHECK',
  authenticated: false,
  artworks: [],
  titleDrift: null,
  blocked: [],
  blockedNonReadRequests: [],
  result: 'NOT_STARTED'
};

async function go(p, url) {
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (r && r.status() < 400) {
      await p.waitForTimeout(350);
      return r;
    }
    await p.waitForTimeout(500 * (i + 1));
  }
  throw new Error('GET ' + url + ' ' + (r?.status() ?? 'n/a'));
}

function artUrls(html) {
  return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)]
    .map(x => x[0].replace(/&amp;/g, '&'));
}

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

try {
  await go(page, BASE + '/auth/login');
  const f = page.locator('form').filter({ has: page.locator('input[name="password"]') }).first();
  await f.locator('input[name="email"]').fill(username);
  await f.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    f.locator('button[type="submit"],input[type="submit"]').first().click()
  ]);
  await page.waitForTimeout(650);
  const probe = await context.request.get(BASE + '/auth/getuser');
  report.authenticated = probe.ok();
  if (!report.authenticated) throw new Error('Authentication not proven');

  await context.route('**/*', async route => {
    const req = route.request();
    if (/thetvdb\.com/i.test(req.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method().toUpperCase())) {
      report.blockedNonReadRequests.push({ method: req.method(), url: req.url() });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  for (const t of artworkTargets) {
    const p = await context.newPage();
    try {
      await go(p, BASE + '/series/' + t.slug + '/episodes/' + t.episodeId);
      const html = await p.content();
      const artwork = artUrls(html);
      const heading = (await p.locator('h1,h2').allTextContents()).map(x => x.trim()).find(Boolean) || null;
      report.artworks.push({
        ...t,
        heading,
        artworkCount: artwork.length,
        artwork,
        status: artwork.length ? 'MATERIALIZED' : 'STILL_PENDING_DO_NOT_RETRY'
      });
    } catch (e) {
      report.blocked.push({ target: t.target, code: t.code, episodeId: t.episodeId, reason: String(e?.message || e) });
    } finally {
      await p.close();
    }
  }

  const tp = await context.newPage();
  try {
    await go(tp, BASE + '/series/' + titleTarget.slug + '/episodes/' + titleTarget.episodeId);
    const heading = (await tp.locator('h1,h2').allTextContents()).map(x => x.trim()).find(Boolean) || null;
    report.titleDrift = {
      ...titleTarget,
      currentTvdbTitle: heading,
      exactCurrentTitlePresent: norm(heading) === norm(titleTarget.expectedCurrentTitle),
      status: norm(heading) === norm(titleTarget.expectedCurrentTitle) ? 'CURRENT_TITLE_PRESENT_NO_WRITE' : 'REGRESSION_STILL_PRESENT_NO_REPEAT_WRITE'
    };
  } catch (e) {
    report.blocked.push({ target: titleTarget.target, code: titleTarget.code, episodeId: titleTarget.episodeId, reason: String(e?.message || e) });
  } finally {
    await tp.close();
  }

  const materialized = report.artworks.filter(x => x.status === 'MATERIALIZED').length;
  report.summary = {
    checkedArtworkSubmissions: report.artworks.length,
    materialized,
    stillPending: report.artworks.filter(x => x.status === 'STILL_PENDING_DO_NOT_RETRY').length,
    titleDriftStatus: report.titleDrift?.status ?? 'UNKNOWN'
  };
  report.result = report.blocked.length ? 'READ_ONLY_CHECK_COMPLETE_WITH_BLOCKS' : 'READ_ONLY_CHECK_COMPLETE';
} catch (e) {
  report.blocked.push({ reason: String(e?.stack || e) });
  report.result = 'BLOCKED_ERROR';
} finally {
  await browser.close();
}

await fs.writeFile(OUT + '/report.json', JSON.stringify(report, null, 2) + '\n');
await fs.writeFile(
  OUT + '/summary.txt',
  [
    'authenticated=' + report.authenticated,
    'checkedArtworkSubmissions=' + (report.summary?.checkedArtworkSubmissions ?? 0),
    'materialized=' + (report.summary?.materialized ?? 0),
    'stillPending=' + (report.summary?.stillPending ?? 0),
    'titleDriftStatus=' + (report.summary?.titleDriftStatus ?? 'UNKNOWN'),
    'blocked=' + report.blocked.length,
    'result=' + report.result
  ].join('\n') + '\n'
);
console.log(await fs.readFile(OUT + '/summary.txt', 'utf8'));
if (report.result === 'BLOCKED_ERROR') process.exitCode = 2;
