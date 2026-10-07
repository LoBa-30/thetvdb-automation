import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MCFLY_GROSSE_ANNONCE_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com';
const SLUG='338282-show';
const OUT='reports/mcfly-grosse-annonce-apply';
const TARGET={youtubeId:'fttKpTYRdMs',title:'GROSSE ANNONCE',date:'2015-04-12',durationSeconds:78,runtimeMinutes:1,season:2015,number:1};
const EXISTING=[
  {id:'10752678',oldNumber:1,newNumber:2,title:'LE FAT SHOW S3E1 Feat. CYPRIEN'},
  {id:'10752715',oldNumber:2,newNumber:3,title:'LE FAT SHOW S3E2 Feat. NATOO'},
  {id:'10752716',oldNumber:3,newNumber:4,title:'LE FAT SHOW S3E3 Feat. BUN HAY MEAN'},
  {id:'10752717',oldNumber:4,newNumber:5,title:'LE FAT SHOW S3E4 Feat. SLIM BERHOUN'}
];

await fs.mkdir(OUT,{recursive:true});
const report={
  generatedAt:new Date().toISOString(),
  mode:'GROSSE_ANNONCE_GUARDED_CHRONOLOGICAL_INSERT',
  armed,authenticated:false,target:TARGET,
  checks:[],writes:[],verifications:[],rollbackAttempts:[],blocked:[],result:'NOT_STARTED'
};
if(!armed){
  report.result='BLOCKED_NOT_ARMED';
  await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
  throw new Error('Apply not armed');
}
if(!username||!password){
  report.result='BLOCKED_MISSING_CREDENTIALS';
  await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
  throw new Error('Missing TVDB credentials');
}

// Evidence guards from already-persisted project reports.
try{
  const dateProof=JSON.parse(await fs.readFile('reports/mcfly-grosse-annonce-date-proof-2026-10-07.json','utf8'));
  if(dateProof.youtubeId!==TARGET.youtubeId || dateProof.youtubeTitle!==TARGET.title || dateProof.exactPublicationDate!==TARGET.date){
    throw new Error('Persisted exact-date proof drift');
  }
  report.checks.push({type:'PERSISTED_DATE_PROOF',ok:true,source:'reports/mcfly-grosse-annonce-date-proof-2026-10-07.json'});

  const audit=JSON.parse(await fs.readFile('reports/mcfly-final/audit.json','utf8'));
  const extra=(audit.youtube_extras||[]).find(x=>x.id===TARGET.youtubeId);
  if(!extra || extra.title!==TARGET.title || Number(extra.duration_seconds)!==TARGET.durationSeconds){
    throw new Error('Fresh YouTube catalogue evidence drift');
  }
  report.checks.push({type:'PERSISTED_RUNTIME_IDENTITY_PROOF',ok:true,durationSeconds:extra.duration_seconds,duration:extra.duration});

  const pf=JSON.parse(await fs.readFile('reports/mcfly-grosse-annonce-preflight/report.json','utf8'));
  if(pf.result!=='PREFLIGHT_PASSED_ZERO_WRITES' || !pf.authenticated || pf.blocked?.length){
    throw new Error('Last insertion preflight was not clean');
  }
  report.checks.push({type:'PRIOR_ZERO_WRITE_PREFLIGHT',ok:true,generatedAt:pf.generatedAt});
}catch(e){
  report.blocked.push({reason:'EVIDENCE_GUARD_FAILED',detail:String(e?.message||e)});
  report.result='BLOCKED_BEFORE_LOGIN';
  await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exit(2);
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'en-US',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
});
const page=await context.newPage();
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();

