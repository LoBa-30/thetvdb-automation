import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const src=JSON.parse(await fs.readFile('reports/squeezie-current-structural/report.json','utf8'));
const items=src.tvdbWithoutCurrentPublicYoutubeMatch||[];
const OUT='reports/squeezie-historical-tvdb-details';
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),target:'Squeezie',mode:'READ_ONLY_TVDB_HISTORICAL_DETAIL',expected:items.length,found:0,errors:[],episodes:[]};

async function go(url){let r;for(let i=0;i<3;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(150);return r;}await page.waitForTimeout(500*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}

for(const item of items){
  const search='https://thetvdb.com/series/279758-show/seasons/official/'+item.season;
  try{
    await go(search);
    const links=await page.locator('a[href*="/series/279758-show/episodes/"]').evaluateAll(as=>as.map(a=>({href:a.href,text:(a.textContent||'').replace(/\s+/g,' ').trim()})));
    const candidate=links.find(x=>x.text.includes(item.title))||null;
    if(!candidate){report.errors.push({code:item.code,error:'detail link not found from season page'});continue;}
    await go(candidate.href);
    const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
    const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
    const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
    const runtime=body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;
    const created=body.match(/CREATED\s+(.+?)(?=\s+by\s+)/i)?.[1]||null;
    const modified=body.match(/MODIFIED\s+(.+?)(?=\s+by\s+|\s+ABOUT)/i)?.[1]||null;
    report.episodes.push({...item,detailUrl:candidate.href,heading,firstAiredDetail:aired,runtimeMinutes:runtime?Number(runtime):null,createdText:created,modifiedText:modified,bodyPreview:body.slice(0,2600)});
    report.found++;
  }catch(e){report.errors.push({code:item.code,error:String(e?.message||e)});}
}
await browser.close();
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',['Squeezie historical TVDB details','Expected: '+report.expected,'Found: '+report.found,'Errors: '+report.errors.length].join('\n')+'\n');
console.log('expected='+report.expected+' found='+report.found+' errors='+report.errors.length);
if(report.errors.length) process.exitCode=2;