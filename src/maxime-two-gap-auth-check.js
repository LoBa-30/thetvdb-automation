import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password)throw new Error('Missing credentials');
const BASE='https://thetvdb.com',SLUG='maxime-biaggi',OUT='reports/maxime-two-gap-auth-check-2026-10-07';
const T=[{code:'S2019E01',id:'11696580',title:'Try not to embrasser son pote (nouveau challenge trop dur)'},{code:'S2025E01',id:'11696637',title:"2 jours pour faire une piste noire (j'ai jamais skié)"}];
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),authenticated:false,rows:[],result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(700);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 for(const t of T){
  await go(BASE+'/series/'+SLUG+'/episodes/'+t.id);
  const html=await page.content(),body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
  const urls=[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];
  const links=await page.locator('a[href*="/artwork/upload"]').evaluateAll(as=>as.map(a=>({text:(a.textContent||'').trim(),href:a.href})));
  report.rows.push({code:t.code,id:t.id,title:t.title,heading:(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null,screencaps:urls,uploadLinks:links,hasAddArtwork:/Add Artwork/i.test(body),bodyPreview:body.slice(0,4000)});
 }
 report.result='CHECK_COMPLETE';
}catch(e){report.error=String(e?.stack||e);report.result='CHECK_FAILED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.result!=='CHECK_COMPLETE')process.exitCode=2;
