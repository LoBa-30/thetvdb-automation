import fs from 'node:fs/promises';

const audit = JSON.parse(await fs.readFile('reports/audit.json', 'utf8'));

let resolutionCheckpoint = null;
try {
  resolutionCheckpoint = JSON.parse(await fs.readFile('reports/fresh-planner-ticket-resolution-2026-10-07.json', 'utf8'));
} catch {
  // The planner remains usable before the checkpoint exists.
}

const resolvedYoutubeIds = new Map();
const resolvedDuplicateTitles = new Map();
for (const item of resolutionCheckpoint?.resolvedTickets || []) {
  if (item.target && item.youtubeId) {
    resolvedYoutubeIds.set(`${item.target}\u0000${item.youtubeId}`, item);
  }
  if (item.target && item.normalizedTitle) {
    resolvedDuplicateTitles.set(
      `${item.target}\u0000${String(item.normalizedTitle).normalize('NFC').trim().toLowerCase()}`,
      item
    );
  }
}

function checkpointResolutionForYoutube(targetName, video) {
  return resolvedYoutubeIds.get(`${targetName}\u0000${video?.id || ''}`) || null;
}

function checkpointResolutionForDuplicateTitle(targetName, duplicateTitle) {
  const key = `${targetName}\u0000${String(duplicateTitle?.normalizedTitle || '').normalize('NFC').trim().toLowerCase()}`;
  return resolvedDuplicateTitles.get(key) || null;
}

const USER_APPROVED_ADDITIONS = [
  {
    target: 'Djilsi',
    titleIncludes: 'RDV LE SAMEDI 5 SEPTEMBRE À 11H',
    reason: 'Explicitement demandé par l’utilisateur : cette vidéo doit être ajoutée à TheTVDB même si elle ressemble à une annonce.'
  }
];

function getUserApproval(targetName, video) {
  return USER_APPROVED_ADDITIONS.find(rule =>
    rule.target === targetName &&
    String(video?.title || '').toLowerCase().includes(rule.titleIncludes.toLowerCase())
  );
}

const plan = {
  generatedAt: new Date().toISOString(),
  mode: 'PLAN_ONLY_NO_TVDB_WRITES_RESOLUTION_AWARE',
  rules: {
    autoEligible: [
      'TVDB_DUPLICATE_CODE',
      'USER_APPROVED_ADD_TO_TVDB'
    ],
    reviewRequired: [
      'LIKELY_MISSING_FROM_TVDB_OR_NON_EPISODE',
      'TVDB_ENTRY_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH',
      'TVDB_DUPLICATE_TITLE'
    ]
  },
  targets: [],
  summary: {
    autoEligible: 0,
    reviewRequired: 0,
    informational: 0,
    resolvedByCheckpoint: 0
  },
  resolutionCheckpoint: resolutionCheckpoint ? {
    generatedAt: resolutionCheckpoint.generatedAt || null,
    sourceRun: resolutionCheckpoint.sourceRun || null,
    resolvedTickets: resolutionCheckpoint.resolvedTickets?.length || 0,
    remainingTickets: resolutionCheckpoint.remainingTickets?.length || 0
  } : null
};

