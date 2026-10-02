import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME, password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');
await fs.mkdir('reports/squeezie-deep',{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
await page.goto('https://thetvdb.com/auth/login',{waitUntil:'domcontentloaded',timeout:60000});
const form=page.locator('form').filter({has:page.locator('input[type="password"]')}).first();
await form.locator('input[name="email"]').fill(username);
await form.locator('input[name="password"]').fill(password);
await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.locator('button[type="submit"],input[type="submit"]').first().click()]);
await page.waitForTimeout(1500);
if(/\/auth\/login/.test(page.url())) throw new Error('Authentication failed');

const url='https://thetvdb.com/series/279758-show/seasons/official/unassigned/edit';
await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(800);
const data=await page.evaluate(()=>{
 const body=(document.body.innerText||'').replace(/\r/g,'');
 const links=[...document.querySelectorAll('a[href*="/episodes/"]')].map(a=>({
   href:a.href,text:(a.textContent||'').replace(/\s+/g,' ').trim()
 }));
 const unique=[]; const seen=new Set();
 for(const x of links){const m=x.href.match(/\/episodes\/(\d+)/);if(!m||seen.has(m[1]))continue;seen.add(m[1]);unique.push({...x,id:m[1]});}
 return {url:location.href,title:document.title,body,episodeLinks:unique};
});
const episodes=[];
for(const item of data.episodeLinks){
 await page.goto(item.href,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(250);
 const ep=await page.evaluate(()=>{
   const body=(document.body.innerText||'').replace(/\s+/g,' ').trim();
   const img=[...document.querySelectorAll('img')].map(i=>i.src).find(u=>/artworks\.thetvdb\.com\/banners\/v4\/episode\//.test(u))||null;
   const heading=(document.querySelector('h1,h2,h3')?.textContent||document.title||'').replace(/\s+/g,' ').trim();
   const aired=body.match(/Originally Aired\s+([A-Z][a-z]+ \d{1,2}, \d{4})/i)?.[1]||null;
   const runtime=body.match(/Runtime\s+(\d+) minutes/i)?.[1]||null;
   const seasonEpisode=body.match(/Season ([^ ]+)\s*\/\s*Episode ([^ ]+)/i);
   return {pageUrl:location.href,pageTitle:document.title,heading,firstAired:aired,runtimeMinutes:runtime?Number(runtime):null,
     season:seasonEpisode?.[1]||null,episode:seasonEpisode?.[2]||null,imageUrl:img,bodyPreview:body.slice(0,1200)};
 });
 episodes.push({id:item.id,linkText:item.text,...ep});
}
await browser.close();
const out={generatedAt:new Date().toISOString(),listing:data,episodes};
await fs.writeFile('reports/squeezie-deep/unassigned.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(episodes,null,2));
