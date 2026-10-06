import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const TARGETS = [
  { name: 'Squeezie', youtubeUrl: 'https://www.youtube.com/@Squeezie/videos', tvdbUrl: 'https://thetvdb.com/series/279758-show/allseasons/official' },
  { name: 'Djilsi', youtubeUrl: 'https://www.youtube.com/c/djilsi/videos', tvdbUrl: 'https://thetvdb.com/series/djilsi/allseasons/official' },
  { name: 'Maxime Biaggi', youtubeUrl: 'https://www.youtube.com/c/MaximeBiaggi/videos', tvdbUrl: 'https://thetvdb.com/series/maxime-biaggi/allseasons/official' },
  { name: 'Raska', youtubeUrl: 'https://www.youtube.com/@R4SK4/videos', tvdbUrl: 'https://thetvdb.com/series/raska/allseasons/official' }
];

const normalizeBase = (value = '') => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/[^a-z0-9@_.-]+/g, ' ')
  .replace(/\b(ft|feat|avec|youtube|officiel|official|ytb|le|la|les|un|une|des|de|du|et)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Strict normalization keeps guest handles and explicit episode numbers.
// This prevents repeated formats such as "TROUVE LE GÂTEAU" or travel series
// from being cross-matched solely because their shared base title is identical.
const normalizeStrict = (value = '') => normalizeBase(value)
  .replace(/@([a-z0-9_.-]+)/gi, '$1')
  .replace(/\bepisode\s*(\d+)\b/gi, 'ep $1')
  .replace(/\s+/g, ' ')
  .trim();

// Relaxed normalization remains available as a small fallback signal for
// harmless title variants, but it can no longer dominate an exact guest/part match.
const normalizeRelaxed = (value = '') => normalizeBase(value)
  .replace(/@[a-z0-9_.-]+/gi, ' ')
  .replace(/\b(?:ep|episode)\s*\d+\b/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function tokenSimilarity(a, b, normalizer) {
  const A = new Set(normalizer(a).split(' ').filter(w => w.length > 1));
  const B = new Set(normalizer(b).split(' ').filter(w => w.length > 1));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const word of A) if (B.has(word)) intersection += 1;
  const overlap = intersection / Math.max(A.size, B.size);
  const containment = intersection / Math.min(A.size, B.size);
  return (overlap * 0.65) + (containment * 0.35);
}

function similarity(a, b) {
  const strict = tokenSimilarity(a, b, normalizeStrict);
  const relaxed = tokenSimilarity(a, b, normalizeRelaxed);
  return (strict * 0.8) + (relaxed * 0.2);
}

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
    const key = normalizeStrict(episode.title);
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

function compareCatalogues(videos, episodes) {
  const usedEpisodeIndexes = new Set();
  const matches = [];
  const missingFromTvdb = [];

  for (const video of videos) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < episodes.length; i += 1) {
      if (usedEpisodeIndexes.has(i)) continue;
      const score = similarity(video.title, episodes[i].title);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= 0.64) {
      usedEpisodeIndexes.add(bestIndex);
      matches.push({ youtube: video, tvdb: episodes[bestIndex], similarity: Number(bestScore.toFixed(3)) });
    } else {
      const bestEpisode = bestIndex >= 0 ? episodes[bestIndex] : null;
      missingFromTvdb.push({
        ...video,
        bestSimilarity: Number(bestScore.toFixed(3)),
        bestCandidate: bestEpisode ? { code: bestEpisode.code, title: bestEpisode.title, firstAired: bestEpisode.firstAired } : null,
        classification: bestScore >= 0.42 ? 'POSSIBLE_TITLE_VARIANT' : 'LIKELY_MISSING_FROM_TVDB_OR_NON_EPISODE'
      });
    }
  }

  const missingFromYoutube = episodes
    .map((episode, index) => ({ episode, index }))
    .filter(({ index }) => !usedEpisodeIndexes.has(index))
    .map(({ episode }) => ({
      ...episode,
      classification: 'TVDB_ENTRY_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH'
    }));

  return { matches, missingFromTvdb, missingFromYoutube };
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
  methodology: 'Public YouTube Videos tabs are compared to public TheTVDB All Seasons pages. Matching now preserves guest handles and explicit episode numbers as the dominant signal, with a small relaxed fallback for harmless variants. Duplicate-title detection also preserves those distinguishing tokens. No login or edit action is performed.',
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
      tvdbDuplicateTitleGroups: duplicates.duplicateTitles.length
    };
    item.matches = comparison.matches;
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
