import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
const BASE='https://thetvdb.com', SLUG='raska', OUT='reports/raska-titles-v22-5';
const PLAN=[
 {id:'11960797',code:'S2023E02',youtubeId:'sa2rwKmeUJw',from:'On vous a caché ça... avec @BEENDOZ',to:'On vous a caché ça... avec @BEENDO Z'},
 {id:'11960926',code:'S2022E15',youtubeId:'YCOZZz-mWYA',from:'Seul contre 30.000 personnes à cause de @lujipeka357 !',to:'Seul contre 30.000 personnes à cause de @Lujipeka ! 🚍'},
 {id:'11960921',code:'S2022E10',youtubeId:'-K0btHmC6Sg',from:'Ce jeu va créer des problèmes ! (ft. @theodortytb, @Snaptrox &@Zuukou667)',to:'Ce jeu va créer des problèmes ! (ft. @THEODORT, @Snaptrox &@Zuukou Mayzie le Bg 667)'},
 {id:'11960915',code:'S2022E04',youtubeId:'S1ligBirCWo',from:'Qui sera le pire élève ? (avec @Snaptrox, @theodortytb, @Ysos & @Vinceeh)',to:'Qui sera le pire élève ? 📚 (avec @Snaptrox, @THEODORT, @Ysos & @Vinceeh)'},
 {id:'11960901',code:'S2021E13',youtubeId:'jICa9OCCv1g',from:'Making-Of de "CE RAPPEUR QUI..." avec @theodortytb',to:'Making-Of de "CE RAPPEUR QUI..." avec @THEODORT'},
 {id:'11960897',code:'S2021E09',youtubeId:'RFHVbWGh6xQ',from:'Tournage en slip avec @Mastu & @theodortytb (Making-of)',to:'Tournage en slip avec @Mastu & @THEODORT (Making-of)'}
];
const rep={createdAt:new Date().toISOString(),mode:'AUTHENTICATED_READ_ONLY_RASKA_SIX_TITLE_PREFLIGHT',
 authenticated:false,results:[],errors:[],networkWritesToTheTVDB:0,safety:'NO_FORM_SUBMISSION'};
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
let browser,readOnly=false;
async function go(page,url) {
 const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 if(!r||r.status()>=400)throw Error('TVDB_HTTP_'+(r?.status()||'UNKNOWN')+'_'+url);
 if(/\/auth\/login/.test(page.url())&&!/\/auth\/login/.test(url))throw Error('AUTH_REDIRECT');
 const body=((await page.locator('body').innerText().catch(()=>''))||'').slice(0,1200);
 if(/captcha|verify you are human|access denied|rate limit|checking your browser/i.test(body))
   throw Error('SITE_CHALLENGE');
}
async function officialTitle(ep) {
 const url='https://www.youtube.com/oembed?url='+encodeURIComponent('https://www.youtube.com/watch?v='+ep.youtubeId)+'&format=json';
 try{
  const r=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(r.status===401||r.status===403||r.status===429) return {source:url,status:r.status,verified:false,reason:'OFFICIAL_YOUTUBE_RESTRICTION_NO_BYPASS'};
  if(!r.ok)return {source:url,status:r.status,verified:false,reason:'YOUTUBE_OEMBED_NOT_AVAILABLE'};
  const obj=await r.json(),title=norm(obj.title),author=norm(obj.author_name);
  return {source:url,status:r.status,title,author,verified:title===norm(ep.to)&&/raska|r4sk4/i.test(author)};
 }catch(e){return {source:url,verified:false,reason:String(e?.message||e)};}
}
async function tvdbRead(page,ep){
 await go(page,BASE+'/series/'+SLUG+'/seasons/official/'+ep.code.slice(1,5)+'/edit');
 const season=await page.locator('input[name^="episodes["]').evaluateAll(ins=>ins.map(i=>{
  const c=i.closest('tr')||i.closest('.row')||i.parentElement?.parentElement||i.parentElement;
  const a=c?.querySelector('a[href*="/episodes/"]');
  return {id:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,
   number:Number(i.value),title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
 const row=season.find(x=>x.id===ep.id);
 if(!row||row.number!==Number(ep.code.split('E')[1]))throw Error('SEASON_EPISODE_MAPPING_DRIFT_'+ep.code);
 await go(page,BASE+'/series/'+SLUG+'/episodes/'+ep.id);
 const heading=norm(await page.locator('h1').first().innerText().catch(()=>''));
 const link=await page.locator('a[href*="/episodes/'+ep.id+'/translate/"]').first().getAttribute('href').catch(()=>null);
 let translation=null;
 if(link){
  await go(page,new URL(link,BASE).href);
  let forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});
  for(let i=0;i<await forms.count();i++){
   const f=forms.nth(i);
   const loc=f.locator('input[name="episode_name"],textarea[name="episode_name"]').first();
   const value=norm(await loc.inputValue().catch(()=>''));
   const lang=await f.locator('[name="language"]').first().inputValue().catch(()=>'');
   const action=await f.getAttribute('action');
   if(['fra','fr','fr-FR'].includes(lang)||value===norm(ep.from)||value===norm(ep.to)){
    translation={language:lang,formTitle:value,action};break;
   }
  }
 }
 return {row,publicTitle:heading,translation};
}
try {
 const rows=await Promise.all(PLAN.map(async ep=>({ ...ep,primary:await officialTitle(ep)})));
 rep.results=rows.map(ep=>({id:ep.id,code:ep.code,youtubeId:ep.youtubeId,previousTitle:ep.from,expectedTitle:ep.to,primary:ep.primary}));
 if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)throw Error('MISSING_AUTH_SECRETS');
 browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({locale:'fr-FR'}),page=await ctx.newPage();
 await ctx.route('**/*',async route=>{
  const req=route.request(),host=new URL(req.url()).hostname;
  if(readOnly&&host.endsWith('thetvdb.com')&&!['GET','HEAD','OPTIONS'].includes(req.method().toUpperCase()))
    return route.abort('blockedbyclient');
  await route.continue();
 });
 await go(page,BASE+'/auth/login');
 const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 if(await form.count()!==1)throw Error('LOGIN_FORM_UNAVAILABLE');
 await form.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
 await form.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
 await form.locator('button[type="submit"],input[type="submit"]').first().click();
 await page.waitForLoadState('domcontentloaded').catch(()=>{});
 const auth=await ctx.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
 const p=await auth?.json().catch(()=>null);
 if(!auth?.ok()||!p||!Object.keys(p).length)throw Error('AUTH_NOT_PROVEN');
 rep.authenticated=true;readOnly=true;
 for(const row of rep.results){
  try {
   const live=await tvdbRead(page,row);
   row.tvdb=live;
   const correct=norm(live.publicTitle)===norm(row.expectedTitle);
   const old=norm(live.publicTitle)===norm(row.previousTitle);
   row.classification=correct?'ALREADY_CORRECT':
     row.primary.verified&&old&&live.translation?'EDIT_ELIGIBLE_AFTER_EXTRA_GUARDS':
     !row.primary.verified?'BLOCKED_PRIMARY_TITLE_NOT_VERIFIED':
     !live.translation?'BLOCKED_TRANSLATION_FORM_NOT_CONFIRMED':'BLOCKED_CURRENT_TVDB_TITLE_DRIFT';
  } catch(e){row.classification='BLOCKED_EPISODE_CHECK';row.problem=String(e?.message||e);}
 }
}catch(e){rep.errors.push(String(e?.message||e));}
finally{if(browser)await browser.close().catch(()=>{});}
rep.summary={checked:rep.results.length,primaryVerified:rep.results.filter(x=>x.primary.verified).length,
 editCandidates:rep.results.filter(x=>x.classification==='EDIT_ELIGIBLE_AFTER_EXTRA_GUARDS').length,
 alreadyCorrect:rep.results.filter(x=>x.classification==='ALREADY_CORRECT').length,
 blocked:rep.results.filter(x=>x.classification?.startsWith('BLOCKED')).length};
await fs.writeFile(OUT+'/report.json',JSON.stringify(rep,null,2)+'\n');
console.log(JSON.stringify({authenticated:rep.authenticated,summary:rep.summary,
 cases:rep.results.map(x=>({code:x.code,id:x.id,status:x.classification,oembed:x.primary.status,author:x.primary.author,reason:x.primary.reason,translation:x.tvdb?.translation?.formTitle})),errors:rep.errors}));
if(rep.errors.length)process.exitCode=2;
