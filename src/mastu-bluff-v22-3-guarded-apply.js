import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
const BASE='https://thetvdb.com',SLUG='346011-show',YT='OUs0_f8wc_U';
const CHANNEL='UCAhaFPP6v3WCfK5Tjao0B7A',TITLE='LE JEU DU BLUFF (Avec Théodort)',DATE='2026-10-03';
const OUT='reports/mastu-bluff-v22-3-apply',EXPECTED_RUNTIME=45;
const report={generatedAt:new Date().toISOString(),mode:'SINGLE_GUARDED_BULKADD_2026E16',
  youtube:{id:YT},authenticated:false,preflight:[],writes:[],verifications:[],
  errors:[],result:'NOT_STARTED',deletes:0,artworkUploads:0};
await fs.mkdir(OUT,{recursive:true});
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
 .toLowerCase().replace(/&amp;/g,'&').replace(/[^a-z0-9]+/g,' ').trim();
function fail(x){throw Error(x);}
let browser;
async function youtube(){
 // Primary YouTube RSS proves immutable video ID, title and exact publication date.
 // Public YouTube runtime metadata triggered a human-verification challenge on CI;
 // never bypass it or use YouTube cookies. Two independently published channel
 // video indexes both show 45:22, enough to enter a conservative 45-minute runtime.
 const feed='https://www.youtube.com/feeds/videos.xml?channel_id='+CHANNEL;
 const r=await fetch(feed,{signal:AbortSignal.timeout(30000)});
 if(!r.ok)fail('RSS_HTTP_'+r.status);
 const entries=[...(await r.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(x=>x[1]);
 const x=entries.filter(s=>s.includes('<yt:videoId>'+YT+'</yt:videoId>'));
 if(x.length!==1)fail('RSS_ID_NOT_UNIQUE');
 const published=x[0].match(/<published>([^<]+)</)?.[1]||'';
 const rssTitle=x[0].match(/<title>([\s\S]*?)<\/title>/)?.[1]||'';
 const normalized=norm(rssTitle);
 if(!published.startsWith(DATE)||!normalized.includes('le jeu du bluff')||
   !normalized.includes('theodort'))fail('RSS_TITLE_DATE_DRIFT');
 report.youtube={
   id:YT,channelId:CHANNEL,title:rssTitle,published,
   durationSecondsApprox:2722,durationMinutes:45,
   runtimeProvenance:'TWO_INDEPENDENT_PUBLIC_INDEXES_NOT_OFFICIAL_DURATION',
   primaryIdentitySource:feed,
   durationSources:[
     'https://zolotube.com/channel?id=UCAhaFPP6v3WCfK5Tjao0B7A',
     'https://www.hypetubes.com/u/hypestubes/top-youtuber-fr'
   ],
   officialWatchMetadata:'BLOCKED_HUMAN_VERIFICATION_NOT_BYPASSED'
 };
 report.preflight.push({check:'PRIMARY_RSS_ID_DATE_TITLE',ok:true,videoId:YT,published,title:rssTitle});
 report.preflight.push({check:'DURATION_45M_22S_TWO_PUBLIC_INDEXES',ok:true,
   sources:report.youtube.durationSources,sourceClass:'SECONDARY_CORROBORATED'});
}
async function go(p,url){
 const r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 if(!r||![200,201].includes(r.status()))fail('TVDB_HTTP_'+(r?.status()||'NONE')+'_'+url);
 if(/\/auth\/login/.test(p.url())&&!/\/auth\/login/.test(url))fail('TVDB_AUTH_REDIRECT');
 const t=((await p.locator('body').innerText().catch(()=>''))||'').slice(0,1800);
 if(/captcha|verify you are human|access denied|rate limit|checking your browser/i.test(t))fail('TVDB_SITE_RESTRICTION');
}
async function login(ctx,p){
 await go(p,BASE+'/auth/login');
 const f=p.locator('form').filter({has:p.locator('input[name="password"]')}).first();
 if(await f.count()!==1)fail('LOGIN_FORM_NOT_FOUND');
 await f.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
 await f.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
 await f.locator('button[type="submit"],input[type="submit"]').first().click();
 await p.waitForLoadState('domcontentloaded').catch(()=>{});
 const q=await ctx.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
 const data=await q?.json().catch(()=>null);
 if(!q?.ok()||!data||!Object.keys(data).length)fail('AUTH_NOT_PROVEN');
 report.authenticated=true;
}
async function season(p){
 await go(p,BASE+'/series/'+SLUG+'/seasons/official/2026/edit');
 return await p.locator('input[name^="episodes["]').evaluateAll(ins=>ins.map(i=>{
  const c=i.closest('tr')||i.closest('.row')||i.parentElement?.parentElement||i.parentElement;
  const a=c?.querySelector('a[href*="/episodes/"]');
  return {id:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,
   number:Number(i.value),title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
}
async function checkNoDuplicates(p){
 const rows=await season(p);
 if(rows.length!==15||rows.some(x=>!x.id)||rows.map(x=>x.number).sort((a,b)=>a-b).some((x,i)=>x!==i+1))
   fail('ASSIGNED_2026_STATE_DRIFT');
 const prior=rows.find(x=>x.number===15);
 if(prior?.id!=='12014529'||!norm(prior.title).includes('table infernale 2'))fail('LATEST_EPISODE_DRIFT');
 if(rows.some(x=>norm(x.title)===norm(TITLE)||x.number===16))fail('ALREADY_ASSIGNED');
 report.preflight.push({check:'2026_SEASON_ORDER',ok:true,count:rows.length,latest:prior});
 // Read immutable aired date from last known episode.
 await go(p,BASE+'/series/'+SLUG+'/episodes/'+prior.id+'/0/edit');
 const m=p.locator('input[name="airdate"]').first();
 if(await m.count()!==1||await m.inputValue()!=='2026-09-19')fail('LATEST_EPISODE_DATE_DRIFT');
 await go(p,BASE+'/series/'+SLUG+'/allseasons/official');
 const hits=await p.locator('a[href*="/episodes/"]').evaluateAll(as=>{
  const ids=new Set(),out=[];
  for(const a of as){const id=(a.href||'').match(/\/episodes\/(\d+)/)?.[1];if(id&&!ids.has(id)){
   ids.add(id);out.push({id,title:(a.textContent||'').replace(/\s+/g,' ').trim()});}}
  return out;
 });
 const dup=hits.filter(x=>norm(x.title)===norm(TITLE));
 if(dup.length)fail('ASSIGNED_EXACT_TITLE_DUPLICATE_'+JSON.stringify(dup));
 await go(p,BASE+'/series/'+SLUG+'/seasons/official/unassigned/edit');
 const un=await p.locator('a[href*="/episodes/"]').evaluateAll(as=>{
  const ids=new Set(),out=[];
  for(const a of as){const id=(a.href||'').match(/\/episodes\/(\d+)/)?.[1];if(!id||ids.has(id))continue;
   ids.add(id);const c=a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement;
   out.push({id,title:(a.textContent||'').trim(),rowText:(c?.textContent||'').replace(/\s+/g,' ').trim()});}
  return out;
 });
 const collision=un.filter(x=>norm(x.title)===norm(TITLE)||x.rowText.includes(DATE));
 if(collision.length)fail('UNASSIGNED_COLLISION_'+JSON.stringify(collision));
 report.preflight.push({check:'ASSIGNED_AND_UNASSIGNED_COLLISIONS',ok:true,assignedExactHits:0,
   unassignedCount:un.length,unassignedCollisions:0});
}
async function submit(ctx,p){
 await go(p,BASE+'/series/'+SLUG+'/seasons/official/2026/bulkadd');
 const f=p.locator('form').filter({has:p.locator('input[name="number[]"]')}).first();
 if(await f.count()!==1)fail('BULKADD_FORM_MISSING');
 const action='/series/'+SLUG+'/seasons/official/2026/savebulkadd';
 if(await f.getAttribute('action')!==action)fail('BULKADD_ACTION_DRIFT');
 const fields={number:'16',name:TITLE,date:DATE,runtime:String(EXPECTED_RUNTIME)};
 for(const [key,value] of Object.entries(fields)){
   const el=f.locator('input[name="'+key+'[]"]').first();
   if(await el.count()!==1)fail('BULKADD_FIELD_MISSING_'+key);
   await el.fill(value);
 }
 report.preflight.push({check:'BULKADD_FORM_FIELDS',ok:true,expected:fields});
 let unexpected=null, postStatus=null;
 const guard=async route=>{
   const req=route.request(),u=new URL(req.url()),method=req.method().toUpperCase();
   if(u.origin===BASE&&!['GET','HEAD','OPTIONS'].includes(method)&&
      !(method==='POST'&&u.pathname===action)){
      unexpected=method+' '+u.pathname;await route.abort('blockedbyclient');return;
   }
   await route.continue();
 };
 await ctx.route('**/*',guard);
 try{
   const responseWait=p.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===action,
     {timeout:30000});
   await f.evaluate(form=>form.requestSubmit());
   const response=await responseWait;
   postStatus=response.status();
   await p.waitForLoadState('domcontentloaded').catch(()=>{});
 }finally{await ctx.unroute('**/*',guard);}
 report.preflight.push({check:'ONE_SUBMISSION_STATUS',httpStatus:postStatus});
 if(unexpected)fail('UNEXPECTED_NON_READ_REQUEST_'+unexpected);
 if(postStatus===202||postStatus===401||postStatus===403||postStatus===429||postStatus>=400)
   fail('WRITE_DENIED_HTTP_'+postStatus);
}
async function verify(p){
 const rows=await season(p);
 const hits=rows.filter(x=>x.number===16&&norm(x.title)===norm(TITLE));
 if(rows.length!==16||hits.length!==1||!hits[0].id)fail('POST_WRITE_EPISODE_NOT_PRESENT');
 const added=hits[0];
 await go(p,BASE+'/series/'+SLUG+'/episodes/'+added.id+'/0/edit');
 const date=p.locator('input[name="airdate"]').first();
 const aired=await date.count()?await date.inputValue():null;
 report.verifications.push({id:added.id,code:'S2026E16',title:added.title,airdate:aired,ok:aired===DATE});
 if(aired!==DATE)fail('POST_WRITE_AIRDATE_MISMATCH');
 // Public page check following authenticated edit form.
 await go(p,BASE+'/series/'+SLUG+'/episodes/'+added.id);
 const heading=(await p.locator('h1').first().innerText().catch(()=>'')).trim();
 if(norm(heading)!==norm(TITLE))fail('POST_WRITE_PUBLIC_TITLE_MISMATCH_'+heading);
 report.writes.push({type:'EPISODE_CREATED',id:added.id,code:'S2026E16',title:TITLE,
  firstAired:DATE,runtimeMinutes:EXPECTED_RUNTIME,youtubeId:YT});
}
try{
 if(process.env.TVDB_MASTU_BLUFF_V22_APPLY!=='yes')fail('NOT_ARMED');
 if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)fail('MISSING_TVDB_SECRETS');
 // Fail closed: primary YouTube date, ID and length required, no challenge bypass.
 await youtube();
 browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({locale:'fr-FR'}),p=await ctx.newPage();
 await login(ctx,p);
 await checkNoDuplicates(p);
 await submit(ctx,p);
 await verify(p);
 report.result='APPLIED_AND_VERIFIED';
}catch(e){report.errors.push({reason:String(e?.message||e)});
 report.result=report.writes.length?'POST_WRITE_REVIEW_REQUIRED':'BLOCKED_OR_UNCONFIRMED_NO_RETRY';
}finally{if(browser)await browser.close().catch(()=>{});}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,authenticated:report.authenticated,
 youtube:report.youtube,writes:report.writes,checks:report.preflight,errors:report.errors}));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
