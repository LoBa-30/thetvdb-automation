import fs from 'node:fs/promises';

const plan = JSON.parse(await fs.readFile('config/full-batch-plan.json','utf8'));
const audit = JSON.parse(await fs.readFile('reports/audit.json','utf8'));

const normalize = (value='') => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const byTarget = new Map((audit.targets||[]).map(t=>[t.name,t]));

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'BATCH_PREFLIGHT_READ_ONLY',
  policy: plan.policy,
  ready: [],
  resolve: [],
  verifyOnly: [],
  blocked: [],
  summary: {}
};

for (const item of plan.items || []) {
  const target = byTarget.get(item.YouTubeur);
  const base = { youtubeur:item.YouTubeur, type:item.Type, code:item['Code / zone'], title:item['Titre / élément'], desired:item.desired||null, sourceStatus:item.batchStatus };
  if (!target) {
    report.blocked.push({...base, reason:'Target missing from 9-channel audit output'});
    continue;
  }

  if (item.batchStatus === 'Contrôle seulement' || item.batchStatus === 'Déjà appliqué — vérification') {
    report.verifyOnly.push({...base, reason:item.batchAction});
    continue;
  }

  const code = String(item['Code / zone']||'');
  const exactCode = /^S\d{4}E\d{2,3}$/.test(code) ? code : null;
  const ep = exactCode ? (target.tvdbEpisodes||[]).find(e=>e.code===exactCode) : null;

  if (item.batchStatus === 'Prête') {
    if (!ep) report.resolve.push({...base, reason:'Episode code not found in current public Aired Order; authenticated detail lookup required'});
    else report.ready.push({...base, current:{title:ep.title,firstAired:ep.firstAiredIso}, reason:'Exact desired value exists in validated audit; write only if authenticated detail differs'});
    continue;
  }

  if (item.YouTubeur === 'Elian Ventre' || item.YouTubeur === 'Mastu' || item.YouTubeur === 'Squeezie') {
    const needle = normalize(item['Titre / élément']||'');
    const ytCandidate = (target.youtubeWithoutConfidentTvdbMatch||[]).find(v=>normalize(v.title)===needle || normalize(v.title).includes(needle) || needle.includes(normalize(v.title)));
    const tvMatch = (target.tvdbEpisodes||[]).find(e=>normalize(e.title)===needle);
    if (tvMatch) report.verifyOnly.push({...base, reason:'A matching TVDB episode now exists; do not recreate', current:tvMatch});
    else if (ytCandidate) report.resolve.push({...base, reason:'Still missing from confident TVDB match; resolve publish date, exact season/number and form route before batch apply', youtube:ytCandidate});
    else report.resolve.push({...base, reason:'Candidate not found in current audit discrepancy list; manual/authenticated resolution required'});
    continue;
  }

  if (code === 'Unassigned') {
    report.resolve.push({...base, reason:'Unassigned entries require authenticated individual ID/title/date inspection; no bulk reassignment permitted'});
    continue;
  }

  if (item.batchStatus === 'À vérifier après écriture précédente') {
    report.resolve.push({...base, reason:'Post-apply Djilsi state must be inspected by episode ID; never re-add blindly'});
    continue;
  }

  report.resolve.push({...base, reason:item.batchAction});
}

report.summary = {
  ready: report.ready.length,
  resolve: report.resolve.length,
  verifyOnly: report.verifyOnly.length,
  blocked: report.blocked.length,
  total: (plan.items||[]).length
};
await fs.writeFile('reports/batch-preflight.json',JSON.stringify(report,null,2));
const lines=[`Mode: ${report.mode}`,`Total: ${report.summary.total}`,`READY exact: ${report.summary.ready}`,`À résoudre avant apply-all: ${report.summary.resolve}`,`Contrôles sans écriture: ${report.summary.verifyOnly}`,`Bloqués: ${report.summary.blocked}`,''];
for(const x of report.ready) lines.push(`READY | ${x.youtubeur} | ${x.code} | ${x.title||''}`);
for(const x of report.resolve) lines.push(`RESOLVE | ${x.youtubeur} | ${x.code} | ${x.title||''} | ${x.reason}`);
for(const x of report.verifyOnly) lines.push(`VERIFY | ${x.youtubeur} | ${x.code} | ${x.title||''}`);
for(const x of report.blocked) lines.push(`BLOCKED | ${x.youtubeur} | ${x.code} | ${x.reason}`);
await fs.writeFile('reports/batch-preflight.txt',lines.join('\n'));
console.log(lines.join('\n'));
if (report.blocked.length) process.exitCode=2;
