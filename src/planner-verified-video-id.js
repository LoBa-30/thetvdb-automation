// Read-only: suppress a stale missing-video ticket only when the current audit
// and a previously documented official-video date agree on an existing episode.
const normalize = value => String(value ?? '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const EXPECTED = new Map([
  ['zrq-izHjEqI', ['S2020E27','2020-09-05']],
  ['aLN3UukAkxU', ['S2022E13','2022-03-02']]
]);
export function findVerifiedExistingEpisode(target, video, checkpoint) {
  if (!target || target.name !== 'Mastu' || !video?.id ||
      checkpoint?.mode !== 'VERIFIED_OFFICIAL_YOUTUBE_DATES_READ_ONLY' ||
      checkpoint?.sourceAuditRun !== 38731878113 ||
      checkpoint?.resolutions?.length !== 2) return null;
  const expected=EXPECTED.get(video.id);
  if (!expected) return null;
  const rows=checkpoint.resolutions.filter(x=>x.creator==='Mastu' && x.youtubeId===video.id);
  if (rows.length!==1) return null;
  const r=rows[0];
  if (r.tvdbCode!==expected[0] || r.officialPublishDate!==expected[1] ||
      r.evidence?.sourceType!=='OFFICIAL_YOUTUBE_VIDEO_PUBLISHED_DATE' ||
      r.evidence?.officialYoutubeUrl!=='https://www.youtube.com/watch?v='+video.id ||
      !r.evidence?.tvdbCatalogueUrl?.startsWith('https://thetvdb.com/series/346011-show/')) return null;
  const matchingAuditYoutube=(target.youtubeVideos||[]).filter(x=>x.id===video.id);
  const candidates=(target.tvdbEpisodes||[]).filter(x=>x.code===r.tvdbCode);
  if (matchingAuditYoutube.length!==1 || candidates.length!==1 ||
      (target.tvdbDuplicateCodes||[]).some(x=>x.code===r.tvdbCode)) return null;
  const row=candidates[0];
  if (row.firstAiredIso!==r.officialPublishDate ||
      normalize(video.title)!==normalize(r.verifiedTitle) ||
      normalize(matchingAuditYoutube[0].title)!==normalize(r.verifiedTitle) ||
      normalize(row.title)!==normalize(r.verifiedTitle)) return null;
  if (r.tvdbEpisodeId!==null && !/^\d+$/.test(String(r.tvdbEpisodeId))) return null;
  return {
    decision:'RESOLVED_EXISTING_DISTINCT_EPISODE_NO_WRITE',
    tvdb:r.tvdbCode, tvdbEpisodeId:r.tvdbEpisodeId ?? null,
    youtubeId:r.youtubeId, officialPublishDate:r.officialPublishDate,
    reason:'Unique existing episode has verified source date/title, despite repeated titles across years.',
    evidence:r.evidence, sourceCheckpointVersion:checkpoint.version
  };
}
