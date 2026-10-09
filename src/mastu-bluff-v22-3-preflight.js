import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
const BASE='https://thetvdb.com',SLUG='346011-show',CHANNEL='UCAhaFPP6v3WCfK5Tjao0B7A',VIDEO='OUs0_f8wc_U',DATE='2026-10-03',OUT='reports/mastu-bluff-v22-3';
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),mode:'AUTH_READONLY_V22_3',youtubeId:VIDEO,
 rss:{verified:false},watch:{verified:false},authenticated:false,assigned:[],unassigned:[],
 assignedCollisions:[],unassignedCollisions:[],dateConflicts:[],bulkadd:null,
 errors:[],status:'NOT_READY',writes:0,deletes:0};
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&amp;/g,'&').replace(/[^a-z0-9]+/g,' ').trim();
let browser,readOnly=false;
async function rss(){
 const url='https://www.youtube.com/feeds/videos.xml?channel_id='+CHANNEL;
 const x=await fetch(url,{signal:AbortSignal.timeout(30000)});
 if(!x.ok)throw Error('RSS_HTTP_'+x.status);
 const entries=[...(await x.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(a=>a[1]);
 const m=entries.filter(a=>a.includes('<yt:videoId>'+VIDEO+'</yt:videoId>'));
 if(m.length!==1)throw Error('RSS_ID_MISSING_OR_AMBIGUOUS');
 const title=m[0].match(/<title>([\s\S]*?)<\/title>/)?.[1]||'',published=m[0].match(/<published>([^<]+)/)?.[1]||'';
 report.rss={url,videoId:VIDEO,title,published,verified:published.startsWith(DATE)&&norm(title).includes('jeu du bluff')&&norm(title).includes('theodort')};
 if(!report.rss.verified)throw Error('RSS_TITLE_OR_DATE_DRIFT');
}
async function watch(){
 const url='https://www.youtube.com/watch?v='+VIDEO;
 const r=await fetch(url,{signal:AbortSignal.timeout(30000)});
 if(!r.ok){report.watch={url,http:r.status};return;}
 const body=await r.text();
 const videoId=body.match(/"videoId":"([A-Za-z0-9_-]{11})"/)?.[1]||null;
 const seconds=Number(body.match(/"lengthSeconds":"(\d+)"/)?.[1]||0);
 const uploadDate=body.match(/"uploadDate":"(\d{4}-\d{2}-\d{2})"/)?.[1]||null;
 report.watch={url,videoId,seconds,uploadDate,verified:videoId===VIDEO&&uploadDate===DATE&&seconds>0};
}
async function go(page,url){
 const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 if(!r||![200,201].includes(r.status()))throw Error('TVDB_HTTP_'+(r?.status()||'none')+' '+url);
 if(/\/auth\/login/.test(page.url())&&!/\/auth\/login/.test(url))throw Error('LOGIN_REDIRECT');
 const t=(await page.locator('body').innerText().catch(()=>''))||'';
 if(/verify you are human|captcha|access denied|rate limit|checking your browser/i.test(t.slice(0,1800)))throw Error('TVDB_SITE_RESTRICTED');
}
try{
 await rss(); await watch();
 if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)throw Error('MISSING_SECRETS');
 browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({locale:'fr-FR'}),p=await ctx.newPage();
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(readOnly&&url.hostname.endsWith('thetvdb.com')&&!['GET','HEAD','OPTIONS'].includes(req.method().toUpperCase()))
    return route.abort('blockedbyclient');
  return route.continue();
 });
 await go(p,BASE+'/auth/login');
 const f=p.locator('form').filter({has:p.locator('input[name="password"]')}).first();
 if(await f.count()!==1)throw Error('LOGIN_FORM_MISSING');
 await f.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
 await f.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
 await f.locator('button[type="submit"],input[type="submit"]').first().click();
 await p.waitForLoadState('domcontentloaded').catch(()=>{});
 const u=await ctx.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
 const obj=await u?.json().catch(()=>null);
 if(!u?.ok()||!obj||!Object.keys(obj).length)throw Error('AUTH_NOT_PROVEN');
 report.authenticated=true;readOnly=true;
 await go(p,BASE+'/series/'+SLUG+'/seasons/official/2026/edit');
 report.assigned=await p.locator('input[name^="episodes["]').evaluateAll(ins=>ins.map(x=>{
  const c=x.closest('tr')||x.closest('.row')||x.parentElement?.parentElement||x.parentElement;
  const a=c?.querySelector('a[href*="/episodes/"]');
  return {id:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,
    number:Number(x.value),title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
 if(!report.assigned.length||report.assigned.some(x=>!x.id||!x.number))throw Error('INCOMPLETE_ASSIGNED_2026');
 await go(p,BASE+'/series/'+SLUG+'/allseasons/official');
 const all=await p.locator('a[href*="/episodes/"]').evaluateAll(as=>{
  const seen=new Set(),out=[];
  for(const a of as){const id=(a.href||'').match(/\/episodes\/(\d+)/)?.[1];if(id&&!seen.has(id)){
   seen.add(id);out.push({id,title:(a.textContent||'').replace(/\s+/g,' ').trim()});}}
  return out;
 });
 report.assignedCollisions=all.filter(x=>norm(x.title)===norm(report.rss.title)||
   norm(x.title).includes('jeu du bluff')&&norm(x.title).includes('theodort'));
 await go(p,BASE+'/series/'+SLUG+'/seasons/official/unassigned/edit');
 report.unassigned=await p.locator('a[href*="/episodes/"]').evaluateAll(as=>{
  const seen=new Set(),out=[];
  for(const a of as){const id=(a.href||'').match(/\/episodes\/(\d+)/)?.[1];if(!id||seen.has(id))continue;
   seen.add(id);const c=a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement;
   out.push({id,title:(a.textContent||'').trim(),rowText:(c?.textContent||'').replace(/\s+/g,' ').trim()});}
  return out;
 });
 report.unassignedCollisions=report.unassigned.filter(x=>norm(x.title)===norm(report.rss.title)||
   norm(x.title).includes('jeu du bluff')||x.rowText.includes(DATE));
 for(const row of report.assigned.filter(x=>x.number>=12)){
  try{await go(p,BASE+'/series/'+SLUG+'/episodes/'+row.id+'/0/edit');
    const m=p.locator('form input[name="airdate"]').first();
    row.airdate=await m.count()?await m.inputValue():null;
    if(row.airdate&&row.airdate>=DATE)report.dateConflicts.push(row);
  }catch(e){report.errors.push({episodeId:row.id,error:String(e?.message||e)});}
 }
 await go(p,BASE+'/series/'+SLUG+'/seasons/official/2026/bulkadd');
 const form=p.locator('form').filter({has:p.locator('input[name="number[]"]')}).first();
 const action=await form.count()?await form.getAttribute('action'):null;
 report.bulkadd={present:(await form.count())===1,action,expected:'/series/'+SLUG+'/seasons/official/2026/savebulkadd'};
 const nums=report.assigned.map(x=>x.number).sort((a,b)=>a-b);
 const contiguous=nums.length===15&&nums.every((x,i)=>x===i+1);
 report.status=report.rss.verified&&report.watch.verified&&report.authenticated&&contiguous&&
   !report.assignedCollisions.length&&!report.unassignedCollisions.length&&!report.dateConflicts.length&&
   !report.errors.length&&report.bulkadd.action===report.bulkadd.expected
   ?'CANDIDATE_FOR_SEPARATE_GUARDED_APPLY':'REQUIRES_REVIEW';
 report.guards={contiguous15:contiguous,assignedCollisionCount:report.assignedCollisions.length,
   unassignedCollisionCount:report.unassignedCollisions.length,afterDateEpisodes:report.dateConflicts.length};
}catch(e){report.errors.push({error:String(e?.message||e)});report.status='BLOCKED_OR_REVIEW_REQUIRED';}
finally{if(browser)await browser.close().catch(()=>{});}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,rss:report.rss.verified,watch:report.watch.verified,
  duration:report.watch.seconds,auth:report.authenticated,assigned:report.assigned.length,
  unassigned:report.unassigned.length,guards:report.guards,errors:report.errors}));
if(report.status==='BLOCKED_OR_REVIEW_REQUIRED')process.exitCode=2;
