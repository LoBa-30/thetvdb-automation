import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const OUT='reports/squeezie-final';
const CUTOFF='2026-09-09';
await fs.mkdir(OUT,{recursive:true});

const norm=s=>(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
 .replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/[^a-z0-9à-ÿ#'!?]+/g,' ').replace(/\s+/g,' ').trim();
const tokenSet=s=>new Set(norm(s).split(/\s+/).filter(x=>x.length>1));
function sim(a,b){const A=tokenSet(a),B=tokenSet(b); if(!A.size||!B.size)return 0;let i=0;for(const x of A)if(B.has(x))i++;return 2*i/(A.size+B.size);}
const parseNd=async path=>{try{return (await fs.readFile(path,'utf8')).split(/\n+/).filter(Boolean).map(JSON.parse)}catch{return[]}};
const base=await parseNd('reports/squeezie-deep/youtube-player-metadata.ndjson');
const fall=await parseNd('reports/squeezie-deep/youtube-player-fallback.ndjson');
const piped=await parseNd('reports/squeezie-deep/youtube-piped-recovery.ndjson');
const flat=await parseNd('reports/squeezie-deep/youtube-flat.ndjson');

const ytMap=new Map();
for(const v of flat) if(v.id) ytMap.set(v.id,{id:v.id,title:v.title||'',source:'flat',url:'https://www.youtube.com/watch?v='+v.id});
for(const arr of [base,fall,piped]) for(const v of arr) if(v.id&&v.ok){
 const cur=ytMap.get(v.id)||{id:v.id,url:'https://www.youtube.com/watch?v='+v.id};
 ytMap.set(v.id,{...cur,...v,title:v.title||cur.title,source:arr===base?'youtube-player':arr===fall?'youtube-player-fallback':'piped'});
}
let yt=[...ytMap.values()].map(v=>({
 id:v.id,title:v.title||v.playlistTitle||'',publishDate:v.publishDate||v.uploadDate||null,
 durationSeconds:v.lengthSeconds??v.duration??null,durationMinutes:(v.lengthSeconds??v.duration)!=null?Math.round(Number(v.lengthSeconds??v.duration)/60):null,
 source:v.source,url:v.url||'https://www.youtube.com/watch?v='+v.id
}));
const cutoffVideos=yt.filter(v=>!v.publishDate||v.publishDate<=CUTOFF);
const exactDated=cutoffVideos.filter(v=>v.publishDate);

const browser=await chromium.launch({headless:true});
const page=await browser.newPage({locale:'fr-FR',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const tvdb=[];
const month={January:'01',February:'02',March:'03',April:'04',May:'05',June:'06',July:'07',August:'08',September:'09',October:'10',November:'11',December:'12'};
const parseDate=t=>{const m=(t||'').match(/(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})/);return m?m[3]+'-'+month[m[1]]+'-'+String(m[2]).padStart(2,'0'):null};
for(let season=2011;season<=2026;season++){
 await page.goto('https://www.thetvdb.com/series/279758-show/seasons/official/'+season,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(250);
 const rows=await page.locator('tr').evaluateAll((trs,season)=>trs.map(tr=>{
  const text=(tr.innerText||'').replace(/\s+/g,' ').trim();
  const m=text.match(new RegExp('S'+season+'E(\\d+)\\s+(.+)','i')); if(!m)return null;
  const cells=[...tr.querySelectorAll('td')].map(td=>(td.innerText||'').replace(/\s+/g,' ').trim());
  const link=tr.querySelector('a[href*="/episodes/"]')?.href||null;
  return {season:Number(season),episode:Number(m[1]),rowText:text,cells,link};
 }).filter(Boolean),season);
 for(const r of rows){
   const code='S'+season+'E'+String(r.episode).padStart(2,'0');
   const title=(r.cells[1]||'').replace(/\s+(season premiere|season finale|mid-season finale|mid-season premiere).*$/i,'').trim();
   const date=parseDate(r.rowText);
   const nums=r.cells.map(x=>/^\d+$/.test(x)?Number(x):null).filter(x=>x!=null&&x>0&&x<1000);
   const runtime=nums.length?nums.at(-1):null;
   tvdb.push({...r,code,title,firstAired:date,runtimeMinutes:runtime,
    seasonPremiere:/\bseason premiere\b/i.test(r.rowText)&&!/mid-season premiere/i.test(r.rowText),
    seasonFinale:/\bseason finale\b/i.test(r.rowText)&&!/mid-season finale/i.test(r.rowText),
    midSeasonPremiere:/mid-season premiere/i.test(r.rowText),midSeasonFinale:/mid-season finale/i.test(r.rowText)});
 }
}
await browser.close();

const used=new Set(), matches=[];
for(const v of exactDated.sort((a,b)=>(a.publishDate||'').localeCompare(b.publishDate||''))){
 const y=Number(v.publishDate.slice(0,4));
 const candidates=tvdb.filter(e=>e.season===y&&!used.has(e.code));
 let chosen=null,kind=null,score=0;
 const exact=candidates.find(e=>e.firstAired===v.publishDate&&norm(e.title)===norm(v.title));
 if(exact){chosen=exact;kind='exact-title-date';score=1;}
 else {
  const dateSame=candidates.filter(e=>e.firstAired===v.publishDate).map(e=>({e,s:sim(e.title,v.title)})).sort((a,b)=>b.s-a.s);
  if(dateSame[0]&&dateSame[0].s>=0.62&&(dateSame.length===1||dateSame[0].s-dateSame[1].s>=0.15)){chosen=dateSame[0].e;kind='date+fuzzy-title';score=dateSame[0].s;}
  else {
   const titleSame=candidates.filter(e=>norm(e.title)===norm(v.title));
   if(titleSame.length===1){chosen=titleSame[0];kind='exact-title';score=1;}
  }
 }
 if(chosen){used.add(chosen.code);matches.push({youtube:v,tvdb:chosen,kind,score});}
}
const missingTvdb=exactDated.filter(v=>!matches.some(m=>m.youtube.id===v.id));
const tvdbUnmatched=tvdb.filter(e=>!used.has(e.code));
const promo=/\b(teaser|trailer|bande annonce|bande-annonce|promotion|pub(?:licite|licité)?|collection yoko|yoko - collection)\b/i;
const suspiciousPromo=exactDated.filter(v=>promo.test(v.title));

const bySeason={};
for(let y=2011;y<=2026;y++){
 const ms=matches.filter(m=>m.tvdb.season===y);
 const te=tvdb.filter(e=>e.season===y).sort((a,b)=>a.episode-b.episode);
 const yy=exactDated.filter(v=>v.publishDate?.startsWith(String(y))).sort((a,b)=>a.publishDate.localeCompare(b.publishDate));
 const titleDiff=ms.filter(m=>norm(m.youtube.title)!==norm(m.tvdb.title));
 const dateDiff=ms.filter(m=>m.youtube.publishDate!==m.tvdb.firstAired);
 const runtimeDiff=ms.filter(m=>m.youtube.durationMinutes!=null&&m.tvdb.runtimeMinutes!=null&&Math.abs(m.youtube.durationMinutes-m.tvdb.runtimeMinutes)>1);
 const wrongPrem=te.filter(e=>e.seasonPremiere&&e.episode!==1);
 const max=te.at(-1)?.episode??null; const wrongFin=te.filter(e=>e.seasonFinale&&e.episode!==max);
 const gaps=[];for(let n=1;n<=max;n++)if(!te.some(e=>e.episode===n))gaps.push(n);
 bySeason[y]={youtubeDated:yy.length,tvdb:te.length,matched:ms.length,
  youtubeWithoutMatch:missingTvdb.filter(v=>v.publishDate?.startsWith(String(y))).length,
  tvdbWithoutMatch:tvdbUnmatched.filter(e=>e.season===y).length,
  titleDiff:titleDiff.length,dateDiff:dateDiff.length,runtimeDiff:runtimeDiff.length,
  wrongPremiere:wrongPrem.length,wrongFinale:wrongFin.length,gaps,
  titleDiffRows:titleDiff,dateDiffRows:dateDiff,runtimeDiffRows:runtimeDiff,
  youtubeWithoutMatchRows:missingTvdb.filter(v=>v.publishDate?.startsWith(String(y))),
  tvdbWithoutMatchRows:tvdbUnmatched.filter(e=>e.season===y)
 };
}
const report={generatedAt:new Date().toISOString(),cutoff:CUTOFF,
 youtube:{flatTotal:yt.length,dated:exactDated.length,undated:cutoffVideos.length-exactDated.length,
 sources:Object.fromEntries([...cutoffVideos.reduce((m,v)=>(m.set(v.source,(m.get(v.source)||0)+1),m),new Map())])},
 tvdb:{assigned:tvdb.length},matched:matches.length,missingTvdb:missingTvdb.length,tvdbUnmatched:tvdbUnmatched.length,
 suspiciousPromo:suspiciousPromo.map(v=>({id:v.id,title:v.title,date:v.publishDate})),bySeason,matches};
await fs.writeFile(OUT+'/FINAL_METADATA_AUDIT.json',JSON.stringify(report,null,2));
let md='# Squeezie — audit métadonnées consolidé\n\n';
md+=`Référence: ${CUTOFF}\nVidéos onglet officiel: ${report.youtube.flatTotal}\nMétadonnées datées vérifiées: ${report.youtube.dated}\nMétadonnées encore non datées: ${report.youtube.undated}\nÉpisodes TVDB assignés: ${report.tvdb.assigned}\nCorrespondances conservatrices: ${report.matched}\n\n`;
for(let y=2011;y<=2026;y++){const s=bySeason[y];md+=`## ${y}\nYT datées ${s.youtubeDated} | TVDB ${s.tvdb} | matchs ${s.matched} | YT sans match ${s.youtubeWithoutMatch} | TVDB sans match ${s.tvdbWithoutMatch} | titres diff ${s.titleDiff} | dates diff ${s.dateDiff} | runtimes diff>1m ${s.runtimeDiff} | premiere mal placée ${s.wrongPremiere} | finale mal placée ${s.wrongFinale}\n\n`;}
await fs.writeFile(OUT+'/FINAL_METADATA_AUDIT.md',md);
console.log(md);