async function go(p,url){
  let last=null;
  for(let a=1;a<=4;a++){
    last=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(last && last.status()<400){await p.waitForTimeout(350);return last;}
    await p.waitForTimeout(a*650);
  }
  throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
}
async function login(){
  await go(page,BASE+'/auth/login');
  const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await f.locator('input[name="email"]').fill(username);
  await f.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(()=>{}),
    f.locator('button[type="submit"],input[type="submit"]').first().click()
  ]);
  await page.waitForTimeout(800);
  const probe=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
  if(!probe?.ok()) return false;
  try{const x=await probe.json();return Boolean(x&&Object.keys(x).length);}catch{return false;}
}
async function readSeason(){
  await go(page,BASE+'/series/'+SLUG+'/seasons/official/2015/edit');
  return await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
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
}
function validateExisting(rows,useNew=false){
  if(rows.length!==4) throw new Error('Expected 4 existing Season 2015 episodes, found '+rows.length);
  for(const e of EXISTING){
    const row=rows.find(x=>x.publicId===e.id);
    const expected=useNew?e.newNumber:e.oldNumber;
    if(!row || row.number!==expected || norm(row.title)!==norm(e.title)){
      throw new Error('Season mapping drift for '+e.id+' expected E'+expected+' '+e.title+' actual '+JSON.stringify(row));
    }
  }
}
async function exactAssignedTitleHits(){
  await go(page,BASE+'/series/'+SLUG+'/allseasons/official');
  return await page.locator('a[href*="/series/'+SLUG+'/episodes/"]').evaluateAll((as,target)=>{
    const seen=new Set(),out=[];
    for(const a of as){
      const m=(a.href||'').match(/\/episodes\/(\d+)/);
      if(!m||seen.has(m[1]))continue;seen.add(m[1]);
      const title=(a.textContent||'').replace(/\s+/g,' ').trim();
      if(title.normalize('NFC')===target.normalize('NFC')) out.push({id:m[1],title});
    }
    return out;
  },TARGET.title);
}
async function unassignedCollisions(){
  await go(page,BASE+'/series/'+SLUG+'/seasons/official/unassigned/edit');
  return await page.locator('a[href*="/series/'+SLUG+'/episodes/"]').evaluateAll((as,target)=>{
    const seen=new Set(),out=[];
    for(const a of as){
      const m=(a.href||'').match(/\/episodes\/(\d+)/);
      if(!m||seen.has(m[1]))continue;seen.add(m[1]);
      const c=a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement;
      const title=(a.textContent||'').replace(/\s+/g,' ').trim();
      const rowText=(c?.textContent||'').replace(/\s+/g,' ').trim();
      if(title.normalize('NFC')===target.title.normalize('NFC') || rowText.includes(target.date)) out.push({id:m[1],title,rowText});
    }
    return out;
  },TARGET);
}
async function submitExpected(form,expectedPath){
  let bad=null;
  const handler=async route=>{
    const req=route.request();
    const u=new URL(req.url());
    const method=req.method().toUpperCase();
    if(u.origin===BASE && (method==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname))){
      bad='DESTRUCTIVE '+method+' '+u.pathname;await route.abort();return;
    }
    if(u.origin===BASE && method==='POST' && u.pathname!==expectedPath){
      bad='UNEXPECTED_POST '+u.pathname;await route.abort();return;
    }
    await route.continue();
  };
  await context.route('**/*',handler);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(()=>{}),
    form.evaluate(f=>f.requestSubmit())
  ]);
  await page.waitForTimeout(900);
  await context.unroute('**/*',handler);
  if(bad) throw new Error(bad);
}
async function renumber(forward=true){
  const rows=await readSeason();
  validateExisting(rows,!forward);
  const byId=new Map(rows.map(r=>[r.publicId,r]));
  for(const e of EXISTING){
    const row=byId.get(e.id);
    const n=forward?e.newNumber:e.oldNumber;
    await page.locator('input[name="episodes['+row.internalId+']"]').fill(String(n));
  }
  const form=page.locator('form').filter({has:page.locator('input[name="season_number"]')}).first();
  const action=await form.getAttribute('action');
  const expected='/series/'+SLUG+'/official/2015/saveseason';
  if(action!==expected) throw new Error('Unexpected season save action '+action);
  await submitExpected(form,expected);
  const verified=await readSeason();
  validateExisting(verified,forward);
  report.writes.push({type:forward?'RENUMBER_EXISTING_2015':'ROLLBACK_RENUMBER_EXISTING_2015',changes:EXISTING.map(e=>({id:e.id,from:forward?e.oldNumber:e.newNumber,to:forward?e.newNumber:e.oldNumber}))});
  report.verifications.push({type:'SEASON_RENUMBER',direction:forward?'forward':'rollback',ok:true});
}
async function bulkAddTarget(){
  await go(page,BASE+'/series/'+SLUG+'/seasons/official/2015/bulkadd');
  const form=page.locator('form').filter({has:page.locator('input[name="number[]"]')}).first();
  const action=await form.getAttribute('action');
  const expected='/series/'+SLUG+'/seasons/official/2015/savebulkadd';
  if(action!==expected) throw new Error('Unexpected bulkadd action '+action);
  await form.locator('input[name="number[]"]').first().fill(String(TARGET.number));
  await form.locator('input[name="name[]"]').first().fill(TARGET.title);
  await form.locator('input[name="date[]"]').first().fill(TARGET.date);
  await form.locator('input[name="runtime[]"]').first().fill(String(TARGET.runtimeMinutes));
  await submitExpected(form,expected);
  report.writes.push({type:'ADD_EPISODE',season:2015,number:1,title:TARGET.title,date:TARGET.date,runtimeMinutes:TARGET.runtimeMinutes,youtubeId:TARGET.youtubeId});
}
async function verifyFinal(){
  const rows=await readSeason();
  if(rows.length!==5) throw new Error('Expected 5 Season 2015 episodes after insert, found '+rows.length);
  const nums=rows.map(r=>r.number).sort((a,b)=>a-b);
  if(nums.join(',')!=='1,2,3,4,5') throw new Error('Final numbering not contiguous: '+nums.join(','));
  for(const e of EXISTING){
    const row=rows.find(x=>x.publicId===e.id);
    if(!row||row.number!==e.newNumber||norm(row.title)!==norm(e.title)) throw new Error('Final existing mapping mismatch '+e.id);
  }
  const added=rows.find(x=>x.number===1);
  if(!added||!added.publicId||norm(added.title)!==TARGET.title) throw new Error('New E01 not found or title mismatch: '+JSON.stringify(added));
  if(EXISTING.some(e=>e.id===added.publicId)) throw new Error('E01 unexpectedly reuses existing ID');

  await go(page,BASE+'/series/'+SLUG+'/episodes/'+added.publicId);
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
  const runtime=Number(body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||NaN);
  const dateObj=new Date(aired+' UTC');
  const iso=Number.isNaN(dateObj.getTime())?null:dateObj.toISOString().slice(0,10);
  if(norm(heading)!==TARGET.title) throw new Error('Final heading mismatch '+heading);
  if(iso!==TARGET.date) throw new Error('Final date mismatch '+aired+' => '+iso);
  if(runtime!==TARGET.runtimeMinutes) throw new Error('Final runtime mismatch '+runtime);

  const hits=await exactAssignedTitleHits();
  if(hits.length!==1||hits[0].id!==added.publicId) throw new Error('Final exact-title multiplicity mismatch '+JSON.stringify(hits));
  const collisions=await unassignedCollisions();
  if(collisions.length) throw new Error('Post-write Unassigned collision '+JSON.stringify(collisions));

  report.verifications.push({
    type:'FINAL_EPISODE_AND_ORDER',
    ok:true,
    newEpisodeId:added.publicId,
    code:'S2015E01',
    title:heading,
    date:iso,
    runtimeMinutes:runtime,
    exactAssignedTitleHits:hits.length,
    unassignedCollisions:collisions.length
  });
  return added.publicId;
}

