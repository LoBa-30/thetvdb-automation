import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const source=JSON.parse(await fs.readFile('reports/amixem-final/audit.json','utf8'));
const wanted=source.tvdb_historical_without_current_public_youtube||[];
await fs.mkdir('reports/amixem-historical-details',{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'en-US',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
});
async function go(p,url){let r=null;for(let a=1;a<=3;a++){r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await p.waitForTimeout(180);return r;}await p.waitForTimeout(500*a);}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}

const report={generatedAt:new Date().toISOString(),target:'Amixem',mode:'READ_ONLY_HISTORICAL_TVDB_DETAILS',expected:wanted.length,episodes:[],errors:[]};

for(const item of wanted){
 const p=await context.newPage();
 try{
   await go(p,item.episode_url);
   const body=(await p.locator('body').innerText()).replace(/\s+/g,' ').trim();
   const hs=await p.locator('h1,h2').allTextContents();
   const heading=hs.map(x=>x.trim()).find(Boolean)||null;
   const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
   const runtime=body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;
   const created=body.match(/CREATED\s+(.+?)\s+by\s+/i)?.[1]||null;
   const modified=body.match(/MODIFIED\s+(.+?)\s+by\s+/i)?.[1]||null;
   const links=await p.locator('a').evaluateAll(ns=>ns.map(n=>n.href||'').filter(Boolean));
   const youtubeLinks=links.filter(u=>/youtube\.com\/watch|youtu\.be\//i.test(u));
   const hasArtwork=/Replace Artwork/i.test(body);
   let description=null;
   if(heading){
     const idx=body.indexOf(heading);
     if(idx>=0){
       const after=body.slice(idx+heading.length);
       const cut=after.search(/\s+(?:English|français|General|Cast & Crew)\s+/i);
       if(cut>0) description=after.slice(0,cut).trim()||null;
     }
   }
   report.episodes.push({
     code:item.code,episodeId:item.episode_id,title:item.title,date:item.date,
     heading,firstAired:aired,runtimeMinutes:runtime?Number(runtime):item.runtime_minutes,
     createdText:created,modifiedText:modified,description,
     officialYoutubeLinks:youtubeLinks,hasArtwork,detailUrl:item.episode_url
   });
 }catch(e){report.errors.push({code:item.code,id:item.episode_id,error:String(e?.message||e)});}
 finally{await p.close();}
}
await browser.close();
report.summary={
 total:report.episodes.length,
 withDescription:report.episodes.filter(x=>x.description).length,
 withOfficialYoutubeLink:report.episodes.filter(x=>x.officialYoutubeLinks?.length).length,
 withArtwork:report.episodes.filter(x=>x.hasArtwork).length,
 errors:report.errors.length
};
await fs.writeFile('reports/amixem-historical-details/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report.summary));
if(report.errors.length) process.exitCode=2;
