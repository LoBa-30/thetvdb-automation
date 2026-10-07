import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',OUT='reports/tvdb-artwork-moderation-notifications-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_READ_ONLY_MODERATION_NOTIFICATION_INSPECTION',authenticated:false,home:null,candidates:[],pages:[],restriction:null,result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(700);return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);
 await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated) throw new Error('Auth not proven');

 await go(BASE+'/');
 report.home={
   url:page.url(),
   title:await page.title(),
   body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,12000),
   links:await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.innerText||a.textContent||'').replace(/\s+/g,' ').trim(),href:a.href})).filter(x=>/notif|message|account|profile|artwork/i.test(x.text+' '+x.href)).slice(0,200))
 };
 report.candidates=report.home.links.filter(x=>/notif|message/i.test(x.text+' '+x.href));
 const urls=[...new Set(report.candidates.map(x=>x.href))].slice(0,20);
 for(const u of urls){
   try{
     await go(u);
     const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,20000);
     report.pages.push({url:page.url(),title:await page.title(),body,links:await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.innerText||a.textContent||'').replace(/\s+/g,' ').trim(),href:a.href})).filter(x=>/artwork|remove|rule|notif|message/i.test(x.text+' '+x.href)).slice(0,100))});
   }catch(e){report.pages.push({url:u,error:String(e)});}
 }
 // Also inspect the poster upload page only to capture restriction text, no write.
 await go(BASE+'/artwork/upload?type=2&series=462729');
 const restrictionBody=(await page.locator('body').innerText()).replace(/\s+/g,' ');
 report.restriction={
   url:page.url(),
   restricted:/temporarily restricted from uploading/i.test(restrictionBody),
   excerpt:(restrictionBody.match(/Due to a number of artwork removals[^.]*\.[^.]*\.[^.]*\./i)||[])[0]||restrictionBody.slice(0,2500)
 };
 report.result='INSPECTION_COMPLETE_ZERO_WRITES';
}catch(e){
 report.error=String(e?.stack||e);report.result='INSPECTION_BLOCKED';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({authenticated:report.authenticated,candidates:report.candidates,pages:report.pages.map(x=>({url:x.url,title:x.title,excerpt:x.body?.slice(0,1500),error:x.error})),restriction:report.restriction,result:report.result},null,2));
if(report.result!=='INSPECTION_COMPLETE_ZERO_WRITES')process.exitCode=2;
