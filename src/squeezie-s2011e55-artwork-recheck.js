import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const BASE='https://thetvdb.com';
const OUT='reports/squeezie-s2011e55-artwork-recheck-2026-10-07';
const X={slug:'279758-show',episodeId:'5313816',code:'S2011E55',title:'Top 5 de la connerie | Episode 2'};
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_POST_TIMEOUT_ARTWORK_RECHECK',target:X,reads:[],result:'NOT_STARTED',blocked:[]};
const arts=html=>[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];
try{
  for(const delay of [0,3000,10000]){
    if(delay)await page.waitForTimeout(delay);
    const r=await page.goto(BASE+'/series/'+X.slug+'/episodes/'+X.episodeId,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(500);
    const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
    const artwork=arts(await page.content());
    report.reads.push({at:new Date().toISOString(),http:r?.status()??null,heading,artwork});
    if(artwork.length)break;
  }
  const last=report.reads.at(-1);
  report.result=last?.artwork?.length?'MATERIALIZED_AFTER_TIMEOUT_DO_NOT_RETRY':'STILL_MISSING_STAGE1_ONLY_SAFE_FOR_FRESH_FULL_RETRY';
}catch(e){report.blocked.push({reason:String(e?.stack||e)});report.result='READ_ONLY_CHECK_ERROR';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt','result='+report.result+'\nartworkCount='+(report.reads.at(-1)?.artwork?.length??0)+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result==='READ_ONLY_CHECK_ERROR')process.exitCode=2;
