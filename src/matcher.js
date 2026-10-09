// Read-only catalogue matching: identity must be confirmed separately before site edits.
export function normalizeTitle(value = '') {
  return String(value).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSimilarity(a, b) {
  // All tokens count, including standalone numeric sequel/part indicators.
  const aa = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const bb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;
  return 0.65 * common / Math.max(aa.size, bb.size)
    + 0.35 * common / Math.min(aa.size, bb.size);
}

function numericTokens(title) {
  return [...new Set(normalizeTitle(title).split(' ').filter(x => /^\d+$/.test(x)))].sort();
}

function numberConflict(a, b) {
  return numericTokens(a).join('|') !== numericTokens(b).join('|');
}

function parseIso(value) {
  if (typeof value !== 'string') return null;
  const iso = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!iso) return null;
  const ms = Date.parse(iso + 'T00:00:00Z');
  return Number.isFinite(ms) ? ms : null;
}

function chronology(video, episode) {
  const published = parseIso(video.publishedAtIso || video.publishedAt || video.uploadDate);
  const aired = parseIso(episode.firstAiredIso);
  if (published === null || aired === null) return 'UNVERIFIED_PRIMARY_DATE';
  const delta = Math.abs(published - aired) / 86400000;
  return delta <= 31 ? 'VERIFIED_COMPATIBLE' : 'DATE_CONFLICT';
}

export function compareCatalogues(videos, episodes, options = {}) {
  const threshold = options.fuzzyThreshold ?? 0.80;
  const videoByTitle = new Map();
  const episodeByTitle = new Map();
  for (let i = 0; i < videos.length; i++) {
    const key = normalizeTitle(videos[i].title);
    if (!key) continue;
    if (!videoByTitle.has(key)) videoByTitle.set(key, []);
    videoByTitle.get(key).push(i);
  }
  for (let i = 0; i < episodes.length; i++) {
    const key = normalizeTitle(episodes[i].title);
    if (!key) continue;
    if (!episodeByTitle.has(key)) episodeByTitle.set(key, []);
    episodeByTitle.get(key).push(i);
  }

  const matchedVideos = new Set();
  const matchedEpisodes = new Set();
  const matches = [];
  const fuzzyCandidates = [];

  // Reserve ALL unique exact matches before considering any fuzzy candidate.
  for (const [title, indices] of videoByTitle) {
    const destination = episodeByTitle.get(title) || [];
    if (indices.length !== 1 || destination.length !== 1) continue;
    const videoIndex = indices[0];
    const episodeIndex = destination[0];
    matchedVideos.add(videoIndex);
    matchedEpisodes.add(episodeIndex);
    matches.push({ youtube: videos[videoIndex], tvdb: episodes[episodeIndex], similarity: 1,
      matchMethod: 'EXACT_UNIQUE', chronology: chronology(videos[videoIndex], episodes[episodeIndex]) });
  }

  const missingFromTvdb = [];
  for (let v = 0; v < videos.length; v++) {
    if (matchedVideos.has(v)) continue;
    const video = videos[v];
    const key = normalizeTitle(video.title);
    const competingVideos = videoByTitle.get(key)?.length || 0;
    const competingEpisodes = episodeByTitle.get(key)?.length || 0;
    if (competingVideos > 1 || competingEpisodes > 1) {
      missingFromTvdb.push({ ...video, classification: 'AMBIGUOUS_EXACT_TITLE_REVIEW',
        bestSimilarity: 1, bestCandidate: null });
      continue;
    }
    const candidates = [];
    for (let e = 0; e < episodes.length; e++) {
      if (matchedEpisodes.has(e)) continue;
      const episode = episodes[e];
      if (numberConflict(video.title, episode.title)) continue;
      const score = tokenSimilarity(video.title, episode.title);
      if (score >= threshold) candidates.push({ index: e, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] || null;
    const ties = best && candidates[1] && best.score - candidates[1].score < 0.04;
    const status = best ? chronology(video, episodes[best.index]) : 'NO_CANDIDATE';
    const canMatch = best && !ties && status === 'VERIFIED_COMPATIBLE';
    if (canMatch) {
      matchedVideos.add(v);
      matchedEpisodes.add(best.index);
      matches.push({ youtube: video, tvdb: episodes[best.index], similarity: +best.score.toFixed(3),
        matchMethod: 'FUZZY_CHRONOLOGY_VERIFIED', chronology: status });
    } else {
      const candidate = best ? { code: episodes[best.index].code,
        title: episodes[best.index].title, firstAired: episodes[best.index].firstAired,
        score: +best.score.toFixed(3), chronology: status } : null;
      if (candidate) fuzzyCandidates.push({ youtube: video, candidate, ambiguous: !!ties });
      missingFromTvdb.push({ ...video, bestSimilarity: candidate?.score ?? 0,
        bestCandidate: candidate, classification: ties ? 'AMBIGUOUS_FUZZY_MATCH_REVIEW'
          : candidate ? 'FUZZY_REQUIRES_CHRONOLOGY_REVIEW'
          : 'LIKELY_MISSING_FROM_TVDB_OR_NON_EPISODE' });
    }
  }

  const missingFromYoutube = episodes
    .filter((_, i) => !matchedEpisodes.has(i))
    .map(episode => ({ ...episode, classification: 'TVDB_ENTRY_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH' }));
  return { matches, missingFromTvdb, missingFromYoutube, fuzzyCandidates,
    summary: { exactUnique: matches.filter(x => x.matchMethod === 'EXACT_UNIQUE').length,
      fuzzyVerified: matches.filter(x => x.matchMethod === 'FUZZY_CHRONOLOGY_VERIFIED').length,
      candidatesForReview: fuzzyCandidates.length } };
}
