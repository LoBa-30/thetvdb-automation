import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const SERIES='279758-show';
const BASE='https://thetvdb.com';
const src=JSON.parse(await fs.readFile('reports/squeezie-current-structural/report.json','utf8'));
const wanted=src.tvdbWithoutCurrentPublicYoutubeMatch||[];
const bySeason=new Map();
for(const x of wanted){if(!bySeason.has(x.season))bySeason.set(x.season,[]);bySeason.get(x.season).push(x);}
await fs.mkdir('reports/squeezie-historical-details',{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'});
const page=await context.newPage();
async function go(p,url){let r=null;for(let a=1;a<=3;a++){r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await p.waitForTimeout(250);return r;}await p.waitForTimeout(500*a);}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}

const links=new Map();
for(const [season,items] of bySeason){
  await go(page,`${BASE}/series/${SERIES}/seasons/official/${season}`);
  const rows=await page.locator('a[href*="/series/'+SERIES+'/episodes/"]').evaluateAll(as=>{
    const out=[];const seen=new Set();
    for(const a of as){
      const href=a.href||'';const m=href.match(/\/episodes\/(\d+)/);if(!m||seen.has(m[1]))continue;seen.add(m[1]);
      const c=a.closest('tr')||a.closest('.row')||a.closest('.list-group-item')||a.parentElement?.parentElement||a.parentElement;
      out.push({id:m[1],href,rowText:(c?.textContent||'').replace(/\s+/g,' ').trim(),linkText:(a.textContent||'').replace(/\s+/g,' ').trim()});
    }
    return out;
  });
  for(const item of items){
    const code=item.code;
    const epNum=String(item.episode);
    let match=rows.find(r=>new RegExp('S'+season+'E0*'+epNum+'\\b','i').test(r.rowText));
    if(!match) match=rows.find(r=>r.linkText===item.title);
    if(match) links.set(code,match);
  }
}

const report={generatedAt:new Date().toISOString(),target:'Squeezie',mode:'READ_ONLY_HISTORICAL_TVDB_DETAILS',expected:wanted.length,foundLinks:links.size,episodes:[],errors:[]};
for(const item of wanted){
 const link=links.get(item.code);
 if(!link){report.errors.push({code:item.code,error:'EPISODE_LINK_NOT_FOUND'});continue;}
 const p=await context.newPage();
 try{
   await go(p,link.href);
   const body=(await p.locator('body').innerText()).replace(/\s+/g,' ').trim();
   const hs=await p.locator('h1,h2').allTextContents();
   const heading=hs.map(x=>x.trim()).find(Boolean)||null;
   const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
   const runtime=body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;
   const created=body.match(/CREATED\s+(.+?)\s+by\s+/i)?.[1]||null;
   const modified=body.match(/MODIFIED\s+(.+?)\s+by\s+/i)?.[1]||null;
   const linksAll=await p.locator('a').evaluateAll(ns=>ns.map(n=>n.href||'').filter(Boolean));
   const youtubeLinks=linksAll.filter(u=>/youtube\.com\/watch|youtu\.be\//i.test(u));
   const hasArtwork=/Replace Artwork/i.test(body);
   let description=null;
   const titlePos=heading?body.indexOf(heading):-1;
   if(titlePos>=0){
     let after=body.slice(titlePos+heading.length);
     const cut=after.search(/\s+(?:English|français|General|Cast & Crew)\s+/i);
     if(cut>0) description=after.slice(0,cut).trim()||null;
   }
   report.episodes.push({code:item.code,episodeId:link.id,title:item.title,firstAired:aired,runtimeMinutes:runtime?Number(runtime):null,createdText:created,modifiedText:modified,description,officialYoutubeLinks:youtubeLinks,hasArtwork,detailUrl:link.href});
 }catch(e){report.errors.push({code:item.code,id:link.id,error:String(e?.message||e)});}
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
await fs.writeFile('reports/squeezie-historical-details/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report.summary));
if(report.errors.length) process.exitCode=2;
