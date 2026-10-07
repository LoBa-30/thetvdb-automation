import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');

const BASE='https://thetvdb.com';
const SLUG='338282-show';
const OUT='reports/mcfly-grosse-annonce-preflight';
const TARGET={
  youtubeId:'fttKpTYRdMs',
  title:'GROSSE ANNONCE',
  date:'2015-04-12',
  durationSeconds:78,
  runtimeMinutes:1,
  season:2015,
  number:1
};
const EXPECTED=[
  {id:'10752678',number:1,title:'LE FAT SHOW S3E1 Feat. CYPRIEN'},
  {id:'10752715',number:2,title:'LE FAT SHOW S3E2 Feat. NATOO'},
  {id:'10752716',number:3,title:'LE FAT SHOW S3E3 Feat. BUN HAY MEAN'},
  {id:'10752717',number:4,title:'LE FAT SHOW S3E4 Feat. SLIM BERHOUN'}
];

await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'en-US',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
});
const page=await context.newPage();

let readOnly=false;
const blocked=[];
await context.route('**/*',async route=>{
  const req=route.request();
  const method=req.method().toUpperCase();
  if(readOnly && /thetvdb\.com/i.test(req.url()) && !['GET','HEAD','OPTIONS'].includes(method)){
    blocked.push({method,url:req.url()});
    return route.abort('blockedbyclient');
  }
  return route.continue();
});

async function go(p,url){
  let last=null;
  for(let a=1;a<=3;a++){
    last=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(last && last.status()<400){await p.waitForTimeout(300);return last;}
    await p.waitForTimeout(700*a);
  }
  throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
}

async function login(){
  await go(page,BASE+'/auth/login');
  const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await form.locator('input[name="email"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(()=>{}),
    form.locator('button[type="submit"],input[type="submit"]').first().click()
  ]);
  await page.waitForTimeout(800);
  const probe=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
  if(!probe?.ok()) return false;
  try{
    const x=await probe.json();
    return Boolean(x&&Object.keys(x).length);
  }catch{return false;}
}

const report={
  generatedAt:new Date().toISOString(),
  target:'Mcfly & Carlito',
  mode:'GROSSE_ANNONCE_CHRONOLOGICAL_INSERT_PREFLIGHT_READ_ONLY',
  targetEpisode:TARGET,
  authenticated:false,
  checks:[],
  blocked:[],
  result:'NOT_STARTED'
};

try{
  report.authenticated=await login();
  if(!report.authenticated) throw new Error('Authenticated session not proven');
  readOnly=true;

  await go(page,BASE+'/series/'+SLUG+'/seasons/official/2015/edit');
  const seasonRows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
    const name=input.getAttribute('name')||'';
    const internalId=name.match(/^episodes\[(\d+)\]$/)?.[1]||null;
    const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
    const a=c?.querySelector('a[href*="/episodes/"]');
    return {
      internalId,
      publicId:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,
      title:(a?.textContent||'').replace(/\s+/g,' ').trim(),
      number:Number(input.value)
    };
  }));
  report.checks.push({type:'SEASON_EDIT_ROWS',rows:seasonRows});
  if(seasonRows.length!==4) report.blocked.push({reason:'SEASON_COUNT_DRIFT',expected:4,actual:seasonRows.length});
  for(const e of EXPECTED){
    const row=seasonRows.find(x=>x.publicId===e.id);
    if(!row||row.number!==e.number||row.title!==e.title){
      report.blocked.push({reason:'SEASON_MAPPING_DRIFT',expected:e,actual:row||null});
    }
  }

  const metadata=[];
  for(const e of EXPECTED){
    const p=await context.newPage();
    await go(p,BASE+'/series/'+SLUG+'/episodes/'+e.id);
    const body=(await p.locator('body').innerText()).replace(/\s+/g,' ').trim();
    const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
    const runtime=body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;
    metadata.push({id:e.id,firstAired:aired,runtimeMinutes:runtime?Number(runtime):null});
    await p.close();
  }
  report.checks.push({type:'EXISTING_2015_METADATA',episodes:metadata});

  await go(page,BASE+'/series/'+SLUG+'/seasons/official/2015/bulkadd');
  const bulk=page.locator('form').filter({has:page.locator('input[name="number[]"]')}).first();
  const bulkCount=await bulk.count();
  const action=bulkCount?await bulk.getAttribute('action'):null;
  const fields=bulkCount?{
    number:await bulk.locator('input[name="number[]"]').count(),
    name:await bulk.locator('input[name="name[]"]').count(),
    date:await bulk.locator('input[name="date[]"]').count(),
    runtime:await bulk.locator('input[name="runtime[]"]').count()
  }:null;
  report.checks.push({type:'BULKADD_FORM',present:Boolean(bulkCount),action,fields});
  if(!bulkCount) report.blocked.push({reason:'BULKADD_FORM_MISSING'});
  if(action!=='/series/'+SLUG+'/seasons/official/2015/savebulkadd') report.blocked.push({reason:'BULKADD_ACTION_DRIFT',actual:action});
  if(!fields||fields.number<1||fields.name<1||fields.date<1||fields.runtime<1) report.blocked.push({reason:'BULKADD_FIELDS_MISSING',fields});

  // Authenticated Unassigned report was generated immediately before this preflight.
  // Here we independently re-read the Unassigned listing and reject any 2015-04-12/title collision.
  await go(page,BASE+'/series/'+SLUG+'/seasons/official/unassigned/edit');
  const urows=await page.locator('a[href*="/series/'+SLUG+'/episodes/"]').evaluateAll(as=>{
    const out=[];const seen=new Set();
    for(const a of as){
      const m=(a.href||'').match(/\/episodes\/(\d+)/);
      if(!m||seen.has(m[1]))continue;seen.add(m[1]);
      const c=a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement;
      out.push({id:m[1],title:(a.textContent||'').replace(/\s+/g,' ').trim(),rowText:(c?.textContent||'').replace(/\s+/g,' ').trim()});
    }return out;
  });
  const collisions=urows.filter(x=>/GROSSE ANNONCE/i.test(x.title+' '+x.rowText)||/2015-04-12/.test(x.rowText));
  report.checks.push({type:'UNASSIGNED_COLLISION_CHECK',count:urows.length,collisions});
  if(collisions.length) report.blocked.push({reason:'UNASSIGNED_COLLISION',collisions});

  report.result=report.blocked.length?'BLOCKED_STATE_DRIFT':'PREFLIGHT_PASSED_ZERO_WRITES';
}catch(e){
  report.blocked.push({reason:e?.stack||String(e)});
  report.result='BLOCKED_PREFLIGHT_ERROR';
}finally{
  report.readOnlyNetworkLock=true;
  report.blockedNonReadRequests=blocked;
  await browser.close();
}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'blocked='+report.blocked.length,
  'nonReadRequestsBlocked='+blocked.length,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='PREFLIGHT_PASSED_ZERO_WRITES') process.exitCode=2;
