import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const CUTOFF='2026-09-09';
const OUT='reports/squeezie-deep';
const TVDB_BASE='https://thetvdb.com/series/279758-show';
const SEASONS=Array.from({length:16},(_,i)=>2011+i);

const norm=s=>(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
const isoFromUpload=v=>{
  if(!v) return null;
  const s=String(v);
  if(/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return null;
};
const isoFromTimestamp=v=>{
  if(!v) return null;
  const d=new Date(Number(v)*1000); return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
};
const parseDateText=t=>{
  const m=(t||'').match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/);
  if(!m) return null;
  const d=new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`);
  return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
};
const secToMin=s=>s==null?null:Math.round(Number(s)/60);

await fs.mkdir(OUT,{recursive:true});
let sourceFile=`${OUT}/youtube-full.ndjson`;
try { await fs.access(sourceFile); } catch { sourceFile=`${OUT}/youtube-flat.ndjson`; }
const raw=await fs.readFile(sourceFile,'utf8');
const yt=raw.split(/\n+/).filter(Boolean).map(line=>JSON.parse(line)).map(v=>({
  id:v.id,
  title:v.title||v.fulltitle||'',
  url:v.webpage_url||v.url||`https://www.youtube.com/watch?v=${v.id}`,
  durationSeconds:v.duration??null,
  durationMinutes:v.duration==null?null:Math.round(v.duration/60),
  uploadDate:isoFromUpload(v.upload_date)||isoFromTimestamp(v.timestamp)||isoFromTimestamp(v.release_timestamp),
  timestamp:v.timestamp??null,
  availability:v.availability??null,
  liveStatus:v.live_status??null,
  thumbnails:v.thumbnails??[],
  thumbnail:(v.thumbnails||[]).at(-1)?.url||v.thumbnail||null,
  playlistIndex:v.playlist_index??null,
  description:v.description??null
})).filter(v=>v.id&&v.title);

const ytUnique=[...new Map(yt.map(v=>[v.id,v])).values()];
const ytCut=ytUnique.filter(v=>!v.uploadDate || v.uploadDate<=CUTOFF);

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36'});
const page=await context.newPage();
const tvdb=[];
const seasonErrors=[];

for (const season of SEASONS){
  const url=`${TVDB_BASE}/seasons/official/${season}`;
  try{
    const resp=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(1000);
    const rows=await page.locator('tr').evaluateAll((trs,season)=>{
      const out=[];
      for(const tr of trs){
        const text=(tr.innerText||'').replace(/\s+/g,' ').trim();
        const m=text.match(new RegExp(`S${season}E(\\d+)\\s+(.+)`,'i'));
        if(!m) continue;
        const tds=[...tr.querySelectorAll('td')].map(td=>(td.innerText||'').replace(/\s+/g,' ').trim());
        const link=tr.querySelector('a[href*="/episodes/"]');
        const img=tr.querySelector('img');
        out.push({
          season:Number(season),
          episode:Number(m[1]),
          code:`S${season}E${String(Number(m[1])).padStart(2,'0')}`,
          rowText:text,
          cells:tds,
          episodeHref:link?.href||null,
          imageSrc:img?.getAttribute('src')||img?.getAttribute('data-src')||img?.getAttribute('data-original')||null,
          imageAlt:img?.getAttribute('alt')||null
        });
      }
      return out;
    },season);
    for(const r of rows){
      const codePrefix=new RegExp(`^S${season}E${String(r.episode).padStart(2,'0')}\\s*`,'i');
      let title=r.cells?.[1]||r.rowText.replace(codePrefix,'');
      const dateCell=(r.cells||[]).find(c=>/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/.test(c))||r.rowText;
      const date=parseDateText(dateCell);
      let runtime=null;
      for(const c of (r.cells||[])){
        const n=Number(c);
        if(Number.isFinite(n)&&n>0&&n<1000){ runtime=n; }
      }
      title=title.replace(/\s+(season premiere|season finale|mid-season finale|mid-season premiere).*$/i,'').trim();
      tvdb.push({...r,title,firstAired:date,runtimeMinutes:runtime,
        seasonPremiere:/season premiere/i.test(r.rowText),
        seasonFinale:/season finale/i.test(r.rowText) && !/mid-season finale/i.test(r.rowText),
        midSeasonFinale:/mid-season finale/i.test(r.rowText),
        midSeasonPremiere:/mid-season premiere/i.test(r.rowText)
      });
    }
    if(!resp?.ok()) seasonErrors.push({season,error:`HTTP ${resp?.status()}`});
  }catch(e){seasonErrors.push({season,error:String(e?.message||e)});}
}

