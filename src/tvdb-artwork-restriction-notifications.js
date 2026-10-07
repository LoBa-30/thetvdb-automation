import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',OUT='reports/tvdb-artwork-restriction-notifications-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_READ_ONLY_RESTRICTION_NOTIFICATION_AUDIT',authenticated:false,home:null,candidates:[],notifications:[],result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(600);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);
 await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated)throw new Error('Auth not proven');

 await go(BASE);
 const links=await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.innerText||'').replace(/\s+/g,' ').trim(),href:a.href,title:a.getAttribute('title')})).filter(x=>/notif|alert|message|inbox/i.test((x.text||'')+' '+(x.href||'')+' '+(x.title||''))));
 report.home={url:page.url(),links};
 const cands=[...new Set([
  ...links.map(x=>x.href).filter(Boolean),
  BASE+'/notifications',BASE+'/notification',BASE+'/user/notifications',BASE+'/account/notifications'
 ])];
 report.candidates=cands;
 for(const u of cands){
   try{
     const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:30000});
     await page.waitForTimeout(500);
     if(!r||r.status()>=400)continue;
     const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
     if(!/artwork|remove|notification|upload|restricted|deleted/i.test(body))continue;
     const anchors=await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.innerText||'').replace(/\s+/g,' ').trim(),href:a.href})).filter(x=>x.text||x.href));
     report.notifications.push({url:page.url(),status:r.status(),title:await page.title(),body:body.slice(0,15000),links:anchors.slice(0,300)});
   }catch{}
 }
 report.result='AUDIT_COMPLETE_ZERO_WRITES';
}catch(e){report.error=String(e?.stack||e);report.result='AUDIT_FAILED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({authenticated:report.authenticated,result:report.result,candidates:report.candidates,notifications:report.notifications.map(x=>({url:x.url,title:x.title,body:x.body.slice(0,3000)}))},null,2));
if(report.result!=='AUDIT_COMPLETE_ZERO_WRITES')process.exitCode=2;
