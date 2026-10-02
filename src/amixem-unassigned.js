import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME, password=process.env.TVDB_PASSWORD;
const BASE='https://thetvdb.com', SLUG='328213-show';
const OUT='reports/amixem-unassigned';
await fs.mkdir(OUT,{recursive:true});
const report={authenticated:false,url:null,body:null,episodes:[],inputs:[],result:'NOT_STARTED'};
if(!username||!password) throw new Error('Missing credentials');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(url){
 let r=null;
 for(let i=1;i<=5;i++){
  r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(r&&r.status()<400){await page.waitForTimeout(500);return r;}
  await page.waitForTimeout(i*700);
 }
 throw new Error('GET failed '+url+' '+(r?.status()??'n/a'));
}
try{
 await go(BASE+'/auth/login');
 const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await f.locator('input[name="email"]').fill(username);
 await f.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(800);
 const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
 report.authenticated=Boolean(p?.ok());
 if(!report.authenticated) throw new Error('Authentication not proven');
 await go(BASE+'/series/'+SLUG+'/seasons/official/unassigned/edit');
 report.url=page.url();
 report.body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
 report.episodes=await page.locator('a[href*="/episodes/"]').evaluateAll(as=>as.map(a=>({
   href:a.href,title:(a.textContent||'').replace(/\s+/g,' ').trim(),
   context:(a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement)?.textContent?.replace(/\s+/g,' ').trim()||''
 })));
 report.inputs=await page.locator('input').evaluateAll(ins=>ins.map(i=>({name:i.name,value:i.value,type:i.type})).filter(x=>x.name));
 report.result='OK';
}catch(e){report.result='FAILED';report.error=e?.stack||String(e);}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({authenticated:report.authenticated,result:report.result,url:report.url,episodes:report.episodes,inputs:report.inputs},null,2));
if(report.result!=='OK') process.exitCode=2;