await browser.close();

function bestMatch(video,candidates){
  const exact=candidates.find(e=>norm(e.title)===norm(video.title) && (!video.uploadDate || !e.firstAired || e.firstAired===video.uploadDate));
  if(exact) return {episode:exact,kind:'exact-title'+(video.uploadDate&&exact.firstAired===video.uploadDate?'+date':'')};
  const sameTitle=candidates.find(e=>norm(e.title)===norm(video.title));
  if(sameTitle) return {episode:sameTitle,kind:'exact-title'};
  const sameDate=candidates.filter(e=>video.uploadDate&&e.firstAired===video.uploadDate);
  if(sameDate.length===1) return {episode:sameDate[0],kind:'exact-date'};
  return null;
}

const matched=[];
const missingTvdb=[];
const used=new Set();
for(const v of ytCut){
  const year=v.uploadDate?Number(v.uploadDate.slice(0,4)):null;
  const cands=tvdb.filter(e=>!used.has(e.code) && (!year||e.season===year));
  const m=bestMatch(v,cands);
  if(m){used.add(m.episode.code); matched.push({youtube:v,tvdb:m.episode,matchKind:m.kind});}
  else missingTvdb.push(v);
}
const tvdbUnmatched=tvdb.filter(e=>!used.has(e.code));

const bySeason={};
for(const season of SEASONS){
  const ytv=ytCut.filter(v=>v.uploadDate?.startsWith(String(season))).sort((a,b)=>{
    const d=(a.uploadDate||'').localeCompare(b.uploadDate||''); if(d) return d;
    if(a.timestamp!=null&&b.timestamp!=null&&a.timestamp!==b.timestamp) return a.timestamp-b.timestamp;
    if(a.playlistIndex!=null&&b.playlistIndex!=null&&a.playlistIndex!==b.playlistIndex) return b.playlistIndex-a.playlistIndex;
    return a.id.localeCompare(b.id);
  });
  const te=tvdb.filter(e=>e.season===season).sort((a,b)=>a.episode-b.episode);
  const mm=matched.filter(x=>x.tvdb.season===season);
  const titleDiff=mm.filter(x=>x.youtube.title!==x.tvdb.title);
  const dateDiff=mm.filter(x=>x.youtube.uploadDate&&x.tvdb.firstAired&&x.youtube.uploadDate!==x.tvdb.firstAired);
  const runtimeDiff=mm.filter(x=>x.youtube.durationMinutes!=null&&x.tvdb.runtimeMinutes!=null&&Math.abs(x.youtube.durationMinutes-x.tvdb.runtimeMinutes)>1);
  const noImage=te.filter(e=>!e.imageSrc);
  const imagePresent=te.filter(e=>!!e.imageSrc);
  const duplicateCodes=[...te.reduce((m,e)=>(m.set(e.code,(m.get(e.code)||0)+1),m),new Map())].filter(([,n])=>n>1);
  const wrongPremiere=te.filter(e=>e.seasonPremiere&&e.episode!==1);
  const finaleMarked=te.filter(e=>e.seasonFinale);
  const maxEp=te.at(-1)?.episode??null;
  const wrongFinale=finaleMarked.filter(e=>e.episode!==maxEp);
  const missingNumbers=[];
  for(let i=1;i<=maxEp;i++) if(!te.some(e=>e.episode===i)) missingNumbers.push(i);
  bySeason[season]={
    youtubeCountWithKnownDate:ytv.length,
    tvdbCount:te.length,
    matched:mm.length,
    youtubeWithoutTvdb:missingTvdb.filter(v=>v.uploadDate?.startsWith(String(season))),
    tvdbWithoutYoutube:tvdbUnmatched.filter(e=>e.season===season),
    titleDiff,dateDiff,runtimeDiff,noImage,imagePresent,duplicateCodes,missingNumbers,wrongPremiere,wrongFinale,
    firstTvdb:te[0]||null,lastTvdb:te.at(-1)||null,
    firstYoutube:ytv[0]||null,lastYoutube:ytv.at(-1)||null
  };
}

