import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const BASE='https://thetvdb.com';
const SLUG='279758-show';
const SERIES='279758';
const OUT='reports/squeezie-artwork-preflight-2026-10-07';
await fs.mkdir(OUT,{recursive:true});

const audit=JSON.parse(await fs.readFile('reports/squeezie-final/FINAL_METADATA_AUDIT.json','utf8'));
const presence=JSON.parse(await fs.readFile('reports/squeezie-artwork/artwork-presence.json','utf8'));

const missing=new Map((presence.episodes||[]).filter(x=>x.hasImage===false).map(x=>[x.code,x]));
const pairs=[];
for(const season of Object.values(audit.bySeason||{})){
  for(const row of season.dateDiffRows||[]){
    if(row.kind!=='exact-title') continue;
    const yt=row.youtube||{},tv=row.tvdb||{};
    if(!yt.id||!tv.code||!tv.link||!tv.title) continue;
    if(!missing.has(tv.code)) continue;
    const m=String(tv.link).match(/\/episodes\/(\d+)/);
    if(!m) continue;
    pairs.push({
      code:tv.code,
      episodeId:m[1],
      title:tv.title,
      youtubeId:yt.id,
      youtubeTitle:yt.title,
      tvdbFirstAired:tv.firstAired,
      youtubePublishDate:yt.publishDate,
      imageUrl:`https://i.ytimg.com/vi/${yt.id}/maxresdefault.jpg`
    });
  }
}

const uniq=[];const seen=new Set();
for(const p of pairs){if(!seen.has(p.code)){seen.add(p.code);uniq.push(p);}}
uniq.sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true}));

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_SQUEEZIE_MISSING_ARTWORK_PREFLIGHT',sourcePairs:uniq.length,checked:[],planned:[],blocked:[],result:'NOT_STARTED'};

const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g,'').replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const artUrls=html=>[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];
async function go(url){let r=null;for(let i=0;i<3;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return r;}await page.waitForTimeout(400*(i+1));}return r;}

try{
  for(const p of uniq){
    if(report.planned.length>=20) break;
    const row={...p};
    const r=await go(BASE+'/series/'+SLUG+'/episodes/'+p.episodeId);
    if(!r||r.status()>=400){row.status='TVDB_PAGE_BLOCKED';row.http=r?.status()??null;report.checked.push(row);continue;}
    const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
    const arts=artUrls(await page.content());
    row.heading=heading;row.currentArtwork=arts;
    if(norm(heading)!==norm(p.title)){row.status='TITLE_DRIFT';report.checked.push(row);continue;}
    if(arts.length){row.status='ALREADY_PRESENT_SKIP';report.checked.push(row);continue;}

    const q=await context.newPage();let dims={w:null,h:null},status=null;
    try{
      const rr=await q.goto(p.imageUrl,{waitUntil:'load',timeout:30000}).catch(()=>null);
      status=rr?.status()??null;
      if(status===200) dims=await q.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight})).catch(()=>({w:null,h:null}));
    }finally{await q.close();}
    row.imageStatus=status;row.width=dims.w;row.height=dims.h;
    if(status!==200||dims.w!==1280||dims.h!==720){row.status='NO_CLEAN_1280X720';report.checked.push(row);continue;}

    const upload=await go(BASE+'/artwork/upload?type=11&episode='+p.episodeId+'&series='+SERIES);
    if(!upload||upload.status()>=400){row.status='UPLOAD_FORM_BLOCKED';report.checked.push(row);continue;}
    const form=page.locator('form[action="/artwork/upload_handler"]').first();
    if(!(await form.count())){row.status='UPLOAD_FORM_MISSING';report.checked.push(row);continue;}
    const vals=await form.locator('input').evaluateAll(els=>Object.fromEntries(els.map(el=>[el.getAttribute('name'),el.value])));
    if(vals.episode!==p.episodeId||vals.series!==SERIES||vals.type!=='11'){row.status='UPLOAD_FORM_SCOPE_DRIFT';row.form=vals;report.checked.push(row);continue;}

    row.status='PREFLIGHT_PASSED';
    report.checked.push(row);
    report.planned.push({...p,width:1280,height:720,series:SERIES});
  }
  report.result=report.planned.length>=10?'PREFLIGHT_READY':'PREFLIGHT_INSUFFICIENT_CANDIDATES';
}catch(e){report.blocked.push({reason:String(e?.stack||e)});report.result='PREFLIGHT_ERROR';}
finally{await browser.close();}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'sourcePairs='+report.sourcePairs,
  'checked='+report.checked.length,
  'planned='+report.planned.length,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='PREFLIGHT_READY') process.exitCode=2;
