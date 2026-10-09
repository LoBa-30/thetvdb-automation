import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { compareCatalogues, normalizeTitle } from './matcher.js';

const TARGETS = [
  { name: 'Squeezie', youtubeUrl: 'https://www.youtube.com/@Squeezie/videos', tvdbUrl: 'https://thetvdb.com/series/279758-show/allseasons/official' },
  { name: 'Djilsi', youtubeUrl: 'https://www.youtube.com/c/djilsi/videos', tvdbUrl: 'https://thetvdb.com/series/djilsi/allseasons/official' },
  { name: 'Maxime Biaggi', youtubeUrl: 'https://www.youtube.com/c/MaximeBiaggi/videos', tvdbUrl: 'https://thetvdb.com/series/maxime-biaggi/allseasons/official' },
  { name: 'Raska', youtubeUrl: 'https://www.youtube.com/@R4SK4/videos', tvdbUrl: 'https://thetvdb.com/series/raska/allseasons/official' }
];

function parseTvdbDate(value) {
  if (!value) return null;
  const cleaned = value.replace(/\s+YouTube$/i, '').trim();
  const date = new Date(cleaned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function dismissYouTubeConsent(page) {
  for (const selector of [
    'button:has-text("Tout accepter")',
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'button:has-text("Tout refuser")'
  ]) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(1500);
      break;
    }
  }
}

async function collectYouTubeVideos(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissYouTubeConsent(page);
  await page.waitForTimeout(2500);

  let previous = 0;
  let stableRounds = 0;
  for (let i = 0; i < 140 && stableRounds < 6; i += 1) {
    const count = await page.locator('a[href*="/watch?v="]').count();
    stableRounds = count === previous ? stableRounds + 1 : 0;
    previous = count;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(850);
  }

  const videos = await page.locator('a[href*="/watch?v="]').evaluateAll(anchors => {
    const found = new Map();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/watch?v=')) continue;
      const videoId = new URL(`https://www.youtube.com${href}`).searchParams.get('v');
      if (!videoId) continue;
      const title = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      found.set(videoId, { id: videoId, title, url: `https://www.youtube.com/watch?v=${videoId}` });
    }
    return [...found.values()];
  });

  return { reachable: Boolean(response?.ok()), videos };
}

async function collectTvdbEpisodes(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const title = await page.title();
  const text = await page.locator('body').innerText();
  const lines = text.split('\n').map(v => v.trim()).filter(Boolean);
  const episodes = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^S(\d{1,4})E(\d{1,4})\s+(.+)$/i);
    if (!match) continue;
    const [, season, episode, episodeTitle] = match;
    const next = lines[i + 1] || '';
    const possibleDate = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/.test(next) ? next : null;
    episodes.push({
      season: Number(season),
      episode: Number(episode),
      code: `S${season}E${String(episode).padStart(2, '0')}`,
      title: episodeTitle.trim(),
      firstAired: possibleDate,
      firstAiredIso: parseTvdbDate(possibleDate)
    });
  }

  return { reachable: Boolean(response?.ok()), title, episodes };
}

function detectTvdbDuplicates(episodes) {
  const byCode = new Map();
  const byTitle = new Map();
  for (const episode of episodes) {
    if (!byCode.has(episode.code)) byCode.set(episode.code, []);
    byCode.get(episode.code).push(episode);
    const key = normalizeTitle(episode.title);
    if (key) {
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(episode);
    }
  }
  return {
    duplicateCodes: [...byCode.entries()].filter(([, list]) => list.length > 1).map(([code, list]) => ({ code, episodes: list })),
    duplicateTitles: [...byTitle.entries()].filter(([, list]) => list.length > 1).map(([normalizedTitle, list]) => ({ normalizedTitle, episodes: list }))
  };
}

