import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileExactIdentity } from '../src/structural-mastu-verified-identity-v26.js';

const make=()=>{
 const r1={creator:'Mastu',youtubeId:'zrq-izHjEqI',tvdbCode:'S2020E27',tvdbEpisodeId:'7918773',
   officialPublishDate:'2020-09-05',verifiedTitle:'JE PEUX TOUT VOUS EXPLIQUER...',
   evidence:{sourceType:'OFFICIAL_YOUTUBE_VIDEO_PUBLISHED_DATE',officialYoutubeUrl:'https://www.youtube.com/watch?v=zrq-izHjEqI',
     tvdbCatalogueUrl:'https://thetvdb.com/series/346011-show/episodes/7918773'}};
 const r2={creator:'Mastu',youtubeId:'aLN3UukAkxU',tvdbCode:'S2022E13',tvdbEpisodeId:null,
   officialPublishDate:'2022-03-02',verifiedTitle:'Je peux tout vous expliquer...',
   evidence:{sourceType:'OFFICIAL_YOUTUBE_VIDEO_PUBLISHED_DATE',officialYoutubeUrl:'https://www.youtube.com/watch?v=aLN3UukAkxU',
     tvdbCatalogueUrl:'https://thetvdb.com/series/346011-show/allseasons/official'}};
 const audit={complete:true,targets:[{name:'Mastu',youtubeWithoutConfidentTvdbMatch:[r1,r2].map(r=>({id:r.youtubeId,title:r.verifiedTitle})),
   tvdbEpisodes:[r1,r2].map(r=>({code:r.tvdbCode,title:r.verifiedTitle,firstAiredIso:r.officialPublishDate})),
   tvdbDuplicateCodes:[]},...Array.from({length:8},(_,i)=>({name:'Creator '+i}))]};
 const plan={mode:'PLAN_ONLY_NO_TVDB_WRITES_RESOLUTION_AWARE',
  summary:{reviewRequired:2,resolvedByCheckpoint:0,autoEligible:0,informational:0},
  targets:[{name:'Mastu',reviewRequired:[r1,r2].map(r=>({type:'AMBIGUOUS_EXACT_TITLE_REVIEW',youtube:{id:r.youtubeId,title:r.verifiedTitle}})),
    resolvedByCheckpoint:[],autoEligible:[],informational:[]},
    ...Array.from({length:8},(_,i)=>({name:'Creator '+i,reviewRequired:[],resolvedByCheckpoint:[],autoEligible:[],informational:[]}))]};
 const checkpoint={version:'V26-MASTU-TWO-OFFICIAL-DATE-IDENTITIES',mode:'VERIFIED_OFFICIAL_YOUTUBE_DATES_READ_ONLY',
  sourceAuditRun:38731878113,resolutions:[r1,r2]};
 return {audit,plan,checkpoint};
};
test('resolves two distinct Mastu episodes and keeps source planner untouched',()=>{
 const {audit,plan,checkpoint}=make();
 const result=reconcileExactIdentity(audit,plan,checkpoint);
 assert.deepEqual(result.report.after,{reviewRequired:0,resolvedByCheckpoint:2,autoEligible:0,informational:0});
 assert.equal(plan.summary.reviewRequired,2);
 assert.equal(result.report.siteWrites,0);
 assert.equal(result.report.artworkActions,0);
 assert.equal(result.report.deletedEpisodes,0);
 assert.equal(result.report.verified[0].tvdbEpisodeId,'7918773');
 assert.equal(result.report.verified[1].tvdbEpisodeId,null);
});
const mutations=[
 ['unknown YouTube ID',o=>o.checkpoint.resolutions[0].youtubeId='AAAAAAAAAAA'],
 ['duplicate approval',o=>o.checkpoint.resolutions[1]={...o.checkpoint.resolutions[0]}],
 ['wrong primary date',o=>o.checkpoint.resolutions[0].officialPublishDate='2020-09-06'],
 ['changed TVDB first aired',o=>o.audit.targets[0].tvdbEpisodes[0].firstAiredIso='2020-09-06'],
 ['changed episode title',o=>o.audit.targets[0].tvdbEpisodes[0].title='WRONG VIDEO'],
 ['duplicate episode number',o=>o.audit.targets[0].tvdbDuplicateCodes=[{code:'S2020E27'}]],
 ['wrong creator',o=>o.checkpoint.resolutions[0].creator='Squeezie'],
 ['invalid evidence',o=>o.checkpoint.resolutions[0].evidence.sourceType='THIRD_PARTY_GUESS'],
 ['missing pending ticket',o=>o.plan.targets[0].reviewRequired.pop()],
 ['unverified audit',o=>o.audit.complete=false],
 ['unexpected source run',o=>o.checkpoint.sourceAuditRun=1],
 ['new video without reviewed checkpoint',o=>o.checkpoint.resolutions.push({...o.checkpoint.resolutions[0],youtubeId:'BBBBBBBBBBB'})]
];
for(const [name,mutate] of mutations)
 test('fails closed on '+name,()=>{const fixture=make();mutate(fixture);
   assert.throws(()=>reconcileExactIdentity(fixture.audit,fixture.plan,fixture.checkpoint));});
