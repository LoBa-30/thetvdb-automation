import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const VIDEO_ID = 'xkGjW_FR8vI';
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const HANDLE_URL = 'https://www.youtube.com/@elianventre';

await fs.mkdir('reports', { recursive: true });

const base = JSON.parse(await fs.readFile('reports/batch-resolution.json', 'utf8'));
const elian = (base.resolved || []).find(x => x.target === 'Elian Ventre');

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'ELIAN_YOUTUBE_RSS_READ_ONLY',
  videoId: VIDEO_ID,
  channelId: null,
  publishedAt: null,
  publishedDate: null,
  feedTitle: null,
  seasonCount: elian?.seasonCount ?? null,
  currentLastAirdate: elian?.currentLastAirdate ?? null,
  proposedEpisodeNumber: null,
  identityProof: null,
  readyForBatchApply: false,
  diagnostics: []
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
});
const page = await context.newPage();

async function htmlOf(url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (!response || response.status() >= 400) return null;
  await page.waitForTimeout(1200);
  return page.content().catch(() => null);
}

function extractChannelId(html = '') {
  return html.match(/"channelId":"(UC[\w-]+)"/)?.[1]
    || html.match(/"externalId":"(UC[\w-]+)"/)?.[1]
    || html.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1]
    || null;
}

try {
  const watchHtml = await htmlOf(VIDEO_URL);
  report.channelId = extractChannelId(watchHtml || '');

  if (!report.channelId) {
    const handleHtml = await htmlOf(HANDLE_URL);
    report.channelId = extractChannelId(handleHtml || '');
  }
  if (!report.channelId) throw new Error('Unable to resolve Elian channel ID from YouTube public pages.');

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${report.channelId}`;
  const feedResponse = await context.request.get(feedUrl, { timeout: 60000 }).catch(() => null);
  if (!feedResponse?.ok()) throw new Error(`YouTube RSS HTTP ${feedResponse?.status() ?? 'n/a'}`);
  const xml = await feedResponse.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const entry = entries.find(e => new RegExp(`<yt:videoId>${VIDEO_ID}<\\/yt:videoId>`).test(e));
  if (!entry) throw new Error('Target video is not present in the current official YouTube RSS feed.');

  report.identityProof = 'EXACT_VIDEO_ID_IN_OFFICIAL_YOUTUBE_RSS';
  report.publishedAt = entry.match(/<published>([^<]+)<\/published>/)?.[1] || null;
  report.publishedDate = report.publishedAt ? new Date(report.publishedAt).toISOString().slice(0, 10) : null;
  report.feedTitle = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    ?.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') || null;

  const dateOk = /^2026-\d{2}-\d{2}$/.test(report.publishedDate || '');
  const orderOk = report.seasonCount === 7 && dateOk && (!report.currentLastAirdate || report.publishedDate > report.currentLastAirdate);

  report.proposedEpisodeNumber = orderOk ? 8 : null;
  report.readyForBatchApply = Boolean(report.identityProof && report.feedTitle && dateOk && orderOk);

  if (!dateOk) report.diagnostics.push('RSS publish date missing or invalid.');
  if (!report.feedTitle) report.diagnostics.push('RSS title missing.');
  if (!orderOk) report.diagnostics.push(`Cannot prove E08 ordering: seasonCount=${report.seasonCount}, last=${report.currentLastAirdate}, publish=${report.publishedDate}.`);
} catch (error) {
  report.diagnostics.push(error?.message || String(error));
} finally {
  await browser.close();
}

await fs.writeFile('reports/elian-rss-resolution.json', JSON.stringify(report, null, 2));
const text = [
  `Mode: ${report.mode}`,
  `Channel ID: ${report.channelId || '?'}`,
  `Video: ${report.videoId}`,
  `Identity proof: ${report.identityProof || '?'}`,
  `RSS title: ${report.feedTitle || '?'}`,
  `Published: ${report.publishedAt || '?'}`,
  `Published date: ${report.publishedDate || '?'}`,
  `Season count: ${report.seasonCount ?? '?'}`,
  `Current last airdate: ${report.currentLastAirdate || '?'}`,
  `Proposed episode: E${report.proposedEpisodeNumber || '?'}`,
  `Ready for batch apply: ${report.readyForBatchApply}`,
  ...report.diagnostics.map(x => `- ${x}`)
].join('\n');
await fs.writeFile('reports/elian-rss-resolution.txt', text);
console.log(text);

if (!report.readyForBatchApply) process.exitCode = 2;
