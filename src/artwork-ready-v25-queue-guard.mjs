#!/usr/bin/env node
/**
 * V25 staging integrity check. This is intentionally READ-ONLY relative to TheTVDB.
 * NEVER treats user thumbnail selection or a source SHA as editorial approval.
 * Writes only an artifact in the GitHub runner's local reports/ directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
const ROOT=process.cwd();
const REL='reports/artwork-ready-v25-2026-10-10';
const read=(p)=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const q=read(REL+'/queue.json');
const manifest=read('reports/artwork-user-approvals-v23-2-2026-10-09.json');
const source=read('reports/artwork-user192-source-preflight-v23-2/report.json');
const flags=read('reports/artwork-user192-manual-visual-flags-v24-1-2026-10-10.json');
const alt=read('reports/artwork-user192-fullres-alternatives-review-v24-4-2026-10-10.json');
const mastu=read('reports/artwork-mastu-26-historical-id-reconciliation-v25-2026-10-10.json');
const more=read(REL+'/extra-visual-review.json');
const recapture=read(REL+'/needs-new-still-25.json');
const reviewHtml=fs.readFileSync(path.join(ROOT,REL,'review.html'),'utf8');
const errors=[],warn=[];
const assert=(ok,msg)=>{if(!ok)errors.push(msg)};
const numericId=(x)=>/^\d+$/.test(String(x));
const validSha=(x)=>/^[0-9a-f]{64}$/.test(String(x));
const validVideoId=(x)=>/^[A-Za-z0-9_-]{11}$/.test(String(x));
const validUrl=(yt,variant,url)=>url==='https://i.ytimg.com/vi/'+yt+'/'+variant+'.jpg';
assert(q.version==='V25.2','unexpected queue version');
assert(q.staging?.length===192,'192 originals required');
assert(q.permanentExclusions?.length===25,'25 permanent refusals required');
assert(recapture.total===25 && recapture.items?.length===25,'25 recapture episodes not isolated');
assert(reviewHtml.includes('doesNotAuthorizeAutomaticUpload:true'),'review HTML must not imply automatic upload');
try{const a=reviewHtml.indexOf('<script>'),b=reviewHtml.lastIndexOf('</script>'); if(a<0||b<=a)throw Error('NO_SCRIPT');new Script(reviewHtml.slice(a+8,b),{filename:'review.html'});}catch(e){assert(false,'review page JavaScript syntax invalid: '+e.message);}
assert(q.separateHold?.tvdbEpisodeId==='11960844','Raska S2018E05 hold missing');
assert(manifest.targets?.length===192,'baseline approval count mismatch');
assert(manifest.permanentlyExcluded?.length===25,'baseline exclusion count mismatch');
assert(source.rows?.length===192,'baseline source preflight incomplete');
assert(flags.flags?.length===35,'manual visual flags incomplete');
assert(alt.decisions?.length===12,'12 alternative fullres reviews missing');
assert(mastu.rows?.length===26,'Mastu historical crosswalk incomplete');
const sourceMap=new Map(source.rows.map(x=>[String(x.tvdbEpisodeId),x]));
const flaggedMap=new Map(flags.flags.map(x=>[String(x.tvdbEpisodeId),x]));
const approvedAlt=new Map(alt.decisions.filter(x=>x.editorialVisualScreening==='PROMISING_STILL_NOT_UPLOAD_READY').map(x=>[String(x.tvdbEpisodeId),x]));
const baselineMap=new Map(manifest.targets.map(x=>[String(x.tvdbEpisodeId),x]));
const extraById=new Map(more.rows.map(x=>[String(x.id),x]));
const allExclusions=new Set(q.permanentExclusions.map(x=>String(x.tvdbEpisodeId)));
const statuses={},creatorCounts={},blockedOrigins=[];
const seenIds=new Set(),seenImages=new Set(),seenVideos=new Set();
for(const r of q.staging){
 const id=String(r.tvdbEpisodeId),sourceRow=sourceMap.get(id),base=baselineMap.get(id),flag=flaggedMap.get(id),a=approvedAlt.get(id);
 assert(numericId(id)&&!seenIds.has(id),'episode id missing or duplicated '+id);seenIds.add(id);
 assert(!!base,'not user-approved episode '+id);
 if(!base)continue;
 assert(!allExclusions.has(id)&&id!==q.separateHold.tvdbEpisodeId,'explicitly blocked/refused episode entered queue '+id);
 assert(r.originalUserApproved===true && r.originalVariant===base.selectedImageVariant,'original decision/variant changed '+id);
 assert(r.originalUrl===base.selectedImageUrl,'immutable user-selected image URL changed '+id);
 assert(r.youtubeId===base.youtubeId && validVideoId(r.youtubeId),'video identity drift '+id);
 assert(r.episodeTitle===base.episodeTitle,'episode title drift '+id);
 assert(validUrl(r.youtubeId,r.originalVariant,r.originalUrl),'original URL not exact YouTube variant '+id);
 assert(!seenImages.has(r.originalUrl),'duplicate image in staging '+id);seenImages.add(r.originalUrl);
 assert(!seenVideos.has(r.youtubeId),'multiple episode mappings for video '+r.youtubeId);seenVideos.add(r.youtubeId);
 assert(!!sourceRow && sourceRow.fileSha256===r.originalImageSha256 && validSha(r.originalImageSha256),'original source hash mismatch '+id);
 assert(r.dimensions?.[0]===1280&&r.dimensions?.[1]===720,'source dimensions unexpected '+id);
 assert(r.uploadReady===false && r.automaticUploadDisabled===true,'an upload was accidentally enabled '+id);
 assert(Object.values(r.approvalChecklist||{}).every(x=>x===false),'approval falsely pre-certified '+id);
 assert(!!r.visualFlag===!!flag,'visual observation mismatch '+id);
 if(flag)assert(r.visualFlag.reason===flag.visualObservation,'visual reason mismatch '+id);
 assert(!r.suggestedAlternatives?.some(x=>x.readyForUpload||x.userApproved||x.finalEditorialApproved),'unchecked alternative authorized '+id);
 for(const x of r.suggestedAlternatives||[]){
   assert(['maxres1','maxres2','maxres3'].includes(x.variant) && x.variant!==r.originalVariant,'invalid alternative variant '+id);
   assert(validUrl(r.youtubeId,x.variant,x.url),'alternative URL not from exact same video '+id);
   if(x.fullResolutionVisualStatus?.startsWith('REJECTED'))blockedOrigins.push(id+' '+x.variant);
 }
 if(a){
   assert(r.suggestedAlternatives.some(x=>x.variant===a.proposedVariant && x.url===a.proposedImageUrl),'V24 validated provisional suggestion missing '+id);
   assert(r.stagingStatus==='ALTERNATIVE_NEEDS_EXPLICIT_USER_CHOICE_AND_FINAL_REVIEW','candidate staging status wrong '+id);
 }else if(flag){
   assert(r.stagingStatus==='ORIGINAL_FLAGGED_NEEDS_NEW_GENUINE_FRAME','blocked original mislabeled '+id);
 }else{
   assert(r.stagingStatus==='NO_OBVIOUS_OVERLAY_AWAITING_FINAL_EDITORIAL_INSPECTION','unflagged is not final approved '+id);
 }
 statuses[r.stagingStatus]=(statuses[r.stagingStatus]||0)+1;
 creatorCounts[r.creator]=(creatorCounts[r.creator]||0)+1;
 if(r.creator==='Mastu'&&r.mastuHistoricalEvidence){
   const m=mastu.rows.find(x=>String(x.tvdbEpisodeId)===id);
   assert(!!m&&r.mastuHistoricalEvidence.matchingHistoricalTVDBIdAndYouTube===m.youtubeIdMatch,'historical Mastu mapping drift '+id);
 }
}
assert(seenIds.size===192,'less than 192 unique targets');
const recaptureIds=new Set(recapture.items.map(x=>String(x.tvdbEpisodeId)));
assert(recaptureIds.size===25,'recapture backlog contains duplicate IDs');
for(const r of q.staging.filter(x=>x.stagingStatus==='ORIGINAL_FLAGGED_NEEDS_NEW_GENUINE_FRAME'))assert(recaptureIds.has(String(r.tvdbEpisodeId)),'recapture backlog missing '+r.tvdbEpisodeId);
assert(allExclusions.size===25,'not 25 unique permanent refusals');
assert(approvedAlt.size===10,'unexpected V24 promising count');
assert(statuses.NO_OBVIOUS_OVERLAY_AWAITING_FINAL_EDITORIAL_INSPECTION===157,'157 unflagged missing');
assert(statuses.ORIGINAL_FLAGGED_NEEDS_NEW_GENUINE_FRAME===25,'25 blocked originals missing');
assert(statuses.ALTERNATIVE_NEEDS_EXPLICIT_USER_CHOICE_AND_FINAL_REVIEW===10,'10 unapproved alternatives missing');
assert(creatorCounts.Djilsi===70&&creatorCounts.Raska===6&&creatorCounts['Maxime Biaggi']===19&&creatorCounts.Mastu===97,'creator counts drift');
assert(extraById.get('11960801')?.status==='REJECTED_VISIBLE_DIGITAL_TEXT_LOGO','failed Raska +10EUR candidate mistakenly approved');
assert(extraById.get('10970002')?.status?.startsWith('VISUALLY_PROMISING'),'Mastu extra proposal state drift');
assert(extraById.get('11696621')?.status?.startsWith('VISUALLY_PROMISING'),'Maxime extra proposal state drift');
assert(q.policy?.uploadEnabled===false && q.policy?.automaticBatchUploadsEnabled===false,'upload controls accidentally enabled');
assert(q.policy?.noOverwriting===true,'non-overwrite lock accidentally disabled');
assert(q.siteRestriction?.liftDemonstrated===false,'restriction not proven lifted');
assert(mastu.summary.historicalIdAndYoutubeMatches===25 && mastu.summary.unmatched===1,'Mastu crosswalk count drift');
const verdict={generatedAt:new Date().toISOString(),mode:'OFFLINE_STAGING_INTEGRITY_NO_AUTHENTICATION_NO_SITE_REQUESTS',
 valid:errors.length===0,errors,warnings:warn,originalApproved:seenIds.size,
 excluded:allExclusions.size,held:1,creatorCounts,statuses,
 originalFileSha256AllPinned:source.rows.length===192,
 provisionalAlternatives:approvedAlt.size,
 reviewedExtraCandidates:more.rows.length,
 rejectedExtraCandidatePreserved:blockedOrigins.includes('11960801 maxres2'),
 mastuHistoricNowMatched:25,mastuHistoricallyUnlinked:1,
 eligibleToUploadNow:0,siteUploads:0,siteDeletions:0,siteRequests:0,
 restrictionLiftNotVerified:true};
fs.mkdirSync(path.join(ROOT,REL,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(ROOT,REL,'artifacts','integrity-audit.json'),JSON.stringify(verdict,null,2)+'\n');
console.log('V25_QUEUE_INTEGRITY='+JSON.stringify(verdict));
if(!verdict.valid)process.exitCode=2;
