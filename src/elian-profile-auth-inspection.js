import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',YT='https://www.youtube.com/@elianventre',OUT='reports/elian-profile-auth-inspection-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),authenticated:false,tvdb:{},youtube:{},result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(800);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated) throw new Error('Auth not proven');
 await go(BASE+'/series/'+SLUG);
 report.tvdb={
   url:page.url(),
   title:await page.title(),
   body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,12000),
   artworkLinks:await page.locator('a[href*="/artwork/"],a[href*="artwork"]').evaluateAll(as=>as.map(a=>({text:(a.textContent||'').trim(),href:a.href,title:a.getAttribute('title')}))),
   images:await page.locator('img').evaluateAll(imgs=>imgs.map(i=>({src:i.src,alt:i.alt,width:i.naturalWidth,height:i.naturalHeight})).filter(x=>/artworks\.thetvdb\.com/.test(x.src)))
 };
 await go(YT);
 for(const sel of ['button:has-text("Tout accepter")','button:has-text("Accept all")','button:has-text("Tout refuser")','button:has-text("Reject all")']){const b=page.locator(sel).first();if(await b.isVisible().catch(()=>false)){await b.click().catch(()=>{});await page.waitForTimeout(600);break;}}
 const avatars=await page.locator('img').evaluateAll(imgs=>imgs.map(i=>({src:i.src,alt:i.alt,width:i.naturalWidth,height:i.naturalHeight})).filter(x=>x.width>=80&&x.height>=80&&Math.abs(x.width-x.height)<=5));
 report.youtube={url:page.url(),title:await page.title(),avatars:avatars.slice(0,20)};
 report.result='INSPECTION_COMPLETE';
}catch(e){report.error=String(e?.stack||e);report.result='INSPECTION_FAILED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.result!=='INSPECTION_COMPLETE')process.exitCode=2;
