import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure, offline reconciliation. Never invokes TheTVDB or modifies audit input.
const norm = x => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const dateOK = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x)) && !Number.isNaN(Date.parse(x));

export function reconcileExactIdentity(audit, originalPlan, checkpoint) {
  if (audit?.complete !== true || audit.targets?.length !== 9 || originalPlan?.targets?.length !== 9)
    throw Error('INCOMPLETE_NINE_CHANNEL_AUDIT');
  if (checkpoint?.mode !== 'VERIFIED_OFFICIAL_YOUTUBE_DATES_READ_ONLY' ||
      checkpoint?.sourceAuditRun !== 38731878113 || checkpoint.resolutions?.length !== 2)
    throw Error('INVALID_SOURCE_CHECKPOINT');
  if (originalPlan.mode !== 'PLAN_ONLY_NO_TVDB_WRITES_RESOLUTION_AWARE')
    throw Error('UNEXPECTED_ORIGINAL_PLANNER_MODE');
  const expectedIds = new Set(['zrq-izHjEqI','aLN3UukAkxU']);
  const plan = structuredClone(originalPlan);
  const matched = [], seen = new Set();
  for (const r of checkpoint.resolutions) {
    const id = r.youtubeId;
    if (r.creator !== 'Mastu' || !expectedIds.has(id) || seen.has(id) ||
        !/^S\d{4}E\d{2,4}$/.test(r.tvdbCode) || !dateOK(r.officialPublishDate) ||
        r.evidence?.sourceType !== 'OFFICIAL_YOUTUBE_VIDEO_PUBLISHED_DATE' ||
        r.evidence?.officialYoutubeUrl !== 'https://www.youtube.com/watch?v='+id ||
        !r.evidence?.tvdbCatalogueUrl?.startsWith('https://thetvdb.com/series/346011-show/'))
      throw Error('INVALID_EVIDENCE_OR_ID_'+id);
    seen.add(id);
    const target = audit.targets.find(x=>x.name===r.creator);
    const targetPlan = plan.targets.find(x=>x.name===r.creator);
    if (!target || !targetPlan) throw Error('CREATOR_NOT_FOUND');
    const yt = (target.youtubeWithoutConfidentTvdbMatch||[]).filter(x=>x.id===id);
    const tv = (target.tvdbEpisodes||[]).filter(x=>x.code===r.tvdbCode);
    const pending = targetPlan.reviewRequired.filter(x=>x.youtube?.id===id);
    if (yt.length!==1 || tv.length!==1 || pending.length!==1)
      throw Error('NON_UNIQUE_OR_MISSING_PAIR_'+id);
    if ((target.tvdbDuplicateCodes||[]).some(x=>x.code===r.tvdbCode) ||
        tv[0].firstAiredIso!==r.officialPublishDate ||
        norm(tv[0].title)!==norm(yt[0].title) ||
        norm(tv[0].title)!==norm(r.verifiedTitle))
      throw Error('TITLE_DATE_OR_NUMBER_DRIFT_'+id);
    if (r.tvdbEpisodeId && !/^\d+$/.test(String(r.tvdbEpisodeId)))
      throw Error('INVALID_NUMERIC_TVDB_EPISODE_ID_'+id);
    const pendingTicket=pending[0];
    targetPlan.reviewRequired=targetPlan.reviewRequired.filter(x=>x!==pendingTicket);
    targetPlan.resolvedByCheckpoint.push({
      type:'RESOLVED_EXACT_OFFICIAL_YOUTUBE_ID_DATE_TVDB_EXISTING_NO_WRITE',
      sourceType:pendingTicket.type,
      youtube:pendingTicket.youtube,
      resolution:{decision:'RESOLVED_EXISTING_DISTINCT_EPISODE_NO_WRITE',
        tvdb:r.tvdbCode,tvdbEpisodeId:r.tvdbEpisodeId||null,
        officialPublishDate:r.officialPublishDate,
        reason:'Exact distinct public-video/date/title pair already has its own TheTVDB episode',
        evidence:r.evidence},
      note:'No creation, renumbering, merging, deletion or artwork changes.'
    });
    matched.push({creator:r.creator,youtubeId:id,tvdbCode:r.tvdbCode,
      tvdbEpisodeId:r.tvdbEpisodeId||null,date:r.officialPublishDate,
      result:'MATCHED_EXISTING_EPISODE_NO_SITE_WRITE'});
  }
  if (matched.length!==2 || seen.size!==2) throw Error('INCOMPLETE_RESOLUTION');
  const count=key=>plan.targets.reduce((sum,t)=>sum+(t[key]?.length||0),0);
  for (const key of ['reviewRequired','resolvedByCheckpoint','autoEligible','informational'])
    plan.summary[key]=count(key);
  if (plan.summary.reviewRequired!==originalPlan.summary.reviewRequired-2 ||
      plan.summary.resolvedByCheckpoint!==originalPlan.summary.resolvedByCheckpoint+2 ||
      plan.summary.informational!==originalPlan.summary.informational ||
      plan.summary.autoEligible!==originalPlan.summary.autoEligible)
    throw Error('UNEXPECTED_PLANNER_COUNT_DRIFT');
  plan.mode='TARGETED_VERIFIED_IDENTITY_RECONCILIATION_READ_ONLY_NO_TVDB_WRITES';
  plan.targetedCheckpoint={version:checkpoint.version,sourceAuditRun:checkpoint.sourceAuditRun,
    resolvedNow:2,remainingReviewRequired:plan.summary.reviewRequired};
  return {plan,report:{generatedAt:new Date().toISOString(),mode:plan.mode,
    sourceAuditRun:checkpoint.sourceAuditRun,verified:matched,before:{...originalPlan.summary},
    after:{...plan.summary},siteWrites:0,artworkActions:0,deletedEpisodes:0,
    untouchedOpenCases:plan.targets.flatMap(t=>(t.reviewRequired||[]).map(x=>({
      creator:t.name,youtubeId:x.youtube?.id||null,type:x.type
    })))}};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const audit=JSON.parse(await fs.readFile('reports/audit.json','utf8'));
  const plan=JSON.parse(await fs.readFile('reports/correction-plan.json','utf8'));
  const checkpoint=JSON.parse(await fs.readFile('reports/structural-mastu-verified-identity-v26.json','utf8'));
  const result=reconcileExactIdentity(audit,plan,checkpoint);
  const out='reports/structural-mastu-verified-identity-v26';
  await fs.mkdir(out,{recursive:true});
  await fs.writeFile(out+'/report.json',JSON.stringify(result.report,null,2)+'\n');
  await fs.writeFile(out+'/correction-plan-after.json',JSON.stringify(result.plan,null,2)+'\n');
  console.log(JSON.stringify({status:'VERIFIED_READ_ONLY',verified:result.report.verified,
    before:result.report.before,after:result.report.after,siteWrites:0,artworkActions:0}));
}
