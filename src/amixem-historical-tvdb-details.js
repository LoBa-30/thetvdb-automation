import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const src=JSON.parse(await fs.readFile('reports/amixem-final/audit.json','utf8'));
const items=src.tvdb_historical_without_current_public_youtube||[];
const OUT='reports/amixem-historical-tvdb-details';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),target:'Amixem',mode:'READ_ONLY_TVDB_HISTORICAL_DETAIL',expected:items.length,found:0,errors:[],episodes:[]};
async function go(url){let r;for(let i=0;i<3;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(120);return r;}await page.waitForTimeout(400*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}
for(const item of items){
 try{
  await go(item.episode_url);
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
  const runtime=body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;
  const network=body.match(/NETWORK\s+(.+?)(?=\s+ON OTHER SITES|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
  const created=body.match(/CREATED\s+(.+?)(?=\s+by\s+)/i)?.[1]||null;
  const modified=body.match(/MODIFIED\s+(.+?)(?=\s+by\s+|\s+ABOUT)/i)?.[1]||null;
  report.episodes.push({...item,heading,firstAiredDetail:aired,runtimeDetail:runtime?Number(runtime):null,network,createdText:created,modifiedText:modified,bodyPreview:body.slice(0,2600)});
  report.found++;
 }catch(e){report.errors.push({code:item.code,id:item.episode_id,error:String(e?.message||e)});}
}
await browser.close();
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',['Amixem historical TVDB details','Expected: '+report.expected,'Found: '+report.found,'Errors: '+report.errors.length].join('\n')+'\n');
console.log('expected='+report.expected+' found='+report.found+' errors='+report.errors.length);
if(report.errors.length) process.exitCode=2;