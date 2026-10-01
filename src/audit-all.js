import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sourceUrl = new URL('./audit.js', import.meta.url);
const source = await fs.readFile(sourceUrl, 'utf8');
const here = path.dirname(fileURLToPath(import.meta.url));

const TARGETS = [
  { name: 'Djilsi', youtubeUrl: 'https://www.youtube.com/c/djilsi/videos', tvdbUrl: 'https://thetvdb.com/series/djilsi/allseasons/official' },
  { name: 'Elian Ventre', youtubeUrl: 'https://www.youtube.com/@elianventre/videos', tvdbUrl: 'https://thetvdb.com/series/elian-ventre-462729/allseasons/official' },
  { name: 'Raska', youtubeUrl: 'https://www.youtube.com/@R4SK4/videos', tvdbUrl: 'https://thetvdb.com/series/raska/allseasons/official' },
  { name: 'Maxime Biaggi', youtubeUrl: 'https://www.youtube.com/c/MaximeBiaggi/videos', tvdbUrl: 'https://thetvdb.com/series/maxime-biaggi/allseasons/official' },
  { name: 'Squeezie', youtubeUrl: 'https://www.youtube.com/@Squeezie/videos', tvdbUrl: 'https://thetvdb.com/series/279758-show/allseasons/official' },
  { name: 'Mastu', youtubeUrl: 'https://www.youtube.com/channel/UCAhaFPP6v3WCfK5Tjao0B7A/videos', tvdbUrl: 'https://thetvdb.com/series/346011-show/allseasons/official' },
  { name: 'Amixem', youtubeUrl: 'https://www.youtube.com/c/Amixem/videos', tvdbUrl: 'https://thetvdb.com/series/328213-show/allseasons/official' },
  { name: 'Joyca', youtubeUrl: 'https://www.youtube.com/c/JOYCA-JORDAN/videos', tvdbUrl: 'https://thetvdb.com/series/335805-show/allseasons/official' },
  { name: 'Mcfly & Carlito', youtubeUrl: 'https://www.youtube.com/c/LeFatShow/videos', tvdbUrl: 'https://thetvdb.com/series/338282-show/allseasons/official' }
];

function runNode(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { err += d; process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`child exited ${code}: ${err.slice(-2000)}`)));
  });
}

await fs.mkdir('reports', { recursive: true });
const merged = {
  generatedAt: new Date().toISOString(),
  mode: 'READ_ONLY_AUDIT_9_CHANNELS_ISOLATED',
  methodology: 'Each channel is audited in an isolated browser process, then the reports are merged. This prevents a transient YouTube/TheTVDB failure on one channel from contaminating later targets.',
  targets: [],
  warnings: []
};

for (let index = 0; index < TARGETS.length; index += 1) {
  const target = TARGETS[index];
  const replacement = `const TARGETS = [${JSON.stringify(target)}];`;
  let patched = source.replace(/const TARGETS = \[[\s\S]*?\n\];/, replacement);
  if (patched === source) throw new Error('TARGETS block not found in audit.js');

  // Give large channels more time to stabilize instead of accepting an early lazy-loading plateau.
  patched = patched
    .replace('i < 140 && stableRounds < 6', 'i < 280 && stableRounds < 10')
    .replace('await page.waitForTimeout(850);', 'await page.waitForTimeout(1000);');

  const runtimePath = path.join(here, `.audit-one-${index}.mjs`);
  await fs.writeFile(runtimePath, patched, 'utf8');

  let item = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2 && !item; attempt += 1) {
    try {
      await runNode(runtimePath);
      const single = JSON.parse(await fs.readFile('reports/audit.json', 'utf8'));
      const candidate = single.targets?.[0] || null;
      if (!candidate) throw new Error('single-target report missing target');
      const suspiciousTvdbZero = (candidate.youtubeVideoCount || 0) > 0 && (candidate.tvdbEpisodeCount || 0) === 0;
      if (candidate.errors?.length || suspiciousTvdbZero) {
        throw new Error(`suspicious result: errors=${candidate.errors?.length || 0}, yt=${candidate.youtubeVideoCount || 0}, tvdb=${candidate.tvdbEpisodeCount || 0}`);
      }
      item = candidate;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (!item) {
    item = {
      name: target.name,
      youtubeUrl: target.youtubeUrl,
      tvdbUrl: target.tvdbUrl,
      errors: [`Isolated audit failed after retry: ${lastError?.message || String(lastError)}`]
    };
  }
  merged.targets.push(item);
  await fs.rm(runtimePath, { force: true });
}

const summary = merged.targets.map(t => [
  t.name,
  `YouTube: ${t.youtubeVideoCount ?? 0}`,
  `TheTVDB: ${t.tvdbEpisodeCount ?? 0}`,
  `Matchs: ${t.summary?.matched ?? 0}`,
  `YT à examiner: ${t.summary?.youtubeWithoutConfidentTvdbMatch ?? 0}`,
  `TVDB sans vidéo publique actuelle: ${t.summary?.tvdbWithoutCurrentPublicYoutubeMatch ?? 0}`,
  `Doublons code TVDB: ${t.summary?.tvdbDuplicateCodeGroups ?? 0}`,
  `Erreurs: ${t.errors?.length ?? 0}`
].join(' | ')).join('\n');

await fs.writeFile('reports/audit.json', JSON.stringify(merged, null, 2));
await fs.writeFile('reports/summary.txt', summary);
console.log(summary);
