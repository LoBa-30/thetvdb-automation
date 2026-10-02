import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const YEARS = Array.from({length: 11}, (_, i) => 2016 + i);
const BASE = 'https://thetvdb.com/series/335805-show';
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const dateRe = new RegExp('^(' + MONTHS + ')\\s+\\d{1,2},\\s+\\d{4}$');

function parseBody(year, text) {
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp('^S' + year + 'E(\\d+)$'));
    if (!m) continue;
    const episode = Number(m[1]);
    let j = i + 1;
    const titleParts = [];
    let flag = null;
    while (j < lines.length && !dateRe.test(lines[j]) && !/^season (premiere|finale)$/i.test(lines[j]) && !/^S\\d{4}E\\d+$/.test(lines[j])) {
      titleParts.push(lines[j]);
      j++;
    }
    if (j < lines.length && /^season (premiere|finale)$/i.test(lines[j])) {
      flag = lines[j].toLowerCase();
      j++;
    }
    const firstAired = j < lines.length && dateRe.test(lines[j]) ? lines[j] : null;
    if (firstAired) j++;
    if (lines[j] === 'YouTube') j++;
    const runtime = j < lines.length && /^\\d+$/.test(lines[j]) ? Number(lines[j]) : null;
    out.push({ season: year, episode, code: 'S' + year + 'E' + String(episode).padStart(2,'0'), title: titleParts.join(' '), firstAired, runtime, flag });
  }
  return out;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'fr-FR' });
const report = { generatedAt: new Date().toISOString(), source: 'CURRENT_THETVDB_LIVE', seasons: [], unassigned: [] };

for (const year of YEARS) {
  const page = await context.newPage();
  const url = `${BASE}/seasons/official/${year}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(900);
  const body = await page.locator('body').innerText();
  const episodes = parseBody(year, body);

  const linkInfo = await page.locator('a[href*="/series/335805-show/episodes/"]').evaluateAll(anchors => anchors.map(a => {
    const href = a.href || a.getAttribute('href') || '';
    const row = a.closest('tr') || a.closest('[class*="list-group-item"]') || a.parentElement;
    const text = (row?.innerText || a.innerText || '').replace(/\s+/g, ' ').trim();
    const code = (text.match(/S\d{4}E\d+/) || [])[0] || null;
    let img = row?.querySelector('img') || null;
    const src = img ? (img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src')) : null;
    return { href, text, code, image: src };
  }));

  const byCode = new Map();
  for (const x of linkInfo) {
    if (!x.code) continue;
    const id = (x.href.match(/\/episodes\/(\d+)/) || [])[1] || null;
    const current = byCode.get(x.code) || {};
    byCode.set(x.code, { id: current.id || id, episodeUrl: current.episodeUrl || x.href, artwork: current.artwork || (x.image && !/missing|logo/i.test(x.image) ? x.image : null) });
  }

  for (const e of episodes) Object.assign(e, byCode.get(e.code) || { id: null, episodeUrl: null, artwork: null });
  report.seasons.push({ year, url, count: episodes.length, episodes });
  await page.close();
}

{
  const page = await context.newPage();
  const url = `${BASE}/seasons/official/unassigned`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);
  const body = await page.locator('body').innerText();
  const links = await page.locator('a[href*="/series/335805-show/episodes/"]').evaluateAll(as => as.map(a => ({
    href: a.href || a.getAttribute('href') || '',
    text: (a.closest('tr')?.innerText || a.innerText || '').replace(/\s+/g,' ').trim()
  })));
  report.unassigned = links;
  report.unassignedBody = body.slice(0, 12000);
  await page.close();
}

await browser.close();
await fs.mkdir('reports/joyca-live', { recursive: true });
await fs.writeFile('reports/joyca-live/tvdb-live.json', JSON.stringify(report, null, 2));

const summary = report.seasons.map(s => {
  const arts = s.episodes.filter(e => e.artwork).length;
  const flags = s.episodes.filter(e => e.flag).map(e => `${e.code}:${e.flag}`).join(', ') || 'none';
  return `${s.year}: ${s.count} episodes | artwork ${arts}/${s.count} | flags ${flags}`;
}).join('\n') + `\nUnassigned links: ${report.unassigned.length}\n`;
await fs.writeFile('reports/joyca-live/summary.txt', summary);
console.log(summary);
