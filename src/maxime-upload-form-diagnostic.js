import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',SLUG='maxime-biaggi',SERIES='475945';
const X={episodeId:'11696606',code:'S2023E04',title:"J'organise une chasse à l'homme dans Paris !!!"};
const OUT='reports/maxime-upload-form-diagnostic-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_MAXIME_UPLOAD_FORM_DIAGNOSTIC',authenticated:false,target:X,episode:null,upload:null,result:'NOT_STARTED'};
async function go(url){const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);await page.waitForTimeout(800);return r;}
try{
  let r=await go(BASE+'/auth/login'); if(!r||r.status()>=400) throw new Error('login GET failed');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
  await lf.evaluate(form=>form.requestSubmit()).catch(()=>{});
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForTimeout(900);
  const auth=await context.request.get(BASE+'/auth/getuser');
  report.authenticated=auth.ok();
  if(!report.authenticated) throw new Error('Auth not proven');
  r=await go(BASE+'/series/'+SLUG+'/episodes/'+X.episodeId);
  report.episode={http:r?.status()??null,pageUrl:page.url(),heading:(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null,body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,3000)};
  r=await go(BASE+'/artwork/upload?type=11&episode='+X.episodeId+'&series='+SERIES);
  const forms=await page.locator('form').evaluateAll(fs=>fs.map(f=>({action:f.getAttribute('action'),method:f.getAttribute('method'),text:(f.innerText||'').replace(/\s+/g,' ').trim(),controls:[...f.querySelectorAll('input,select,textarea')].map(e=>({name:e.getAttribute('name'),type:e.getAttribute('type'),value:e.value??e.getAttribute('value')}))})));
  report.upload={http:r?.status()??null,pageUrl:page.url(),title:await page.title(),body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,5000),forms};
  const expected=forms.find(f=>f.action==='/artwork/upload_handler');
  report.result=expected?'UPLOAD_FORM_PRESENT':'UPLOAD_FORM_ABSENT_READ_ONLY';
}catch(e){report.error=String(e?.stack||e);report.result='DIAGNOSTIC_ERROR';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({authenticated:report.authenticated,result:report.result,upload:report.upload&&{http:report.upload.http,pageUrl:report.upload.pageUrl,title:report.upload.title,forms:report.upload.forms.map(f=>f.action)}},null,2));
if(report.result==='DIAGNOSTIC_ERROR')process.exitCode=2;
