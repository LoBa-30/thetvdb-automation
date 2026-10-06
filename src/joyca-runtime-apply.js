import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_JOYCA_RUNTIME_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='335805-show';
const AUDIT='reports/joyca-final/audit.json';
const OUT='reports/joyca-runtime-apply';
const audit=JSON.parse(await fs.readFile(AUDIT,'utf8'));
const canon=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();

const plan=(audit.rows||[])
 .filter(x=>x.reference_scope==='IN_SCOPE' && x.runtime_exact===false &&
            x.youtube_duration_seconds!=null && x.tvdb_runtime_minutes!=null &&
            x.title_status!=='SUBSTANTIVE_MISMATCH')
 .map(x=>({
   id:String(x.episode_id),season:Number(x.season),episode:Number(x.episode),
   title:x.tvdb_title,date:x.tvdb_date,from:Number(x.tvdb_runtime_minutes),
   to:Number(x.expected_runtime_minutes),youtubeId:x.youtube_id,
   youtubeTitle:x.youtube_title,duration:x.youtube_duration,titleStatus:x.title_status
 }))
 .sort((a,b)=>a.season-b.season||a.episode-b.episode);

await fs.mkdir(OUT,{recursive:true});
const report={
 generatedAt:new Date().toISOString(),
 target:'Joyca in-scope runtimes',
 referenceDate:'2026-09-09',
 sourceAuditGeneratedAt:audit.summary?.generated_at||null,
 policy:'TheTVDB runtime integer rounded to closest minute',
 mode:'GUARDED_RUNTIME_APPLY',
 authenticated:false,planned:plan.length,preflightPassed:0,writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'
};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(url){
 let last=null;
 for(let i=1;i<=4;i++){
  last=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(last&&last.status()<400){await page.waitForTimeout(220);return;}
  await page.waitForTimeout(i*600);
 }
 throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
}
async function login(){
 await go(BASE+'/auth/login');
 const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await f.locator('input[name="email"]').fill(username);
 await f.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(650);
 const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
 return Boolean(p?.ok());
}
async function seasonMap(year){
 await go(`${BASE}/series/${SLUG}/seasons/official/${year}/edit`);
 const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]')||null;
   const href=a?.href||'';
   return {number:Number(input.value)||null,publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
 return new Map(rows.filter(x=>x.publicId).map(x=>[x.publicId,x]));
}
async function meta(id){
 await go(`${BASE}/series/${SLUG}/episodes/${id}/0/edit`);
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();
 if(!(await f.count())) throw new Error('Metadata form missing '+id);
 const action=await f.getAttribute('action');
 if(!action) throw new Error('Metadata action missing '+id);
 const path=new URL(action,BASE).pathname;
 if(!path.includes(`/series/${SLUG}/season/official/episodes/${id}/update`)) throw new Error('Unexpected form action '+id+' '+path);
 return {
   f,path,
   airdate:await f.locator('input[name="airdate"]').first().inputValue(),
   runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())
 };
}
async function guardedSubmit(form,path){
 let bad=null;
 const handler=async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){
     bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();
   }
   if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){
     bad='UNEXPECTED_POST '+u.pathname;return route.abort();
   }
   return route.continue();
 };
 await context.route('**/*',handler);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(450);
 await context.unroute('**/*',handler);
 if(bad) throw new Error(bad);
}

try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');

 const seasonMaps=new Map();
 for(const year of [...new Set(plan.map(x=>x.season))]) seasonMaps.set(year,await seasonMap(year));

 for(const x of plan){
   const row=seasonMaps.get(x.season)?.get(x.id)||null;
   if(!row||row.number!==x.episode||canon(row.title)!==canon(x.title)){
     report.blocked.push({id:x.id,code:`S${x.season}E${String(x.episode).padStart(2,'0')}`,reason:'CURRENT_MAPPING_DRIFT',expected:{episode:x.episode,title:x.title},actual:row});
     continue;
   }
   let m;
   try{m=await meta(x.id);}catch(e){report.blocked.push({id:x.id,reason:'META_READ_FAILED',detail:String(e?.message||e)});continue;}
   if(m.airdate!==x.date){
     report.blocked.push({id:x.id,reason:'AIRDATE_DRIFT',expected:x.date,actual:m.airdate});continue;
   }
   if(![x.from,x.to].includes(m.runtime)){
     report.blocked.push({id:x.id,reason:'RUNTIME_DRIFT',expectedOld:x.from,desired:x.to,actual:m.runtime});continue;
   }
   report.preflightPassed++;
   if(m.runtime===x.to){
     report.skips.push({id:x.id,season:x.season,episode:x.episode,reason:'ALREADY_CORRECT',runtime:m.runtime});
     report.verifications.push({id:x.id,season:x.season,episode:x.episode,runtime:m.runtime,airdate:m.airdate,ok:true,alreadyCorrect:true});
     continue;
   }
   await m.f.locator('input[name="runtime"]').fill(String(x.to));
   await guardedSubmit(m.f,m.path);
   report.writes.push({id:x.id,season:x.season,episode:x.episode,from:x.from,to:x.to,youtubeId:x.youtubeId,duration:x.duration});
   const v=await meta(x.id);
   const ok=v.runtime===x.to&&v.airdate===x.date;
   report.verifications.push({id:x.id,season:x.season,episode:x.episode,runtime:v.runtime,airdate:v.airdate,ok});
   if(!ok) throw new Error('POST_WRITE_VERIFY_FAILED '+x.id+' '+JSON.stringify(v));
 }
 report.result=report.blocked.length?'APPLIED_WITH_BLOCKED_DRIFT':'APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:String(e?.stack||e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,
 'planned='+report.planned,
 'preflightPassed='+report.preflightPassed,
 'writes='+report.writes.length,
 'skips='+report.skips.length,
 'blocked='+report.blocked.length,
 'verifications='+report.verifications.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','APPLIED_WITH_BLOCKED_DRIFT'].includes(report.result)) process.exitCode=2;
