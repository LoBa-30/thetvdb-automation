import fs from 'node:fs/promises';

const sourceUrl = new URL('./audit.js', import.meta.url);
const runtimeUrl = new URL('./.audit-all-runtime.mjs', import.meta.url);
const source = await fs.readFile(sourceUrl, 'utf8');

const replacement = `const TARGETS = [
  { name: 'Djilsi', youtubeUrl: 'https://www.youtube.com/c/djilsi/videos', tvdbUrl: 'https://thetvdb.com/series/djilsi/allseasons/official' },
  { name: 'Elian Ventre', youtubeUrl: 'https://www.youtube.com/@elianventre/videos', tvdbUrl: 'https://thetvdb.com/series/elian-ventre-462729/allseasons/official' },
  { name: 'Raska', youtubeUrl: 'https://www.youtube.com/@R4SK4/videos', tvdbUrl: 'https://thetvdb.com/series/raska/allseasons/official' },
  { name: 'Maxime Biaggi', youtubeUrl: 'https://www.youtube.com/c/MaximeBiaggi/videos', tvdbUrl: 'https://thetvdb.com/series/maxime-biaggi/allseasons/official' },
  { name: 'Squeezie', youtubeUrl: 'https://www.youtube.com/@Squeezie/videos', tvdbUrl: 'https://thetvdb.com/series/279758-show/allseasons/official' },
  { name: 'Mastu', youtubeUrl: 'https://www.youtube.com/channel/UCAhaFPP6v3WCfK5Tjao0B7A/videos', tvdbUrl: 'https://thetvdb.com/series/346011-show/allseasons/official' },
  { name: 'Amixem', youtubeUrl: 'https://www.youtube.com/c/Amixem/videos', tvdbUrl: 'https://thetvdb.com/series/328213-show/allseasons/official' },
  { name: 'Joyca', youtubeUrl: 'https://www.youtube.com/c/JOYCA-JORDAN/videos', tvdbUrl: 'https://thetvdb.com/series/335805-show/allseasons/official' },
  { name: 'Mcfly & Carlito', youtubeUrl: 'https://www.youtube.com/c/LeFatShow/videos', tvdbUrl: 'https://thetvdb.com/series/338282-show/allseasons/official' }
];`;

const patched = source.replace(/const TARGETS = \[[\s\S]*?\n\];/, replacement);
if (patched === source) throw new Error('TARGETS block not found in audit.js');

await fs.writeFile(runtimeUrl, patched, 'utf8');
await import('./.audit-all-runtime.mjs');
await fs.rm(runtimeUrl, { force: true });
