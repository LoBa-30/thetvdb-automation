import fs from 'node:fs/promises';

const mode = String(process.env.TVDB_EDIT_MODE || 'dry-run').toLowerCase();
const applyRequested = mode === 'apply';

const plan = JSON.parse(await fs.readFile('reports/correction-plan.json', 'utf8'));

const executable = [];
const blocked = [];

for (const target of plan.targets || []) {
  for (const item of target.autoEligible || []) {
    const action = { target: target.name, ...item };

    if (item.type === 'USER_APPROVED_ADD_TO_TVDB') {
      const missing = [];
      if (!item.resolved?.season) missing.push('season');
      if (!item.resolved?.episodeNumber) missing.push('episodeNumber');
      if (!item.resolved?.firstAired) missing.push('firstAired');

      if (missing.length) {
        blocked.push({
          ...action,
          status: 'BLOCKED_MISSING_METADATA',
          missing
        });
      } else {
        executable.push({ ...action, status: 'READY' });
      }
      continue;
    }

    if (item.type === 'TVDB_DUPLICATE_CODE') {
      blocked.push({
        ...action,
        status: 'BLOCKED_NEEDS_EXPLICIT_RENUMBER_TARGET',
        note: 'Un doublon de code ne peut jamais être renuméroté en devinant quel épisode doit changer.'
      });
      continue;
    }

    blocked.push({ ...action, status: 'BLOCKED_UNSUPPORTED_ACTION' });
  }
}

const execution = {
  generatedAt: new Date().toISOString(),
  requestedMode: mode,
  safety: {
    dryRunDefault: true,
    destructiveDeletesAllowed: false,
    unresolvedActionsCanWrite: false,
    credentialsLogged: false
  },
  executable,
  blocked,
  result: applyRequested ? 'NOT_STARTED' : 'DRY_RUN_COMPLETE'
};

if (applyRequested) {
  if (!process.env.TVDB_USERNAME || !process.env.TVDB_PASSWORD) {
    execution.result = 'BLOCKED_MISSING_GITHUB_SECRETS';
    execution.message = 'TVDB_USERNAME and TVDB_PASSWORD GitHub Actions secrets are required for apply mode.';
  } else if (blocked.length > 0) {
    execution.result = 'BLOCKED_UNRESOLVED_ACTIONS';
    execution.message = 'Apply mode is intentionally blocked while any auto-eligible action still lacks explicit metadata or a deterministic target.';
  } else if (executable.length === 0) {
    execution.result = 'NOTHING_TO_APPLY';
  } else {
    execution.result = 'BLOCKED_EDITOR_NOT_ARMED';
    execution.message = 'Authentication and form selectors must be validated in auth-preflight before write submission is armed.';
  }
}

await fs.writeFile('reports/edit-execution.json', JSON.stringify(execution, null, 2));

const lines = [
  `Mode demandé: ${mode}`,
  `Actions prêtes: ${executable.length}`,
  `Actions bloquées: ${blocked.length}`,
  `Résultat: ${execution.result}`,
  ''
];

for (const item of executable) {
  lines.push(`[READY] ${item.target} — ${item.type} — ${item.youtube?.title || item.code || ''}`);
}
for (const item of blocked) {
  lines.push(`[BLOCKED] ${item.target} — ${item.type} — ${item.youtube?.title || item.code || ''} — ${item.status}`);
}

await fs.writeFile('reports/edit-execution.txt', lines.join('\n'));
console.log(lines.join('\n'));

if (applyRequested && !['NOTHING_TO_APPLY'].includes(execution.result)) {
  process.exitCode = 2;
}
