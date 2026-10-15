// Strict read-only reconciliation: unique TheTVDB episode's own Official Website
// link must point to the exact official YouTube video. Never edits, creates or deletes.
const normalize=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const EXPECTED=new Map([
 ['O4ZEKE5p7so',['9772112','S2023E07','2023-05-06']],
 ['bUAtsbgZrYM',['10632229','S2024E11','2024-08-04']]
]);
export function findVerifiedOfficialWebsiteEpisode(target, video, checkpoint) {
 if(target?.name!=='Mastu' || !video?.id ||
    checkpoint?.mode!=='READ_ONLY_TVDB_EPISODE_OFFICIAL_WEBSITE_CROSSCHECK' ||
    checkpoint?.baselineAuditRun!==38731878113 || checkpoint.verified?.length!==2)return null;
 const expected=EXPECTED.get(video.id);
 if(!expected)return null;
 const links=checkpoint.verified.filter(x=>x.youtubeId===video.id && x.creator==='Mastu');
 if(links.length!==1)return null;
 const proof=links[0];
 if(proof.sourceStatus!=='DIRECT_EPISODE_OFFICIAL_WEBSITE_LINK_VERIFIED' ||
    proof.tvdbEpisodeId!==expected[0] || proof.tvdbCode!==expected[1] ||
    proof.tvdbDate!==expected[2] ||
    proof.officialWebsiteUrl!=='https://www.youtube.com/watch?v='+video.id ||
    proof.tvdbUrl!=='https://thetvdb.com/series/346011-show/episodes/'+proof.tvdbEpisodeId)
   return null;
 const youtube=(target.youtubeVideos||[]).filter(x=>x.id===video.id);
 const tvdb=(target.tvdbEpisodes||[]).filter(x=>x.code===proof.tvdbCode);
 if(youtube.length!==1 || tvdb.length!==1 ||
    (target.tvdbDuplicateCodes||[]).some(x=>x.code===proof.tvdbCode))return null;
 const episode=tvdb[0];
 if(episode.firstAiredIso!==proof.tvdbDate ||
    normalize(episode.title)!==normalize(proof.canonicalTitle) ||
    normalize(youtube[0].title)!==normalize(proof.canonicalTitle) ||
    normalize(video.title)!==normalize(proof.canonicalTitle))return null;
 return {
   decision:'RESOLVED_TVDB_OFFICIAL_WEBSITE_LINK_MATCH_NO_WRITE',
   tvdb:proof.tvdbCode,tvdbEpisodeId:proof.tvdbEpisodeId,
   youtubeId:proof.youtubeId,firstAired:proof.tvdbDate,
   evidence:{tvdbUrl:proof.tvdbUrl,officialWebsiteUrl:proof.officialWebsiteUrl,
     sourceStatus:proof.sourceStatus},
   reason:'Current audit title/date/code and distinct episode official external link establish exact video identity.'
 };
}
