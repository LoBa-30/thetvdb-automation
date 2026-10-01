import fs from 'node:fs/promises';

const audit = JSON.parse(await fs.readFile('reports/audit.json', 'utf8'));

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
  mode: 'PLAN_ONLY_NO_TVDB_WRITES',
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
    informational: 0
  }
};

for (const target of audit.targets || []) {
  const targetPlan = {
    name: target.name,
    autoEligible: [],
    reviewRequired: [],
    informational: []
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
  plan.targets.push(targetPlan);
}

await fs.writeFile('reports/correction-plan.json', JSON.stringify(plan, null, 2));

const lines = [
  `Mode: ${plan.mode}`,
  `Auto-éligibles (forte confiance ou validation utilisateur): ${plan.summary.autoEligible}`,
  `À vérifier: ${plan.summary.reviewRequired}`,
  `Informatifs / ne pas modifier automatiquement: ${plan.summary.informational}`,
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
  lines.push('');
}

await fs.writeFile('reports/correction-plan.txt', lines.join('\n'));
console.log(lines.join('\n'));
