import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const OUT='reports/squeezie-artwork';
const BASE='https://www.thetvdb.com/series/279758-show';
const SEASONS=Array.from({length:16},(_,i)=>2011+i);
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const page=await browser.newPage({locale:'en-US'});
const episodes=[];
for(const season of SEASONS){
  await page.goto(`${BASE}/seasons/official/${season}`,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(500);
  const rows=await page.locator('tr').evaluateAll((trs,season)=>{
    const out=[];
    for(const tr of trs){
      const text=(tr.innerText||'').replace(/\s+/g,' ').trim();
      const m=text.match(new RegExp(`S${season}E(\\d+)\\s+(.+)`,'i'));
      if(!m) continue;
      const a=tr.querySelector('a[href*="/episodes/"]');
      if(!a) continue;
      out.push({season:Number(season),episode:Number(m[1]),code:`S${season}E${String(Number(m[1])).padStart(2,'0')}`,title:(a.textContent||'').replace(/\s+/g,' ').trim(),url:a.href});
    }
    return out;
  },season);
  episodes.push(...rows);
}
await browser.close();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function inspect(ep){
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const res=await fetch(ep.url,{headers:{'user-agent':'Mozilla/5.0'}});
      const html=await res.text();
      const re=/https:\/\/artworks\.thetvdb\.com\/banners\/v4\/episode\/\d+\/screencap\/[A-Za-z0-9._-]+\.jpg/g;
      const images=[...new Set(html.match(re)||[])];
      const rid=[...html.matchAll(/artwork\/upload\?type=11&episode=\d+&replace=(\d+)/g)].map(m=>m[1]);
      return {...ep,http:res.status,images,hasImage:images.length>0,replaceArtworkIds:[...new Set(rid)]};
    }catch(e){
      if(attempt===3) return {...ep,http:null,images:[],hasImage:null,error:String(e?.message||e)};
      await sleep(250*attempt);
    }
  }
}

const results=[];
const concurrency=12;
let idx=0;
async function worker(){
  while(true){
    const i=idx++;
    if(i>=episodes.length) return;
    results[i]=await inspect(episodes[i]);
    if((i+1)%100===0) console.log(`Inspected ${i+1}/${episodes.length}`);
  }
}
await Promise.all(Array.from({length:concurrency},()=>worker()));

const bySeason={};
for(const season of SEASONS){
  const list=results.filter(r=>r.season===season);
  bySeason[season]={total:list.length,withImage:list.filter(r=>r.hasImage===true).length,withoutImage:list.filter(r=>r.hasImage===false).length,uncertain:list.filter(r=>r.hasImage==null).length};
}
const report={generatedAt:new Date().toISOString(),episodeCount:episodes.length,withImage:results.filter(r=>r.hasImage===true).length,withoutImage:results.filter(r=>r.hasImage===false).length,uncertain:results.filter(r=>r.hasImage==null).length,bySeason,episodes:results};
await fs.writeFile(`${OUT}/artwork-presence.json`,JSON.stringify(report,null,2));
let md=`# Squeezie — audit de présence des images TheTVDB\n\nGénéré: ${report.generatedAt}\n\nÉpisodes inspectés: ${report.episodeCount}\nImages présentes: ${report.withImage}\nImages absentes: ${report.withoutImage}\nPages incertaines: ${report.uncertain}\n\n`;
for(const season of SEASONS){const s=bySeason[season];md+=`- ${season}: ${s.total} épisodes — ${s.withImage} avec image — ${s.withoutImage} sans image — ${s.uncertain} incertains\n`;}
md+='\nImportant: présence ≠ provenance. La provenance doit être vérifiée contre la vidéo YouTube exacte avant toute conservation/remplacement.\n';
await fs.writeFile(`${OUT}/ARTWORK_PRESENCE.md`,md);
console.log(md);
