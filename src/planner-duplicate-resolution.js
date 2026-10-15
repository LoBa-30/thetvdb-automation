// Offline planner helper. A title alone is never proof that two episodes are duplicates.
// Only suppress an already-reviewed group when creator, exact episode codes and
// substantially matching normalized titles all agree with a historical checkpoint.
import { normalizeTitle } from './matcher.js';

const CODE=/^S\d{4}E\d{1,4}(?=\b|\s|\W)/i;
function codeSet(episodes, checkpoint=false) {
  if (!Array.isArray(episodes) || episodes.length < 2) return null;
  const codes=episodes.map(item=>{
    const raw=checkpoint ? item : item?.code;
    const code=String(raw ?? '').trim().match(CODE)?.[0]?.toUpperCase();
    return code || null;
  });
  if (codes.some(x=>!x) || new Set(codes).size!==codes.length) return null;
  return codes.sort();
}
function numericTokens(title) {
  return [...new Set(normalizeTitle(title).split(' ').filter(token => /^\d+$/.test(token)))].sort();
}
function titleSimilarity(left,right) {
  // A changed part/sequel number is an identity change, even for a similar title.
  if (numericTokens(left).join('|') !== numericTokens(right).join('|')) return 0;
  const a=new Set(normalizeTitle(left).split(' ').filter(Boolean));
  const b=new Set(normalizeTitle(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection=0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection/new Set([...a,...b]).size;
}
export function findResolvedDuplicateTitle(target, group, resolvedTickets=[]) {
  const current=codeSet(group?.episodes);
  if (!target || !current || !group?.normalizedTitle) return null;
  const candidates=resolvedTickets.filter(ticket=>{
    if (ticket?.target!==target || ticket.ticket!=='TVDB_DUPLICATE_TITLE') return false;
    if (!String(ticket.decision||'').startsWith('RESOLVED_')) return false;
    const historical=codeSet(ticket.episodes,true);
    if (!historical || historical.join('|')!==current.join('|')) return false;
    return titleSimilarity(ticket.normalizedTitle,group.normalizedTitle)>=0.65;
  });
  // If historical checkpoints contradict each other, do not suppress the review.
  return candidates.length===1 ? candidates[0] : null;
}
