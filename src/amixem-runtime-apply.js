
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_AMIXEM_RUNTIME_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com', SLUG='328213-show';
const audit=JSON.parse(await fs.readFile('reports/amixem-final/audit.json','utf8'));
const OV={
  'Tu0tDXPx_4k':'6102787',
  'Zja5z7C0c7g':'6102789',
  'fu-nBHrmokA':'6102812',
  'tB1RJcIyQqc':'8107822',
  'zusoj9QmlHc':'8107823'
};
const canon=s=>String(s||'').normalize('NFC').replace(/\s+/g,' ').trim();
const recs=new Map();
for(const x of audit.rows) recs.set(String(x.episode_id),{id:String(x.episode_id),season:x.season,episode:x.episode,title:x.tvdb_title,date:x.tvdb_date,runtime:x.tvdb_runtime_minutes});
for(const x of audit.tvdb_historical_without_current_public_youtube) recs.set(String(x.episode_id),{id:String(x.episode_id),season:x.season,episode:x.episode,title:x.title,date:x.date,runtime:x.runtime_minutes});
const plan=new Map();
for(const x of audit.rows.filter(x=>x.reference_scope==='IN_SCOPE')){
  const id=OV[x.youtube_id]||String(x.episode_id);
  const rec=recs.get(id); if(!rec || x.youtube_duration_seconds==null) continue;
  const runtime=Math.floor(Number(x.youtube_duration_seconds)/60+0.5);
  if(rec.runtime!==runtime) plan.set(id,{...rec,desiredRuntime:runtime,youtubeId:x.youtube_id,youtubeDuration:x.youtube_duration});
}
const report={generatedAt:new Date().toISOString(),mode:'AMIXEM_RUNTIME_SAFE_APPLY',armed,authenticated:false,planned:plan.size,writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
if(!armed) throw new Error('Not armed');
if(!username||!password) throw new Error('Missing TVDB credentials');
await fs.mkdir('reports/amixem-runtime-apply',{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(url){
  let last=null;
  for(let i=1;i<=4;i++){
    last=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(last&&last.status()<400){await page.waitForTimeout(250);return;}
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
  await page.waitForTimeout(700);
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
  if(!action||!action.includes(`/series/${SLUG}/season/official/episodes/${id}/update`)) throw new Error('Unexpected form action '+id+' '+action);
  return {f,actionUrl:new URL(action,BASE).href,airdate:await f.locator('input[name="airdate"]').first().inputValue(),runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())};
}

try{
  report.authenticated=await login();
  if(!report.authenticated) throw new Error('Authenticated session not proven');
  const seasons=new Map();
  for(let y=2012;y<=2026;y++) seasons.set(y,await seasonMap(y));

  for(const [id,x] of plan){
    const row=seasons.get(x.season)?.get(id);
    if(!row || row.number!==x.episode || canon(row.title)!==canon(x.title)){
      report.blocked.push({id,reason:'CURRENT_MAPPING_DRIFT',expected:{season:x.season,episode:x.episode,title:x.title},actual:row||null});
      continue;
    }
    const m=await meta(id);
    if(m.runtime===x.desiredRuntime){
      report.skips.push({id,reason:'ALREADY_CORRECT',runtime:m.runtime}); continue;
    }
    const path=new URL(m.actionUrl).pathname;
    let unexpectedPost=null;
    const handler=async route=>{
      const req=route.request(); const u=new URL(req.url());
      if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){unexpectedPost='DESTRUCTIVE '+req.method()+' '+u.pathname; await route.abort(); return;}
      if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){unexpectedPost='UNEXPECTED_POST '+u.pathname; await route.abort(); return;}
      await route.continue();
    };
    await context.route('**/*',handler);
    await m.f.locator('input[name="runtime"]').fill(String(x.desiredRuntime));
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),m.f.evaluate(form=>form.requestSubmit())]);
    await page.waitForTimeout(450);
    await context.unroute('**/*',handler);
    if(unexpectedPost){report.blocked.push({id,reason:unexpectedPost}); continue;}
    report.writes.push({id,season:x.season,episode:x.episode,from:m.runtime,to:x.desiredRuntime,youtubeId:x.youtubeId,duration:x.youtubeDuration});
    const v=await meta(id);
    if(v.runtime!==x.desiredRuntime) throw new Error(`Runtime verify failed ${id}: ${v.runtime} != ${x.desiredRuntime}`);
    report.verifications.push({id,ok:true,runtime:v.runtime});
  }
  report.result=report.blocked.length?'APPLIED_WITH_BLOCKED_DRIFT':'APPLIED_AND_VERIFIED';
}catch(e){
  report.blocked.push({reason:e?.stack||String(e)});
  report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile('reports/amixem-runtime-apply/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/amixem-runtime-apply/summary.txt',[
  `mode=${report.mode}`,`authenticated=${report.authenticated}`,`planned=${report.planned}`,
  `writes=${report.writes.length}`,`skips=${report.skips.length}`,`blocked=${report.blocked.length}`,
  `verifications=${report.verifications.length}`,`result=${report.result}`
].join('\n')+'\n');
console.log(await fs.readFile('reports/amixem-runtime-apply/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','APPLIED_WITH_BLOCKED_DRIFT'].includes(report.result)) process.exitCode=2;
