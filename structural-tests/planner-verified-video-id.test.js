import test from 'node:test';
import assert from 'node:assert/strict';
import { findVerifiedExistingEpisode } from '../src/planner-verified-video-id.js';
const fixture=()=>{
 const a={name:'Mastu',youtubeVideos:[{id:'zrq-izHjEqI',title:'JE PEUX TOUT VOUS EXPLIQUER...'}],
  tvdbEpisodes:[{code:'S2020E27',title:'JE PEUX TOUT VOUS EXPLIQUER...',firstAiredIso:'2020-09-05'}],
  tvdbDuplicateCodes:[]};
 const v={id:'zrq-izHjEqI',title:'JE PEUX TOUT VOUS EXPLIQUER...'};
 const c={mode:'VERIFIED_OFFICIAL_YOUTUBE_DATES_READ_ONLY',sourceAuditRun:38731878113,resolutions:[
  {creator:'Mastu',youtubeId:'zrq-izHjEqI',tvdbCode:'S2020E27',tvdbEpisodeId:'7918773',
   officialPublishDate:'2020-09-05',verifiedTitle:'JE PEUX TOUT VOUS EXPLIQUER...',
   evidence:{sourceType:'OFFICIAL_YOUTUBE_VIDEO_PUBLISHED_DATE',
    officialYoutubeUrl:'https://www.youtube.com/watch?v=zrq-izHjEqI',
    tvdbCatalogueUrl:'https://thetvdb.com/series/346011-show/episodes/7918773'}},
  {creator:'Mastu',youtubeId:'aLN3UukAkxU',tvdbCode:'S2022E13',tvdbEpisodeId:null,
   officialPublishDate:'2022-03-02',verifiedTitle:'Je peux tout vous expliquer...',
   evidence:{sourceType:'OFFICIAL_YOUTUBE_VIDEO_PUBLISHED_DATE',
    officialYoutubeUrl:'https://www.youtube.com/watch?v=aLN3UukAkxU',
    tvdbCatalogueUrl:'https://thetvdb.com/series/346011-show/allseasons/official'}}
 ]};return {a,v,c};
};
test('accepts only unique confirmed existing episode',()=>{
 const {a,v,c}=fixture();const r=findVerifiedExistingEpisode(a,v,c);
 assert.equal(r?.tvdb,'S2020E27');assert.equal(r?.tvdbEpisodeId,'7918773');
 assert.equal(r?.decision,'RESOLVED_EXISTING_DISTINCT_EPISODE_NO_WRITE');
});
for(const [name,modify] of [
 ['wrong video ID',o=>o.v.id='BBBBBBBBBBB'],
 ['wrong episode date',o=>o.a.tvdbEpisodes[0].firstAiredIso='2020-09-06'],
 ['wrong episode code',o=>o.a.tvdbEpisodes[0].code='S2020E28'],
 ['changed title',o=>o.a.tvdbEpisodes[0].title='WRONG'],
 ['duplicate episode number',o=>o.a.tvdbDuplicateCodes=[{code:'S2020E27'}]],
 ['wrong creator',o=>o.a.name='Squeezie'],
 ['source not official',o=>o.c.resolutions[0].evidence.sourceType='OTHER'],
 ['unknown source run',o=>o.c.sourceAuditRun=1],
 ['checkpoint date altered',o=>o.c.resolutions[0].officialPublishDate='2020-09-06'],
 ['duplicate TVDB catalogue row',o=>o.a.tvdbEpisodes.push({...o.a.tvdbEpisodes[0]})]
])test('fails closed: '+name,()=>{const o=fixture();modify(o);
 assert.equal(findVerifiedExistingEpisode(o.a,o.v,o.c),null);});
