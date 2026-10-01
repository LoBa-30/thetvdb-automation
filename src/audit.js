import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const TARGETS = [
  // Add one object per series/channel, for example:
  // { name: 'Djilsi', youtubeUrl: 'https://www.youtube.com/@Djilsi/videos', tvdbUrl: 'https://thetvdb.com/series/djilsi' }
];

const now = new Date().toISOString();
await fs.mkdir('reports', { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36'
});
const page = await context.newPage();

const report = {
  generatedAt: now,
  mode: 'READ_ONLY_AUDIT',
  targets: [],
  warnings: []
};

for (const target of TARGETS) {
  const item = {
    name: target.name,
    youtubeUrl: target.youtubeUrl,
    tvdbUrl: target.tvdbUrl,
    youtubeReachable: false,
    tvdbReachable: false,
    tvdbTitle: null,
    notes: []
  };

  try {
    const ytResponse = await page.goto(target.youtubeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    item.youtubeReachable = Boolean(ytResponse?.ok());
    item.notes.push('YouTube collection logic not enabled yet: connectivity test only.');
  } catch (error) {
    item.notes.push(`YouTube error: ${error.message}`);
  }

  try {
    const tvdbResponse = await page.goto(target.tvdbUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    item.tvdbReachable = Boolean(tvdbResponse?.ok());
    item.tvdbTitle = await page.title();
    item.notes.push('TheTVDB is opened in read-only mode. No login, form submission, deletion, creation or edit is performed.');
  } catch (error) {
    item.notes.push(`TheTVDB error: ${error.message}`);
  }

  report.targets.push(item);
}

if (TARGETS.length === 0) {
  report.warnings.push('No target configured yet. Add channels/series before running the real audit.');
}

await fs.writeFile('reports/audit.json', JSON.stringify(report, null, 2));
await browser.close();

console.log(JSON.stringify(report, null, 2));
