import fs from 'node:fs/promises';

const TARGETS = {
  djilsi: { name: 'Djilsi', youtubeUrl: 'https://www.youtube.com/c/djilsi/videos', tvdbUrl: 'https://thetvdb.com/series/djilsi/allseasons/official' },
  elian: { name: 'Elian Ventre', youtubeUrl: 'https://www.youtube.com/@elianventre/videos', tvdbUrl: 'https://thetvdb.com/series/elian-ventre-462729/allseasons/official' },
  raska: { name: 'Raska', youtubeUrl: 'https://www.youtube.com/@R4SK4/videos', tvdbUrl: 'https://thetvdb.com/series/raska/allseasons/official' },
  maxime: { name: 'Maxime Biaggi', youtubeUrl: 'https://www.youtube.com/c/MaximeBiaggi/videos', tvdbUrl: 'https://thetvdb.com/series/maxime-biaggi/allseasons/official' },
  squeezie: { name: 'Squeezie', youtubeUrl: 'https://www.youtube.com/@Squeezie/videos', tvdbUrl: 'https://thetvdb.com/series/279758-show/allseasons/official' },
  mastu: { name: 'Mastu', youtubeUrl: 'https://www.youtube.com/channel/UCAhaFPP6v3WCfK5Tjao0B7A/videos', tvdbUrl: 'https://thetvdb.com/series/346011-show/allseasons/official' },
  amixem: { name: 'Amixem', youtubeUrl: 'https://www.youtube.com/c/Amixem/videos', tvdbUrl: 'https://thetvdb.com/series/328213-show/allseasons/official' },
  joyca: { name: 'Joyca', youtubeUrl: 'https://www.youtube.com/c/JOYCA-JORDAN/videos', tvdbUrl: 'https://thetvdb.com/series/335805-show/allseasons/official' },
  mcfly: { name: 'Mcfly & Carlito', youtubeUrl: 'https://www.youtube.com/c/LeFatShow/videos', tvdbUrl: 'https://thetvdb.com/series/338282-show/allseasons/official' }
};

const key = process.argv[2];
const target = TARGETS[key];
if (!target) throw new Error(`Unknown target: ${key}`);

const sourceUrl = new URL('./audit.js', import.meta.url);
const runtimeUrl = new URL(`./.audit-${key}-runtime.mjs`, import.meta.url);
let source = await fs.readFile(sourceUrl, 'utf8');
const replacement = `const TARGETS = [${JSON.stringify(target)}];`;
source = source.replace(/const TARGETS = \[[\s\S]*?\n\];/, replacement);
source = source.replace(/for \(let i = 0; i < 140/g, 'for (let i = 0; i < 120');
source = source.replace(/await page\.waitForTimeout\(850\);/g, 'await page.waitForTimeout(450);');
const out = `reports/${key}`;
source = source.replace("await fs.mkdir('reports', { recursive: true });", `await fs.mkdir('${out}', { recursive: true });`);
source = source.replaceAll("'reports/audit.json'", `'${out}/audit.json'`);
source = source.replaceAll("'reports/summary.txt'", `'${out}/summary.txt'`);
if (!source.includes(`'${out}/audit.json'`)) throw new Error('Output patch failed');

await fs.writeFile(runtimeUrl, source, 'utf8');
await import(`./.audit-${key}-runtime.mjs`);
await fs.rm(runtimeUrl, { force: true });
