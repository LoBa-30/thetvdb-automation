
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const OUT='reports/elian-artwork-inventory';
await fs.mkdir(OUT,{recursive:true});
const YT='https://www.youtube.com/@elianventre/videos';
const TVDB='https://thetvdb.com', SLUG='elian-ventre-462729';

const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),target:'Elian Ventre',mode:'READ_ONLY_ARTWORK_INVENTORY',youtube:[],tvdb:[],matches:[],errors:[]};
async function go(p,u){let r=null;for(let i=0;i<3;i++){r=await p.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await p.waitForTimeout(300);return r;}await p.waitForTimeout(500*(i+1));}throw new Error('GET '+u+' '+(r?.status()??'n/a'));}

try{
  await go(page,YT);
  for(const sel of ['button:has-text("Tout accepter")','button:has-text("Accept all")','button:has-text("Tout refuser")','button:has-text("Reject all")']){const b=page.locator(sel).first();if(await b.isVisible().catch(()=>false)){await b.click().catch(()=>{});await page.waitForTimeout(700);break;}}
  let prev=0,stable=0;
  for(let i=0;i<80&&stable<8;i++){const c=await page.locator('a[href*="/watch?v="]').count();stable=c===prev?stable+1:0;prev=c;await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(500);}
  report.youtube=await page.locator('a[href*="/watch?v="]').evaluateAll(as=>{
    const m=new Map();
    for(const a of as){
      const h=a.getAttribute('href')||'';if(!h.includes('/watch?v='))continue;
      const id=new URL('https://www.youtube.com'+h).searchParams.get('v');if(!id)continue;
      const card=a.closest('ytd-rich-item-renderer,ytd-grid-video-renderer,ytd-rich-grid-media')||a.parentElement?.parentElement?.parentElement;
      const labels=[...(card?.querySelectorAll('a[href*="/watch?v="]')||[])].flatMap(n=>[n.getAttribute('title')||'',n.textContent||'']).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean).filter(x=>!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(x));
      const title=labels.sort((x,y)=>y.length-x.length)[0]||'';
      if(!title)continue;
      const img=card?.querySelector('img');
      const thumb=img?.getAttribute('src')||img?.getAttribute('data-thumb')||null;
      const old=m.get(id);const row={id,title,url:'https://www.youtube.com/watch?v='+id,thumbnail:thumb||('https://i.ytimg.com/vi/'+id+'/maxresdefault.jpg')};
      if(!old||row.title.length>old.title.length)m.set(id,row);
    }
    return [...m.values()];
  });
}catch(e){report.errors.push({scope:'youtube',error:String(e?.message||e)});}

try{
  for(const season of [2023,2024,2025,2026]){
    await go(page,TVDB+'/series/'+SLUG+'/seasons/official/'+season);
    const eps=await page.locator('a[href*="/series/'+SLUG+'/episodes/"]').evaluateAll(as=>{
      const m=new Map();
      for(const a of as){
        const mm=(a.href||'').match(/\/episodes\/(\d+)/);if(!mm)continue;
        const card=a.closest('tr')||a.closest('.row')||a.closest('.list-group-item')||a.parentElement?.parentElement||a.parentElement;
        const text=(card?.innerText||card?.textContent||'').replace(/\s+/g,' ').trim();
        const code=text.match(/S(\d{4})E(\d+)/i);
        const title=(a.textContent||'').replace(/\s+/g,' ').trim();
        if(!code||!title)continue;
        m.set(mm[1],{id:mm[1],season:Number(code[1]),episode:Number(code[2]),code:'S'+code[1]+'E'+String(Number(code[2])).padStart(2,'0'),title,url:a.href});
      }
      return [...m.values()];
    });
    for(const e of eps){
      const p=await context.newPage();
      try{
        await go(p,e.url);
        const html=await p.content();
        const urls=[...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));
        const hasAddArtwork=(await p.locator('text=Add Artwork').count().catch(()=>0))>0;
        report.tvdb.push({...e,artwork:urls[0]||null,hasArtwork:urls.length>0,addArtworkVisible:hasAddArtwork});
      }catch(err){report.errors.push({scope:'tvdb_episode',id:e.id,error:String(err?.message||err)});}
      finally{await p.close();}
    }
  }
}catch(e){report.errors.push({scope:'tvdb',error:String(e?.message||e)});}

const used=new Set();
for(const e of report.tvdb.sort((a,b)=>a.season-b.season||a.episode-b.episode)){
  const ne=norm(e.title);let best=null,bestScore=-1;
  for(const y of report.youtube){
    if(used.has(y.id))continue;
    const ny=norm(y.title);
    let score=ne===ny?1:0;
    if(!score){
      const A=new Set(ne.split(' ').filter(Boolean)),B=new Set(ny.split(' ').filter(Boolean));let inter=0;for(const w of A)if(B.has(w))inter++;
      score=inter/Math.max(A.size,B.size);
    }
    if(score>bestScore){bestScore=score;best=y;}
  }
  if(best&&bestScore>=0.70)used.add(best.id);else best=null;
  report.matches.push({
    code:e.code,episodeId:e.id,tvdbTitle:e.title,tvdbArtwork:e.artwork,hasArtwork:e.hasArtwork,
    youtubeId:best?.id||null,youtubeTitle:best?.title||null,youtubeUrl:best?.url||null,
    officialThumbnail:best?.thumbnail||null,similarity:Number(bestScore.toFixed(3)),
    exactProvenanceCandidate:Boolean(best&&bestScore>=0.90)
  });
}
report.summary={
  youtubeCount:report.youtube.length,
  tvdbCount:report.tvdb.length,
  matched:report.matches.filter(x=>x.youtubeId).length,
  missingArtwork:report.matches.filter(x=>!x.hasArtwork).length,
  existingArtwork:report.matches.filter(x=>x.hasArtwork).length,
  exactThumbnailCandidatesForMissing:report.matches.filter(x=>!x.hasArtwork&&x.exactProvenanceCandidate).length,
  errors:report.errors.length
};
await browser.close();
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',Object.entries(report.summary).map(([k,v])=>k+'='+v).join('\n')+'\n');
console.log(JSON.stringify(report.summary,null,2));
if(report.errors.length)process.exitCode=2;
