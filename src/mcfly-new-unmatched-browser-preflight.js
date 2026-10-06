import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const OUT='reports/mcfly-new-video-browser-preflight';
await fs.mkdir(OUT,{recursive:true});
const videoId='QG1WcEWOF4g';
const url='https://www.youtube.com/watch?v='+videoId;
const referenceDate='2026-09-09';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'fr-FR',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36'
});
const page=await context.newPage();
const resp=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
for(const selector of ['button:has-text("Tout accepter")','button:has-text("Accept all")','button:has-text("Tout refuser")','button:has-text("Reject all")']){
  const b=page.locator(selector).first();
  if(await b.isVisible().catch(()=>false)){await b.click().catch(()=>{});await page.waitForTimeout(1200);break;}
}
await page.waitForTimeout(2500);
const html=await page.content();
const body=(await page.locator('body').innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
const meta={};
for(const [k,sel,attr] of [
 ['datePublished','meta[itemprop="datePublished"]','content'],
 ['uploadDate','meta[itemprop="uploadDate"]','content'],
 ['duration','meta[itemprop="duration"]','content'],
 ['name','meta[itemprop="name"]','content'],
 ['channelId','meta[itemprop="channelId"]','content'],
 ['author','link[itemprop="name"]','content'],
 ['ogTitle','meta[property="og:title"]','content']
]){
 meta[k]=await page.locator(sel).first().getAttribute(attr).catch(()=>null);
}
function pick(re){const m=html.match(re);return m?.[1]??null;}
const title=meta.ogTitle||meta.name||pick(/"title":"([^"]+)"/);
const publishDate=meta.datePublished||pick(/"publishDate":"(\d{4}-\d{2}-\d{2})"/);
const uploadDate=meta.uploadDate||pick(/"uploadDate":"(\d{4}-\d{2}-\d{2})"/);
const channelId=meta.channelId||pick(/"channelId":"([^"]+)"/);
const author=meta.author||pick(/"ownerChannelName":"([^"]+)"/);
const report={
 generatedAt:new Date().toISOString(),mode:'READ_ONLY_BROWSER_PREFLIGHT',
 videoId,url,httpStatus:resp?.status()??null,pageTitle:await page.title(),
 title,publishDate,uploadDate,duration:meta.duration,channelId,author,
 referenceDate,
 inScope:publishDate?publishDate<=referenceDate:(uploadDate?uploadDate<=referenceDate:null),
 bodyPreview:body.slice(0,1800)
};
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
await browser.close();
if(!title) process.exitCode=2;