await fs.mkdir('reports', { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'fr-FR',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36'
});

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'READ_ONLY_AUDIT',
  methodology: 'Public YouTube Videos tabs are compared to public TheTVDB All Seasons pages. All unique exact normalized titles are reserved globally before any fuzzy comparison; isolated numeric tokens are preserved. Fuzzy threshold is 0.80 and requires a verified compatible primary YouTube publication date; ambiguous titles remain review-only. No login or edit action is performed.',
  targets: [],
  warnings: [
    'A TheTVDB entry without a current public YouTube match may be a deleted/private/unlisted historical video and is NOT automatically an error.',
    'A YouTube video without a confident TheTVDB match may be a new missing episode, a non-episode upload, or a title variant.',
    'Duplicate TheTVDB season/episode codes are strong audit candidates but still require verification before editing.',
    'TheTVDB remains strictly read-only in this workflow.'
  ]
};

for (const target of TARGETS) {
  const page = await context.newPage();
  const item = { name: target.name, youtubeUrl: target.youtubeUrl, tvdbUrl: target.tvdbUrl, errors: [] };

  try {
    const yt = await collectYouTubeVideos(page, target.youtubeUrl);
    item.youtubeReachable = yt.reachable;
    item.youtubeVideoCount = yt.videos.length;
    item.youtubeVideos = yt.videos;

    const tvdb = await collectTvdbEpisodes(page, target.tvdbUrl);
    item.tvdbReachable = tvdb.reachable;
    item.tvdbPageTitle = tvdb.title;
    item.tvdbEpisodeCount = tvdb.episodes.length;
    item.tvdbEpisodes = tvdb.episodes;

    const duplicates = detectTvdbDuplicates(tvdb.episodes);
    item.tvdbDuplicateCodes = duplicates.duplicateCodes;
    item.tvdbDuplicateTitles = duplicates.duplicateTitles;

    const comparison = compareCatalogues(yt.videos, tvdb.episodes);
    item.summary = {
      matched: comparison.matches.length,
      youtubeWithoutConfidentTvdbMatch: comparison.missingFromTvdb.length,
      tvdbWithoutCurrentPublicYoutubeMatch: comparison.missingFromYoutube.length,
      tvdbDuplicateCodeGroups: duplicates.duplicateCodes.length,
      tvdbDuplicateTitleGroups: duplicates.duplicateTitles.length,
      exactUniqueMatches: comparison.summary.exactUnique,
      fuzzyChronologyVerifiedMatches: comparison.summary.fuzzyVerified,
      fuzzyCandidatesRequiringReview: comparison.summary.candidatesForReview
    };
    item.matches = comparison.matches;
    item.fuzzyCandidatesRequiringReview = comparison.fuzzyCandidates;
    item.youtubeWithoutConfidentTvdbMatch = comparison.missingFromTvdb;
    item.tvdbWithoutCurrentPublicYoutubeMatch = comparison.missingFromYoutube;
  } catch (error) {
    item.errors.push(error?.stack || error?.message || String(error));
  } finally {
    await page.close();
  }

  report.targets.push(item);
}

await fs.writeFile('reports/audit.json', JSON.stringify(report, null, 2));
await fs.writeFile('reports/summary.txt', report.targets.map(t => [
  t.name,
  `YouTube: ${t.youtubeVideoCount ?? 0}`,
  `TheTVDB: ${t.tvdbEpisodeCount ?? 0}`,
  `Matchs: ${t.summary?.matched ?? 0}`,
  `YT à examiner: ${t.summary?.youtubeWithoutConfidentTvdbMatch ?? 0}`,
  `TVDB sans vidéo publique actuelle: ${t.summary?.tvdbWithoutCurrentPublicYoutubeMatch ?? 0}`,
  `Doublons code TVDB: ${t.summary?.tvdbDuplicateCodeGroups ?? 0}`,
  `Erreurs: ${t.errors?.length ?? 0}`
].join(' | ')).join('\n'));

await browser.close();
console.log(await fs.readFile('reports/summary.txt', 'utf8'));
