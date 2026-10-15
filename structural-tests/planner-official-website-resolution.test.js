import test from 'node:test';
import assert from 'node:assert/strict';
import { findVerifiedOfficialWebsiteEpisode as lookup } from '../src/planner-official-website-resolution.js';
const fixture=()=>{
 const proof={creator:'Mastu',youtubeId:'bUAtsbgZrYM',tvdbEpisodeId:'10632229',tvdbCode:'S2024E11',
  tvdbDate:'2024-08-04',canonicalTitle:'ON ACCOSTE DES GENS EN VOITURE (Avec Théodort)',
  tvdbUrl:'https://thetvdb.com/series/346011-show/episodes/10632229',
  officialWebsiteUrl:'https://www.youtube.com/watch?v=bUAtsbgZrYM',
  sourceStatus:'DIRECT_EPISODE_OFFICIAL_WEBSITE_LINK_VERIFIED'};
 const t={name:'Mastu',youtubeVideos:[{id:proof.youtubeId,title:proof.canonicalTitle}],
  tvdbEpisodes:[{code:proof.tvdbCode,title:proof.canonicalTitle,firstAiredIso:proof.tvdbDate}],
  tvdbDuplicateCodes:[]};
 const v={id:proof.youtubeId,title:proof.canonicalTitle};
 const c={mode:'READ_ONLY_TVDB_EPISODE_OFFICIAL_WEBSITE_CROSSCHECK',baselineAuditRun:38731878113,
  verified:[proof,{creator:'Mastu',youtubeId:'O4ZEKE5p7so',tvdbEpisodeId:'9772112',tvdbCode:'S2023E07',
   tvdbDate:'2023-05-06',canonicalTitle:proof.canonicalTitle,
   tvdbUrl:'https://thetvdb.com/series/346011-show/episodes/9772112',
   officialWebsiteUrl:'https://www.youtube.com/watch?v=O4ZEKE5p7so',
   sourceStatus:'DIRECT_EPISODE_OFFICIAL_WEBSITE_LINK_VERIFIED'}]};
 return {t,v,c};
};
test('maps video to exact immutable numeric episode using its official site link',()=>{
 const {t,v,c}=fixture();const result=lookup(t,v,c);
 assert.equal(result.tvdb,'S2024E11');
 assert.equal(result.tvdbEpisodeId,'10632229');
 assert.equal(result.decision,'RESOLVED_TVDB_OFFICIAL_WEBSITE_LINK_MATCH_NO_WRITE');
});
for(const [name,fn] of [
 ['wrong YouTube ID',o=>o.v.id='BBBBBBBBBBB'],
 ['different TVDB episode ID',o=>o.c.verified[0].tvdbEpisodeId='42'],
 ['wrong official Website video link',o=>o.c.verified[0].officialWebsiteUrl='https://www.youtube.com/watch?v=AAAAAAAAAAA'],
 ['wrong current episode code',o=>o.t.tvdbEpisodes[0].code='S2024E12'],
 ['changed current airing date',o=>o.t.tvdbEpisodes[0].firstAiredIso='2024-08-05'],
 ['changed title',o=>o.t.tvdbEpisodes[0].title='UNRELATED VIDEO'],
 ['ambiguous duplicate numbering',o=>o.t.tvdbDuplicateCodes=[{code:'S2024E11'}]],
 ['wrong creator',o=>o.t.name='Squeezie'],
 ['unknown checkpoint source run',o=>o.c.baselineAuditRun=1],
 ['unsigned evidence',o=>o.c.verified[0].sourceStatus='THIRD_PARTY_GUESS'],
 ['duplicate episode candidate',o=>o.t.tvdbEpisodes.push({...o.t.tvdbEpisodes[0]})],
 ['unknown new entry',o=>o.c.verified.push({...o.c.verified[0]})]
])test('refuses unsafe match: '+name,()=>{const x=fixture();fn(x);assert.equal(lookup(x.t,x.v,x.c),null);});
