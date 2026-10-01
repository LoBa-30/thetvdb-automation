import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const TARGETS = [
  {
    name: 'Squeezie',
    youtubeUrl: 'https://www.youtube.com/@Squeezie/videos',
    tvdbUrl: 'https://thetvdb.com/series/279758-show/allseasons/official'
  },
  {
    name: 'Djilsi',
    youtubeUrl: 'https://www.youtube.com/c/djilsi/videos',
    tvdbUrl: 'https://thetvdb.com/series/djilsi/allseasons/official'
  },
  {
    name: 'Maxime Biaggi',
    youtubeUrl: 'https://www.youtube.com/c/MaximeBiaggi/videos',
    tvdbUrl: 'https://thetvdb.com/series/maxime-biaggi/allseasons/official'
  },
  {
    name: 'Raska',
    youtubeUrl: 'https://www.youtube.com/@R4SK4/videos',
    tvdbUrl: 'https://thetvdb.com/series/raska/allseasons/official'
  }
];

const normalize = (value = '') => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(ft|feat|avec|youtube|officiel|official)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function similarity(a, b) {
  const A = new Set(normalize(a).split(' ').filter(w => w.length > 1));
  const B = new Set(normalize(b).split(' ').filter(w => w.length > 1));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const word of A) if (B.has(word)) intersection += 1;
  return intersection / Math.max(A.size, B.size);
}

async function dismissYouTubeConsent(page) {
  const candidates = [
    'button:has-text("Tout accepter")',
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'button:has-text("Tout refuser")'
  ];
  for (const selector of candidates) {
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
  for (let i = 0; i < 120 && stableRounds < 5; i += 1) {
    const count = await page.locator('a[href*="/watch?v="]').count();
    stableRounds = count === previous ? stableRounds + 1 : 0;
    previous = count;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(900);
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
      found.set(videoId, {
        id: videoId,
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`
      });
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
      code: `S${season}E${episode}`,
      title: episodeTitle.trim(),
      firstAired: possibleDate
    });
  }

  return { reachable: Boolean(response?.ok()), title, episodes };
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

    if (bestIndex >= 0 && bestScore >= 0.62) {
      usedEpisodeIndexes.add(bestIndex);
      matches.push({
        youtube: video,
        tvdb: episodes[bestIndex],
        similarity: Number(bestScore.toFixed(3))
      });
    } else {
      missingFromTvdb.push({ ...video, bestSimilarity: Number(bestScore.toFixed(3)) });
    }
  }

  const missingFromYoutube = episodes
    .filter((_, index) => !usedEpisodeIndexes.has(index));

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
  methodology: 'YouTube video titles are collected by scrolling the public Videos tab. TheTVDB episodes are collected from the public All Seasons page. Matching is title-based and intentionally conservative. No login or edit action is performed.',
  targets: [],
  warnings: [
    'A title mismatch is only a candidate discrepancy, not an instruction to edit.',
    'Shorts/live streams may require dedicated filtering in a later pass.',
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

    const comparison = compareCatalogues(yt.videos, tvdb.episodes);
    item.summary = {
      matched: comparison.matches.length,
      youtubeWithoutConfidentTvdbMatch: comparison.missingFromTvdb.length,
      tvdbWithoutConfidentYoutubeMatch: comparison.missingFromYoutube.length
    };
    item.matches = comparison.matches;
    item.youtubeWithoutConfidentTvdbMatch = comparison.missingFromTvdb;
    item.tvdbWithoutConfidentYoutubeMatch = comparison.missingFromYoutube;
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
  `Matched: ${t.summary?.matched ?? 0}`,
  `YT sans match: ${t.summary?.youtubeWithoutConfidentTvdbMatch ?? 0}`,
  `TVDB sans match: ${t.summary?.tvdbWithoutConfidentYoutubeMatch ?? 0}`,
  t.errors?.length ? `Erreurs: ${t.errors.length}` : 'Erreurs: 0'
].join(' | ')).join('\n'));

await browser.close();
console.log(await fs.readFile('reports/summary.txt', 'utf8'));
