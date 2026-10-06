import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MCFLY_2025_DUPLICATE_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='338282-show',OUT='reports/mcfly-2025-e54-duplicate-apply';
const C={source:'11261473',target:'11261488',date:'July 27, 2025',targetTitle:'MÉLI-MÉLO 4 (tout simplement)',targetRuntime:99,created:'July 26, 2025'};
if(!armed)throw new Error('Not armed');
if(!username||!password)throw new Error('Missing credentials');
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),target:'Mcfly & Carlito',mode:'EXACT_DUPLICATE_FRESH_PREFLIGHT_AND_SINGLE_APPLY',authenticated:false,checks:{},write:null,verification:null,blocked:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(u){let r=null;for(let i=1;i<=3;i++){r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(400);return r;}await page.waitForTimeout(700*i);}return r;}
function clean(s){return String(s||'').replace(/\s+/g,' ').trim();}
try{
 await go(BASE+'/auth/login');
 const login=page.locator('form').filter({has:page.locator('input[type=password]')}).first();
 await login.locator('input[name=email]').fill(username);
 await login.locator('input[name=password]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),login.locator('button[type=submit],input[type=submit]').first().click()]);
 await page.waitForTimeout(900);
 const probe=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
 report.authenticated=Boolean(probe?.ok());
 if(!report.authenticated)throw new Error('Authentication not proven; no challenge bypass attempted');

 const tr=await go(`${BASE}/series/${SLUG}/episodes/${C.target}`);
 if(!tr||tr.status()>=400)throw new Error('Canonical target unavailable');
 const tb=clean(await page.locator('body').innerText());
 report.checks.target={
  http:tr.status(),
  title:tb.includes(C.targetTitle),
  date:tb.includes(C.date),
  runtime:tb.includes('RUNTIME '+C.targetRuntime+' minutes'),
  created:tb.includes('CREATED '+C.created)
 };
 if(!Object.values(report.checks.target).every(Boolean))throw new Error('Canonical target mismatch');

 const sr=await go(`${BASE}/series/${SLUG}/episodes/${C.source}`);
 if(!sr||sr.status()>=400){
  report.result='ALREADY_ABSENT';
  report.verification={sourceAbsent:true,targetStillPresent:true};
 }else{
  const sb=clean(await page.locator('body').innerText());
  report.checks.source={
   http:sr.status(),
   unknownTitle:/Unknown Title/i.test(sb),
   date:sb.includes(C.date),
   runtimeMissing:!(/RUNTIME\s+\d+\s+minutes/i.test(sb)),
   created:sb.includes('CREATED '+C.created),
   creator:sb.includes('LEBOURG VALENTIN')
  };
  if(!Object.values(report.checks.source).every(Boolean))throw new Error('Source drift; duplicate proof no longer exact');

  const del=page.locator('form[action*="/entity/delete"]').first();
  if(!(await del.count()))throw new Error('Delete/merge form unavailable in authenticated page');
  const hid=await del.locator('input[name=id]').inputValue();
  const typ=await del.locator('input[name=type]').inputValue();
  report.checks.form={id:hid,type:typ};
  if(hid!==C.source||typ!=='3')throw new Error('Delete form identity mismatch');

  const values=await del.evaluate((form,target)=>{
   const reason=form.querySelector('select[name="delete-reason"]');
   const mergeType=form.querySelector('select[name="mergeto_entitytype"]');
   const mergeId=form.querySelector('input[name="mergeto_id"]');
   if(!reason||!mergeType||!mergeId)return null;
   reason.value='50';mergeType.value='3';mergeId.value=target;
   return Object.fromEntries([...new FormData(form).entries()]);
  },C.target);
  if(!values)throw new Error('Duplicate merge fields missing');
  if(values['delete-reason']!=='50'||values['mergeto_entitytype']!=='3'||values['mergeto_id']!==C.target)throw new Error('Merge payload mismatch');

  const actionUrl=await del.evaluate(f=>f.action);
  const submit=await page.evaluate(async ({actionUrl,values})=>{
   const body=new URLSearchParams(); for(const [k,v] of Object.entries(values))body.append(k,String(v));
   const r=await fetch(actionUrl,{method:'POST',body,credentials:'include',redirect:'follow',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'}});
   return {status:r.status,url:r.url,text:(await r.text()).slice(0,700)};
  },{actionUrl,values});
  report.write={source:C.source,target:C.target,submitHttp:submit.status,submitUrl:submit.url,bodyPreview:clean(submit.text).slice(0,300)};
  if(submit.status>=400)throw new Error('Normal authenticated merge/delete rejected with HTTP '+submit.status);

  await page.waitForTimeout(800);
  const vr=await page.goto(`${BASE}/series/${SLUG}/episodes/${C.source}`,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  await page.waitForTimeout(250);
  const still=await page.locator(`form[action*="/entity/delete"] input[name=id][value="${C.source}"]`).count().catch(()=>0);
  const tr2=await go(`${BASE}/series/${SLUG}/episodes/${C.target}`);
  const tb2=clean(await page.locator('body').innerText().catch(()=>''));
  const targetOk=Boolean(tr2&&tr2.status()<400&&tb2.includes(C.targetTitle)&&tb2.includes(C.date));
  report.verification={sourceHttpAfter:vr?.status()??null,sourceStillEditable:still>0,targetOk};
  if(still>0||!targetOk)throw new Error('Post-write verification failed');
  report.result='DELETED_AND_VERIFIED';
 }
}catch(e){
 report.blocked.push({reason:String(e?.message||e)});
 if(report.write?.submitHttp===401)report.result='BLOCKED_HTTP_401_NO_RETRY';
 else if(report.result==='NOT_STARTED')report.result=report.write?'WRITE_FAILED_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITE';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'result='+report.result,'blocked='+report.blocked.length,'submitHttp='+(report.write?.submitHttp??'none')].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!['DELETED_AND_VERIFIED','ALREADY_ABSENT','BLOCKED_HTTP_401_NO_RETRY'].includes(report.result))process.exitCode=2;
