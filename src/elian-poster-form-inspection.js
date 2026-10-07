import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',OUT='reports/elian-poster-form-inspection-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_ELIAN_POSTER_FORM_INSPECTION',authenticated:false,form:null,bodyText:null,result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(600);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);
 await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated) throw new Error('Auth not proven');
 await go(BASE+'/artwork/upload?type=2&series=462729');
 const form=page.locator('form[action*="/artwork/upload_handler"]').first();
 if(!(await form.count()))throw new Error('Poster upload form missing');
 report.form=await form.evaluate(f=>({
  action:f.getAttribute('action'),
  method:f.getAttribute('method'),
  enctype:f.getAttribute('enctype'),
  html:f.outerHTML,
  controls:[...f.querySelectorAll('input,select,textarea')].map(el=>({
    tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),name:el.getAttribute('name'),
    value:el.value??el.getAttribute('value'),required:el.required||false,accept:el.getAttribute('accept'),
    options:el.tagName==='SELECT'?[...el.options].map(o=>({value:o.value,text:o.text,selected:o.selected})):undefined
  })),
  buttons:[...f.querySelectorAll('button,input[type="submit"]')].map(el=>({text:(el.textContent||'').trim(),type:el.getAttribute('type'),value:el.getAttribute('value')}))
 }));
 report.bodyText=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,10000);
 report.result='INSPECTION_COMPLETE_ZERO_WRITES';
}catch(e){report.error=String(e?.stack||e);report.result='INSPECTION_FAILED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,form:report.form?.controls,body:report.bodyText},null,2));
if(report.result!=='INSPECTION_COMPLETE_ZERO_WRITES')process.exitCode=2;
