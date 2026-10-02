import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const YEARS = Array.from({length: 11}, (_, i) => 2016 + i);
const BASE = 'https://thetvdb.com/series/335805-show';

function parseDate(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}

function parseBody(year, text) {
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  const out = [];
  const dateRe = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/;
  for (let i = 0; i < lines.length; i++) {
    let code = null, title = null;
    let m = lines[i].match(new RegExp('^S' + year + 'E(\\d+)\\s+(.+)$'));
    if (m) {
      code = Number(m[1]);
      title = m[2].trim();
    } else {
      m = lines[i].match(new RegExp('^S' + year + 'E(\\d+)$'));
      if (!m) continue;
      code = Number(m[1]);
      title = lines[i+1] || '';
      i += 1;
    }

    let j = i + 1;
    let flag = null;
    if (/^season (premiere|finale)$/i.test(lines[j] || '')) { flag = lines[j].toLowerCase(); j += 1; }
    const firstAired = dateRe.test(lines[j] || '') ? lines[j] : null;
    if (firstAired) j += 1;
    if (lines[j] === 'YouTube') j += 1;
    const runtime = /^\d+$/.test(lines[j] || '') ? Number(lines[j]) : null;
    out.push({
      season: year,
      episode: code,
      code: 'S' + year + 'E' + String(code).padStart(2,'0'),
      title,
      firstAired,
      firstAiredIso: firstAired ? parseDate(firstAired) : null,
      runtime,
      flag
    });
  }
  return out;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'fr-FR',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36'
});
const report = { generatedAt: new Date().toISOString(), source: 'CURRENT_THETVDB_LIVE', seasons: [], unassigned: [] };

for (const year of YEARS) {
  const page = await context.newPage();
  const url = `${BASE}/seasons/official/${year}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  const episodes = parseBody(year, body);
  report.seasons.push({ year, url, count: episodes.length, episodes });
  await page.close();
}

{
  const page = await context.newPage();
  const url = `${BASE}/seasons/official/unassigned`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(900);
  const body = await page.locator('body').innerText();
  const lines = body.split('\n').map(x=>x.trim()).filter(Boolean);
  report.unassigned = lines.filter(x => /^S(?:0|Unknown)E/i.test(x));
  report.unassignedBody = body.slice(0,12000);
  await page.close();
}

await browser.close();
await fs.mkdir('reports/joyca-live', { recursive: true });
await fs.writeFile('reports/joyca-live/tvdb-live.json', JSON.stringify(report, null, 2));

const summary = report.seasons.map(s => {
  const flags = s.episodes.filter(e => e.flag).map(e => `${e.code}:${e.flag}`).join(', ') || 'none';
  return `${s.year}: ${s.count} episodes | flags ${flags}`;
}).join('\n') + `\nTotal: ${report.seasons.reduce((n,s)=>n+s.count,0)}\nUnassigned markers: ${report.unassigned.length}\n`;
await fs.writeFile('reports/joyca-live/summary.txt', summary);
console.log(summary);