for (const target of audit.targets || []) {
  const targetPlan = {
    name: target.name,
    autoEligible: [],
    reviewRequired: [],
    informational: [],
    resolvedByCheckpoint: []
  };

  for (const duplicate of target.tvdbDuplicateCodes || []) {
    targetPlan.autoEligible.push({
      type: 'TVDB_DUPLICATE_CODE',
      confidence: 'HIGH',
      code: duplicate.code,
      episodes: duplicate.episodes,
      proposedAction: 'RENUMBER_OR_REVIEW_DUPLICATE_CODE',
      destructive: false,
      note: 'Collision de numéro détectée. Aucun changement n’est exécuté automatiquement à ce stade.'
    });
  }

  for (const video of target.youtubeWithoutConfidentTvdbMatch || []) {
    const resolved = checkpointResolutionForYoutube(target.name, video);
    if (resolved) {
      targetPlan.resolvedByCheckpoint.push({
        type: 'RESOLVED_CHECKPOINT_SUPPRESSED',
        sourceType: video.classification || 'YOUTUBE_WITHOUT_MATCH',
        youtube: video,
        resolution: {
          decision: resolved.decision || null,
          tvdb: resolved.tvdb || null,
          tvdbEpisodeId: resolved.tvdbEpisodeId || null,
          reason: resolved.reason || null,
          applyResult: resolved.applyResult || null
        },
        note: 'Suppressed from reviewRequired because a persisted, explicit resolution checkpoint already closed this exact YouTube ID. This protects against public TheTVDB cache lag and matcher false positives.'
      });
      continue;
    }

    const approval = getUserApproval(target.name, video);
    if (approval) {
      targetPlan.autoEligible.push({
        type: 'USER_APPROVED_ADD_TO_TVDB',
        confidence: 'USER_CONFIRMED',
        youtube: video,
        proposedAction: 'ADD_EPISODE_AFTER_NUMBERING_AND_DATE_RESOLUTION',
        destructive: false,
        requires: ['season', 'episodeNumber', 'firstAired'],
        note: approval.reason
      });
      continue;
    }

    targetPlan.reviewRequired.push({
      type: video.classification || 'YOUTUBE_WITHOUT_MATCH',
      confidence: 'MEDIUM',
      youtube: video,
      proposedAction: 'VERIFY_IF_EPISODE_AND_IF_MISSING_FROM_TVDB',
      destructive: false
    });
  }

  for (const episode of target.tvdbWithoutCurrentPublicYoutubeMatch || []) {
    targetPlan.informational.push({
      type: episode.classification || 'TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE',
      confidence: 'LOW_FOR_EDIT',
      tvdb: episode,
      proposedAction: 'KEEP_UNCHANGED_UNLESS_EXTERNAL_EVIDENCE_SHOWS_ERROR',
      destructive: false
    });
  }

  for (const duplicateTitle of target.tvdbDuplicateTitles || []) {
    const resolved = checkpointResolutionForDuplicateTitle(target.name, duplicateTitle);
    if (resolved) {
      targetPlan.resolvedByCheckpoint.push({
        type: 'RESOLVED_CHECKPOINT_SUPPRESSED',
        sourceType: 'TVDB_DUPLICATE_TITLE',
        normalizedTitle: duplicateTitle.normalizedTitle,
        episodes: duplicateTitle.episodes,
        resolution: {
          decision: resolved.decision || null,
          reason: resolved.reason || null
        },
        note: 'Suppressed from reviewRequired because this exact repeated-title group was already researched and explicitly resolved.'
      });
      continue;
    }

    targetPlan.reviewRequired.push({
      type: 'TVDB_DUPLICATE_TITLE',
      confidence: 'LOW_TO_MEDIUM',
      normalizedTitle: duplicateTitle.normalizedTitle,
      episodes: duplicateTitle.episodes,
      proposedAction: 'REVIEW_ONLY',
      destructive: false
    });
  }

  plan.summary.autoEligible += targetPlan.autoEligible.length;
  plan.summary.reviewRequired += targetPlan.reviewRequired.length;
  plan.summary.informational += targetPlan.informational.length;
  plan.summary.resolvedByCheckpoint += targetPlan.resolvedByCheckpoint.length;
  plan.targets.push(targetPlan);
}

await fs.writeFile('reports/correction-plan.json', JSON.stringify(plan, null, 2));

const lines = [
  `Mode: ${plan.mode}`,
  `Auto-éligibles (forte confiance ou validation utilisateur): ${plan.summary.autoEligible}`,
  `À vérifier: ${plan.summary.reviewRequired}`,
  `Informatifs / ne pas modifier automatiquement: ${plan.summary.informational}`,
  `Déjà résolus par checkpoint et supprimés du backlog: ${plan.summary.resolvedByCheckpoint}`,
  ''
];

for (const target of plan.targets) {
  lines.push(`## ${target.name}`);
  lines.push(`Auto-éligibles: ${target.autoEligible.length}`);
  for (const item of target.autoEligible) {
    if (item.youtube) {
      lines.push(`- ${item.type}: ${item.youtube.title} — ${item.youtube.url}`);
    } else {
      lines.push(`- ${item.type}: ${item.code} (${item.episodes.map(e => `${e.code} — ${e.title}`).join(' / ')})`);
    }
  }
  lines.push(`À vérifier: ${target.reviewRequired.length}`);
  for (const item of target.reviewRequired.slice(0, 20)) {
    if (item.youtube) lines.push(`- ${item.type}: ${item.youtube.title} — ${item.youtube.url}`);
    else lines.push(`- ${item.type}: ${item.normalizedTitle || ''}`);
  }
  lines.push(`Informatifs: ${target.informational.length}`);
  lines.push(`Déjà résolus par checkpoint: ${target.resolvedByCheckpoint.length}`);
  for (const item of target.resolvedByCheckpoint.slice(0, 20)) {
    if (item.youtube) lines.push(`- RESOLVED: ${item.youtube.title} — ${item.resolution?.decision || ''}`);
    else lines.push(`- RESOLVED: ${item.normalizedTitle || ''} — ${item.resolution?.decision || ''}`);
  }
  lines.push('');
}

await fs.writeFile('reports/correction-plan.txt', lines.join('\n'));
console.log(lines.join('\n'));