let renumbered=false;
try{
  report.authenticated=await login();
  if(!report.authenticated) throw new Error('Authenticated session not proven');

  const before=await readSeason();
  validateExisting(before,false);
  report.checks.push({type:'FRESH_SEASON_STATE',ok:true,rows:before});

  const assignedHits=await exactAssignedTitleHits();
  if(assignedHits.length) throw new Error('Exact title already assigned: '+JSON.stringify(assignedHits));
  report.checks.push({type:'NO_ASSIGNED_EXACT_TITLE',ok:true});

  const collisions=await unassignedCollisions();
  if(collisions.length) throw new Error('Unassigned collision: '+JSON.stringify(collisions));
  report.checks.push({type:'NO_UNASSIGNED_COLLISION',ok:true});

  await renumber(true);
  renumbered=true;

  try{
    await bulkAddTarget();
  }catch(e){
    try{
      const rows=await readSeason();
      if(rows.length===4){
        validateExisting(rows,true);
        await renumber(false);
        renumbered=false;
        report.rollbackAttempts.push({ok:true,reason:'Bulk-add failed before episode creation; numbering restored'});
      }else{
        report.rollbackAttempts.push({ok:false,reason:'Bulk-add failed but season row count is '+rows.length+'; automatic rollback unsafe'});
      }
    }catch(re){
      report.rollbackAttempts.push({ok:false,reason:String(re?.message||re)});
    }
    throw e;
  }

  const newId=await verifyFinal();
  report.newEpisodeId=newId;
  report.result='APPLIED_AND_VERIFIED';
}catch(e){
  report.blocked.push({reason:String(e?.stack||e)});
  report.result=report.writes.length?'PARTIAL_OR_FAILED_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{
  await browser.close();
}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'armed='+report.armed,
  'authenticated='+report.authenticated,
  'writes='+report.writes.length,
  'verifications='+report.verifications.length,
  'rollbacks='+report.rollbackAttempts.length,
  'blocked='+report.blocked.length,
  'newEpisodeId='+(report.newEpisodeId||''),
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED') process.exitCode=2;