const suspiciousPromo=ytCut.filter(v=>/\b(teaser|trailer|bande[- ]annonce|annonce|extrait|promo(?:tion)?|sponsor|publicit[eé]|clip officiel)\b/i.test(v.title));
const missingDates=ytCut.filter(v=>!v.uploadDate);
const missingDurations=ytCut.filter(v=>v.durationSeconds==null);

const report={
 generatedAt:new Date().toISOString(),cutoff:CUTOFF,
 youtube:{rawCount:yt.length,uniqueCount:ytUnique.length,cutoffCount:ytCut.length,missingDates:missingDates.length,missingDurations:missingDurations.length},
 tvdb:{count:tvdb.length,seasonErrors},
 matched:matched.length,missingTvdbCount:missingTvdb.length,tvdbUnmatchedCount:tvdbUnmatched.length,
 suspiciousPromoCount:suspiciousPromo.length,
 bySeason,matchedRows:matched,tvdbEpisodes:tvdb,missingTvdb,tvdbUnmatched,suspiciousPromo,
 notes:[
  'YouTube source is the official @Squeezie /videos tab collected with yt-dlp flat playlist metadata.',
  'TheTVDB source is the current public annual season pages.',
  'Image presence and source URL are captured. A present image is NOT certified as belonging to the episode unless independently verified against the exact video.',
  'No TheTVDB write is performed by this audit.'
 ]
};
await fs.writeFile(`${OUT}/audit.json`,JSON.stringify(report,null,2));

let md=`# Audit profond Squeezie — métadonnées\n\nGénéré: ${report.generatedAt}\nDate de référence: ${CUTOFF}\n\n`;
md+=`YouTube: ${report.youtube.cutoffCount} vidéos retenues jusqu'à la date de référence (dates manquantes: ${report.youtube.missingDates}, durées manquantes: ${report.youtube.missingDurations}).\n\n`;
md+=`TheTVDB: ${report.tvdb.count} épisodes lus sur les saisons 2011–2026. Matchs automatiques exacts/conservateurs: ${report.matched}. YT sans match: ${report.missingTvdbCount}. TVDB sans match: ${report.tvdbUnmatchedCount}.\n\n`;
for(const season of SEASONS){
 const s=bySeason[season];
 md+=`## SAISON ${season}\n- vidéos YouTube datées: ${s.youtubeCountWithKnownDate}\n- épisodes TheTVDB: ${s.tvdbCount}\n- correspondances: ${s.matched}\n- YT sans match: ${s.youtubeWithoutTvdb.length}\n- TVDB sans match: ${s.tvdbWithoutYoutube.length}\n- titres différents parmi matchs: ${s.titleDiff.length}\n- dates différentes parmi matchs: ${s.dateDiff.length}\n- durées >1 min différentes: ${s.runtimeDiff.length}\n- épisodes sans image détectée: ${s.noImage.length}\n- épisodes avec image détectée: ${s.imagePresent.length}\n- numéros manquants: ${s.missingNumbers.join(', ')||'aucun'}\n- codes en double: ${s.duplicateCodes.length}\n- premiere mal placée: ${s.wrongPremiere.length}\n- finale mal placée: ${s.wrongFinale.length}\n\n`;
}
await fs.writeFile(`${OUT}/AUDIT.md`,md);
console.log(md);
