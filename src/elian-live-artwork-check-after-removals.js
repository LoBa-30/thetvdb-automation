import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',OUT='reports/elian-live-artwork-check-after-removals-2026-10-07';
const EPS=[
 {code:'S2023E02',id:'11092249',title:'RAP CONTENDERS ZEN ÉMISSION'},
 {code:'S2026E02',id:'11665002',title:'Son couple, ses projets, sa vie ft @Mastu'}
];
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_ELIAN_LIVE_ARTWORK_CHECK_AFTER_REMOVALS',authenticated:false,episodes:[],series:null,result:'NOT_STARTED'};
const artUrls=html=>[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(500);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);
 await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated)throw new Error('Auth not proven');

 for(const e of EPS){
   await go(BASE+'/series/'+SLUG+'/episodes/'+e.id);
   const html=await page.content();
   const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
   report.episodes.push({...e,heading,artworks:artUrls(html),body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,1800)});
 }
 await go(BASE+'/series/'+SLUG);
 const html=await page.content();
 report.series={
   posters:[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+series\/462729\/posters\/[^"'<>\s]+/g)].map(x=>x[0]))],
   icons:[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+series\/462729\/icons\/[^"'<>\s]+/g)].map(x=>x[0]))],
   banners:[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+series\/462729\/banners\/[^"'<>\s]+/g)].map(x=>x[0]))],
   body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,3500)
 };
 report.result='CHECK_COMPLETE_ZERO_WRITES';
}catch(e){report.error=String(e?.stack||e);report.result='CHECK_FAILED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({episodes:report.episodes.map(x=>({code:x.code,artworks:x.artworks})),series:report.series,result:report.result},null,2));
if(report.result!=='CHECK_COMPLETE_ZERO_WRITES')process.exitCode=2;
