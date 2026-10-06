import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const SERIES='346011-show';
const BASE='https://thetvdb.com';
const OUT='reports/mastu-unassigned';
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR'});
const page=await context.newPage();

async function goto(url){
  let resp=null;
  for(let i=0;i<3;i++){
    try{
      resp=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      if(resp && resp.status()<400) return resp;
    }catch{}
    await page.waitForTimeout(800*(i+1));
  }
  throw new Error('GET failed '+url+' status='+(resp?.status()??'n/a'));
}

const report={generatedAt:new Date().toISOString(),target:'Mastu',mode:'READ_ONLY',listing:null,episodes:[],errors:[]};

try{
  const listUrl=`${BASE}/series/${SERIES}/seasons/official/unassigned/edit`;
  await goto(listUrl);
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
  const links=await page.locator(`a[href*="/series/${SERIES}/episodes/"]`).evaluateAll(as=>as.map(a=>({href:a.href,text:(a.textContent||'').trim()})));
  const uniq=[]; const seen=new Set();
  for(const l of links){
    const m=l.href.match(/\/episodes\/(\d+)/);
    if(m && !seen.has(m[1])){seen.add(m[1]);uniq.push({id:m[1],href:l.href,text:l.text});}
  }
  report.listing={url:listUrl,pageTitle:await page.title(),bodyPreview:body.slice(0,6000),episodeLinks:uniq};

  for(const l of uniq){
    try{
      await goto(l.href);
      const b=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
      const hs=await page.locator('h1,h2').allTextContents();
      const title=hs.map(x=>x.trim()).find(Boolean)||null;
      const firstAired=b.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
      const runtime=b.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;
      const season=b.match(/SEASON\s+(\d+)/i)?.[1]||null;
      const episode=b.match(/EPISODE\s+(\d+)/i)?.[1]||null;
      report.episodes.push({
        id:l.id,linkText:l.text,pageUrl:l.href,pageTitle:await page.title(),heading:title,
        firstAired,runtimeMinutes:runtime?Number(runtime):null,
        season:season?Number(season):null,episode:episode?Number(episode):null,
        bodyPreview:b.slice(0,2200)
      });
    }catch(e){report.errors.push({id:l.id,error:String(e?.message||e)});}
  }
}catch(e){report.errors.push({scope:'listing',error:String(e?.message||e)});}

await browser.close();
await fs.writeFile(`${OUT}/report.json`,JSON.stringify(report,null,2));
await fs.writeFile(`${OUT}/summary.txt`,
  `Mastu Unassigned read-only\nFound: ${report.listing?.episodeLinks?.length||0}\nRead: ${report.episodes.length}\nErrors: ${report.errors.length}\n`);
console.log('found='+(report.listing?.episodeLinks?.length||0)+' read='+report.episodes.length+' errors='+report.errors.length);
if(report.errors.length) process.exitCode=2;
