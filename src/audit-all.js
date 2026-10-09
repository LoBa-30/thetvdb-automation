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

// Lower bounds, not exact counts. YouTube bounds protect against incomplete lazy-loading.\n// TVDB public all-seasons pages can lag authenticated edits, so their lower bounds use the last stable public catalogue baseline.\n// Authenticated post-apply verification remains authoritative for recent writes.\n// A result below one of these bounds is treated as an incomplete scrape.
const MINIMUMS = {
  'Djilsi': { youtube: 215, tvdb: 213 },
  'Elian Ventre': { youtube: 29, tvdb: 28 },
  'Raska': { youtube: 149, tvdb: 150 },
  'Maxime Biaggi': { youtube: 64, tvdb: 64 },
  'Squeezie': { youtube: 1585, tvdb: 1659 },
  'Mastu': { youtube: 360, tvdb: 374 },
  'Amixem': { youtube: 889, tvdb: 974 },
  'Joyca': { youtube: 449, tvdb: 470 },
  'Mcfly & Carlito': { youtube: 576, tvdb: 582 }
};

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

function validateCandidate(target, candidate) {
  if (!candidate) throw new Error('single-target report missing target');
  const min = MINIMUMS[target.name];
  const yt = Number(candidate.youtubeVideoCount || 0);
  const tvdb = Number(candidate.tvdbEpisodeCount || 0);
  const errors = candidate.errors?.length || 0;

  if (errors) throw new Error(`target reported ${errors} error(s)`);
  if (!min) throw new Error(`missing minimum guard for ${target.name}`);
  if (yt < min.youtube) throw new Error(`incomplete YouTube inventory: ${yt} < minimum ${min.youtube}`);
  if (tvdb < min.tvdb) throw new Error(`incomplete TheTVDB inventory: ${tvdb} < minimum ${min.tvdb}`);
}

await fs.mkdir('reports', { recursive: true });
const merged = {
  generatedAt: new Date().toISOString(),
  mode: 'READ_ONLY_AUDIT_9_CHANNELS_ISOLATED_STRICT_MINIMUMS',
  methodology: 'Each channel is audited in an isolated browser process and must meet known lower-bound counts before its result is accepted. Every accepted result includes an exact-first, globally reserved title match; fuzzy suggestions require primary chronology verification. Equal catalogue counts alone never mark a channel complete.',
  minimums: MINIMUMS,
  targets: [],
  warnings: []
};

for (let index = 0; index < TARGETS.length; index += 1) {
  const target = TARGETS[index];
  const replacement = `const TARGETS = [${JSON.stringify(target)}];`;
  let patched = source.replace(/const TARGETS = \[[\s\S]*?\n\];/, replacement);
  if (patched === source) throw new Error('TARGETS block not found in audit.js');

  // Large catalogues need long scrolling and several stable rounds before stopping.
  patched = patched
    .replace('i < 140 && stableRounds < 6', 'i < 360 && stableRounds < 12')
    .replace('await page.waitForTimeout(850);', 'await page.waitForTimeout(1000);');

  const runtimePath = path.join(here, `.audit-one-${index}.mjs`);
  await fs.writeFile(runtimePath, patched, 'utf8');

  let item = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && !item; attempt += 1) {
    try {
      await runNode(runtimePath);
      const single = JSON.parse(await fs.readFile('reports/audit.json', 'utf8'));
      const candidate = single.targets?.[0] || null;
      validateCandidate(target, candidate);
      item = candidate;
    } catch (error) {
      lastError = error;
      merged.warnings.push(`${target.name} attempt ${attempt}: ${error?.message || String(error)}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  if (!item) {
    item = {
      name: target.name,
      youtubeUrl: target.youtubeUrl,
      tvdbUrl: target.tvdbUrl,
      errors: [`Strict isolated audit failed after 3 attempts: ${lastError?.message || String(lastError)}`]
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

const failed = merged.targets.filter(t => (t.errors?.length || 0) > 0);
merged.complete = failed.length === 0 && merged.targets.length === TARGETS.length;

await fs.writeFile('reports/audit.json', JSON.stringify(merged, null, 2));
await fs.writeFile('reports/summary.txt', summary + `\n\nStrict 9-channel audit complete: ${merged.complete}`);
console.log(summary);
console.log(`Strict 9-channel audit complete: ${merged.complete}`);

if (!merged.complete) {
  console.error(`Strict audit incomplete: ${failed.map(x => x.name).join(', ') || 'target count mismatch'}`);
  process.exitCode = 2;
}
