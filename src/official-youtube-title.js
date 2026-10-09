import { normalizeTitle } from './matcher.js';

const AUTHORS = {
  'Djilsi': ['djilsi'],
  'Elian Ventre': ['elian ventre'],
  'Raska': ['raska', 'r4sk4'],
  'Maxime Biaggi': ['maxime biaggi'],
  'Squeezie': ['squeezie'],
  'Mastu': ['mastu'],
  'Amixem': ['amixem'],
  'Joyca': ['joyca'],
  'Mcfly & Carlito': ['mcfly carlito', 'mcfly et carlito', 'mcfly and carlito']
};

/**
 * Read-only source reconciliation. YouTube's Videos-tab anchor title may replace
 * creator mentions with on-page display names, yielding false TVDB mismatches.
 * Official YouTube oEmbed identifies the published video title by immutable video ID.
 *
 * NEVER treats an oEmbed title as proof of original upload date, runtime, or
 * eligibility for a TheTVDB edit. Never overwrites the raw listing title.
 */
export async function resolveOfficialTitlesForUnmatched(
  videos, unmatched, creator, { fetchImpl = fetch, maxChecks = 20, timeoutMs = 12000 } = {}
) {
  const aliases = AUTHORS[creator] || [];
  const ids = [...new Set((unmatched || []).map(x => x.id).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)))].slice(0, maxChecks);
  const substitutions = new Map();
  const checks = [];
  for (const id of ids) {
    const video = videos.find(x => x.id === id);
    if (!video) continue;
    const target = 'https://www.youtube.com/watch?v=' + id;
    const url = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(target) + '&format=json';
    const record = { youtubeId: id, listingTitle: video.title, source: url,
      titleOnly: true, provesPublicationDate: false, provesRuntime: false,
      substituted: false };
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      record.httpStatus = response.status;
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        record.status = 'RESTRICTED_STOP_NO_BYPASS';
        checks.push(record);
        break;
      }
      if (!response.ok) {
        record.status = 'NOT_AVAILABLE'; checks.push(record); continue;
      }
      const data = await response.json();
      const actualTitle = String(data.title || '').trim();
      const author = normalizeTitle(data.author_name || '');
      record.officialTitle = actualTitle;
      record.author = String(data.author_name || '');
      if (!actualTitle || !aliases.includes(author)) {
        record.status = 'AUTHOR_OR_TITLE_NOT_VERIFIED';
      } else if (normalizeTitle(actualTitle) === normalizeTitle(video.title)) {
        record.status = 'OFFICIAL_TITLE_EQUIVALENT';
      } else {
        record.status = 'OFFICIAL_TITLE_VERIFIED';
        record.substituted = true;
        substitutions.set(id, actualTitle);
      }
    } catch (e) {
      record.status = 'FETCH_UNAVAILABLE';
      record.error = String(e?.message || e);
    }
    checks.push(record);
  }
  return {
    videos: videos.map(video => substitutions.has(video.id)
      ? { ...video, title: substitutions.get(video.id),
          originalListingTitle: video.title, officialYoutubeTitleVerified: true,
          officialYoutubeTitleSource: 'OEMBED_BY_IMMUTABLE_ID',
          primaryPublicationDateVerified: false }
      : video),
    checks,
    substituted: substitutions.size
  };
}
