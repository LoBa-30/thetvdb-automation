import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const VIDEO_ID='OjWGpzy6u6o';
const OUT='reports/maxime-s2024e05-runtime-preflight';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36'});
const page=await context.newPage();
let report={generatedAt:new Date().toISOString(),target:'Maxime Biaggi S2024E05',mode:'READ_ONLY'};

await page.goto('https://www.youtube.com/c/MaximeBiaggi/videos',{waitUntil:'domcontentloaded',timeout:60000});
for(const sel of ['button:has-text("Tout accepter")','button:has-text("Accept all")','button:has-text("Tout refuser")','button:has-text("Reject all")']){const b=page.locator(sel).first();if(await b.isVisible().catch(()=>false)){await b.click().catch(()=>{});await page.waitForTimeout(1000);break;}}
let found=null;
for(let i=0;i<120&&!found;i++){
  found=await page.locator('a[href*="watch?v='+VIDEO_ID+'"]') .first().evaluate(a=>{
    const card=a.closest('ytd-rich-item-renderer,ytd-grid-video-renderer')||a.parentElement?.parentElement?.parentElement;
    const title=(a.getAttribute('title')||a.textContent||'').replace(/\s+/g,' ').trim();
    const text=(card?.innerText||'').replace(/\s+/g,' ').trim();
    const m=text.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/);
    return {title,cardText:text,durationText:m?.[1]||null};
  }).catch(()=>null);
  if(!found){await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(500);}
}
report.youtube={videoId:VIDEO_ID,...(found||{}),found:Boolean(found)};

const tv=await context.newPage();
await tv.goto('https://thetvdb.com/series/maxime-biaggi/seasons/official/2024',{waitUntil:'domcontentloaded',timeout:60000});
await tv.waitForTimeout(800);
const row=await tv.locator('a[href*="/series/maxime-biaggi/episodes/"]').filter({hasText:'ON A FAIT BERCY'}).first().evaluate(a=>{
 const c=a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement;
 return {href:a.href,rowText:(c?.innerText||c?.textContent||'').replace(/\s+/g,' ').trim()};
}).catch(()=>null);
if(row){await tv.goto(row.href,{waitUntil:'domcontentloaded',timeout:60000});await tv.waitForTimeout(300);const body=(await tv.locator('body').innerText()).replace(/\s+/g,' ').trim();report.tvdb={episodeUrl:row.href,rowText:row.rowText,runtimeMinutes:Number(body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||0)||null,firstAired:body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CREATED)/i)?.[1]||null,title:(await tv.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null};}
function sec(s){if(!s)return null;const p=s.split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+p[1];}
const seconds=sec(report.youtube.durationText);
report.expectedRoundedMinutes=seconds==null?null:Math.floor(seconds/60+0.5);
report.runtimeExact=report.expectedRoundedMinutes!=null&&report.tvdb?.runtimeMinutes!=null?report.expectedRoundedMinutes===report.tvdb.runtimeMinutes:null;
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
await browser.close();
if(!report.youtube.found) process.exitCode=2;