import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const BASE='https://thetvdb.com',SLUG='338282-show';
const ids=['10751340','10751341','10752394','10752395','10752396','10752397','10752398','10752399','10752404','10752405','10752406','10752407','10752676','10752677','11261473'];
await fs.mkdir('reports/mcfly-historical-readonly',{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR'});
const page=await context.newPage();
const out={generatedAt:new Date().toISOString(),target:'Mcfly & Carlito',mode:'READ_ONLY',ids:[],errors:[]};
async function go(url){let r;for(let i=0;i<3;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400)return r;await page.waitForTimeout(700*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}
for(const id of ids){try{await go(BASE+'/series/'+SLUG+'/episodes/'+id);const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();const h=await page.locator('h1,h2').allTextContents();const title=(h.map(x=>x.trim()).find(Boolean)||null);const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;const runtime=body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;out.ids.push({id,title,firstAired:aired,runtimeMinutes:runtime?Number(runtime):null,pageTitle:await page.title(),bodyPreview:body.slice(0,1800)});}catch(e){out.errors.push({id,error:String(e?.message||e)});}}
await browser.close();
await fs.writeFile('reports/mcfly-historical-readonly/report.json',JSON.stringify(out,null,2));
console.log('checked='+out.ids.length+' errors='+out.errors.length);
if(out.errors.length)process.exitCode=2;
