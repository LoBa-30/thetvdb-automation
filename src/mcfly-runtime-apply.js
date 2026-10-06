import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MCFLY_RUNTIME_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='338282-show';
const OUT='reports/mcfly-runtime-apply';
const PLAN=JSON.parse(await fs.readFile('config/mcfly-runtime-corrections-2026-10-06.json','utf8')).items;
await fs.mkdir(OUT,{recursive:true});

const report={generatedAt:new Date().toISOString(),target:'Mcfly & Carlito runtimes',mode:'GUARDED_RUNTIME_APPLY_NON_SUBSTANTIVE_TITLES',authenticated:false,planned:PLAN.length,preflight:[],writes:[],skips:[],verifications:[],blocked:[],result:'NOT_STARTED'};

function norm(s){
  return String(s??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g,'')
    .replace(/[\p{Extended_Pictographic}\u2600-\u27BF]/gu,'')
    .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(u){
  let r=null;
  for(let i=1;i<=4;i++){
    r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(r&&r.status()<400){await page.waitForTimeout(250);return r;}
    await page.waitForTimeout(i*500);
  }
  throw new Error('GET failed '+u+' '+(r?.status()??'n/a'));
}
async function login(){
  await go(BASE+'/auth/login');
  const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await f.locator('input[name="email"]').fill(username);
  await f.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(600);
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
  const h=async route=>{
    const req=route.request(),u=new URL(req.url());
    if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();}
    if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
    return route.continue();
  };
  await context.route('**/*',h);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
  await page.waitForTimeout(450);
  await context.unroute('**/*',h);
  if(bad) throw new Error(bad);
}

try{
  report.authenticated=await login();
  if(!report.authenticated) throw new Error('Authenticated session not proven');

  const maps=new Map();
  for(const year of [...new Set(PLAN.map(x=>x.season))]) maps.set(year,await seasonMap(year));

  // Full fresh preflight BEFORE any write.
  for(const x of PLAN){
    const row=maps.get(x.season)?.get(x.id);
    const m=await meta(x.id);
    const titleOk=Boolean(row&&[norm(x.title),norm(x.youtubeTitle)].includes(norm(row.title)));
    const ok=Boolean(row&&row.number===x.episode&&titleOk&&m.airdate===x.date&&[x.from,x.to].includes(m.runtime));
    report.preflight.push({id:x.id,code:x.code,row,airdate:m.airdate,runtime:m.runtime,expectedFrom:x.from,desired:x.to,titleOk,ok,youtubeId:x.youtubeId,youtubeDuration:x.youtubeDuration});
    if(!ok) throw new Error('PREFLIGHT_DRIFT '+x.code+' '+JSON.stringify({row,airdate:m.airdate,runtime:m.runtime,titleOk}));
  }

  for(const x of PLAN){
    const m=await meta(x.id);
    if(m.runtime===x.to){
      report.skips.push({id:x.id,code:x.code,reason:'ALREADY_CORRECT',runtime:m.runtime});
    }else{
      if(m.runtime!==x.from) throw new Error('RUNTIME_CHANGED_DURING_RUN '+x.code+' '+m.runtime);
      await m.f.locator('input[name="runtime"]').fill(String(x.to));
      await guardedSubmit(m.f,m.path);
      report.writes.push({id:x.id,code:x.code,from:x.from,to:x.to,youtubeId:x.youtubeId,duration:x.youtubeDuration});
    }
  }

  for(const x of PLAN){
    const v=await meta(x.id);
    const ok=v.runtime===x.to&&v.airdate===x.date;
    report.verifications.push({id:x.id,code:x.code,runtime:v.runtime,airdate:v.airdate,ok});
    if(!ok) throw new Error('POST_WRITE_VERIFY_FAILED '+x.code+' '+JSON.stringify(v));
  }
  report.result='APPLIED_AND_VERIFIED';
}catch(e){
  report.blocked.push({reason:String(e?.stack||e)});
  report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{
  await browser.close();
}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'planned='+report.planned,
  'preflightPassed='+report.preflight.filter(x=>x.ok).length,
  'writes='+report.writes.length,
  'skips='+report.skips.length,
  'blocked='+report.blocked.length,
  'verifications='+report.verifications.length,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED') process.exitCode=2;
