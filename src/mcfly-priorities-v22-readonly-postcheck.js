import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const BASE='https://thetvdb.com', SLUG='338282-show', ID='12022496';
const OUT='reports/mcfly-priorities-v22-readonly-postcheck';
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_POSTCHECK_NO_EDIT',authenticated:false,
  id:ID, url:null, seasonRow:null, date:null, currentPage:null, messages:[], blocked:[], result:'NOT_STARTED'};
let browser;let readOnly=false;
try{
 const user=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
 if(!user||!password)throw new Error('MISSING_GITHUB_SECRETS');
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({locale:'fr-FR'});const page=await context.newPage();
 await context.route('**/*',async route=>{
  const req=route.request();
  if(readOnly&&new URL(req.url()).hostname.endsWith('thetvdb.com')&&!['GET','HEAD','OPTIONS'].includes(req.method().toUpperCase())){
    return route.abort('blockedbyclient');
  }
  await route.continue();
 });
 const go=async url=>{
  const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  if(!r||r.status()>=400)throw new Error('TVDB_HTTP_'+(r?.status()||'NONE'));
  if(/\/auth\/login/.test(page.url())&&!/\/auth\/login/.test(url))throw new Error('AUTH_REDIRECT');
  return r;
 };
 await go(BASE+'/auth/login');
 const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 if(await f.count()!==1)throw new Error('LOGIN_FORM_UNAVAILABLE');
 await f.locator('input[name="email"]').fill(user);
 await f.locator('input[name="password"]').fill(password);
 await f.locator('button[type="submit"],input[type="submit"]').first().click();
 await page.waitForLoadState('domcontentloaded').catch(()=>{});
 const p=await context.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
 if(!p?.ok())throw new Error('LOGIN_NOT_PROVEN');
 const payload=await p.json().catch(()=>null);
 if(!payload||!Object.keys(payload).length)throw new Error('EMPTY_ACCOUNT_PAYLOAD');
 report.authenticated=true;readOnly=true;
 await go(BASE+'/series/'+SLUG+'/seasons/official/2026/edit');
 const rows=await page.locator('input[name^="episodes["]').evaluateAll(ins=>ins.map(i=>{
  const c=i.closest('tr')||i.closest('.row')||i.parentElement?.parentElement||i.parentElement;
  const a=c?.querySelector('a[href*="/episodes/"]');
  return {id:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,number:Number(i.value),
   title:(a?.textContent||'').trim()};
 }));
 report.seasonRow=rows.find(x=>x.id===ID)||null;
 if(!report.seasonRow||report.seasonRow.number!==60)throw new Error('ID_SEASON_DRIFT');
 await go(BASE+'/series/'+SLUG+'/episodes/'+ID+'/0/edit');
 const form=page.locator('form').filter({has:page.locator('input[name="airdate"]')}).first();
 if(await form.count()!==1)throw new Error('DATE_FORM_MISSING');
 report.date=await form.locator('input[name="airdate"]').inputValue();
 report.url=page.url();
 report.formAction=await form.getAttribute('action');
 const messages=await page.locator('.alert,[role="alert"],.error,.invalid-feedback').allTextContents().catch(()=>[]);
 report.messages=messages.map(s=>s.trim()).filter(Boolean).slice(0,8);
 await go(BASE+'/series/'+SLUG+'/episodes/'+ID);
 report.currentPage={url:page.url(),heading:(await page.locator('h1').first().innerText().catch(()=>''))};
 report.result=report.date==='2026-10-06'?'CORRECTED_DATE_NOW_VISIBLE':report.date==='2026-06-06'?'OLD_DATE_STILL_PRESENT':'UNEXPECTED_DATE_REVIEW';
}catch(e){report.result='BLOCKED_OR_REVIEW_REQUIRED';report.blocked.push(String(e?.message||e));}
finally{if(browser)await browser.close().catch(()=>{});}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,authenticated:report.authenticated,date:report.date,
 blocked:report.blocked,formAction:report.formAction}));
if(!['CORRECTED_DATE_NOW_VISIBLE','OLD_DATE_STILL_PRESENT'].includes(report.result))process.exitCode=2;
