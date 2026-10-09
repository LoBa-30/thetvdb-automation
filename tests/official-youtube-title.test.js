import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOfficialTitlesForUnmatched } from '../src/official-youtube-title.js';
import { compareCatalogues } from '../src/matcher.js';

const cases = [
  ['sa2rwKmeUJw','On vous a caché ça... avec @BEENDO Z','On vous a caché ça... avec @BEENDOZ','S2023E02'],
  ['YCOZZz-mWYA','Seul contre 30.000 personnes à cause de @Lujipeka ! 🚍','Seul contre 30.000 personnes à cause de @lujipeka357 ! 🚍','S2022E15'],
  ['-K0btHmC6Sg','Ce jeu va créer des problèmes ! (ft. @THEODORT, @Snaptrox &@Zuukou Mayzie le Bg 667)','Ce jeu va créer des problèmes ! (ft. @theodortytb, @Snaptrox &@Zuukou667)','S2022E10'],
  ['S1ligBirCWo','Qui sera le pire élève ? 📚 (avec @Snaptrox, @THEODORT, @Ysos & @Vinceeh)','Qui sera le pire élève ? 📚 (avec @Snaptrox, @theodortytb, @Ysos & @Vinceeh)','S2022E04'],
  ['jICa9OCCv1g','Making-Of de "CE RAPPEUR QUI..." avec @THEODORT','Making-Of de "CE RAPPEUR QUI..." avec @theodortytb','S2021E13'],
  ['RFHVbWGh6xQ','Tournage en slip avec @Mastu & @THEODORT (Making-of)','Tournage en slip avec @Mastu & @theodortytb (Making-of)','S2021E09']
];

test('six Raska cases recover exact unique title identity via verified official oEmbed', async () => {
  const videos=cases.map(([id,title])=>({id,title}));
  const episodes=cases.map(([id,raw,official,code])=>({
    code,title:official.replace(/ 📚/g,'').replace(/ 🚍/g,''),firstAiredIso:null
  }));
  const initial=compareCatalogues(videos,episodes);
  assert.equal(initial.missingFromTvdb.length,6);
  const source = new Map(cases.map(([id,,title])=>[id,title]));
  const calls=[];
  const fetchImpl=async url=>{
    const id=new URL(new URL(url).searchParams.get('url')).searchParams.get('v');
    calls.push(id);
    return {ok:true,status:200,json:async()=>({title:source.get(id),author_name:'RASKA'})};
  };
  const fixed=await resolveOfficialTitlesForUnmatched(videos,initial.missingFromTvdb,'Raska',{fetchImpl});
  const after=compareCatalogues(fixed.videos,episodes);
  assert.equal(fixed.substituted,6);
  assert.equal(fixed.checks.length,6);
  assert.equal(after.summary.exactUnique,6);
  assert.equal(after.missingFromTvdb.length,0);
  assert.equal(new Set(calls).size,6);
  assert.equal(after.matches.every(x=>x.chronology==='UNVERIFIED_PRIMARY_DATE'),true);
  assert.equal(fixed.videos.every(x=>x.officialYoutubeTitleVerified && !x.primaryPublicationDateVerified),true);
  assert.deepEqual(fixed.videos.map(x=>x.originalListingTitle),videos.map(x=>x.title));
});

test('never substitute a title from a different channel, even if same video ID appears',async()=>{
  const video={id:'sa2rwKmeUJw',title:'One video'};
  const r=await resolveOfficialTitlesForUnmatched([video],[video],'Raska',{
    fetchImpl:async()=>({ok:true,status:200,json:async()=>({title:'Other title',author_name:'not Raska'})})
  });
  assert.equal(r.substituted,0);
  assert.equal(r.videos[0].title,'One video');
  assert.equal(r.checks[0].status,'AUTHOR_OR_TITLE_NOT_VERIFIED');
});

test('restriction stops probing without circumventing or modifying titles',async()=>{
  const videos=[{id:'sa2rwKmeUJw',title:'Old'},{id:'YCOZZz-mWYA',title:'Other'}];
  let attempts=0;
  const r=await resolveOfficialTitlesForUnmatched(videos,videos,'Raska',{fetchImpl:async()=>{
    attempts++;return {ok:false,status:403};
  }});
  assert.equal(attempts,1);
  assert.equal(r.substituted,0);
  assert.deepEqual(r.videos,videos);
  assert.equal(r.checks[0].status,'RESTRICTED_STOP_NO_BYPASS');
});
