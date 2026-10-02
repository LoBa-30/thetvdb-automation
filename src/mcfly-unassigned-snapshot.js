import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const BASE='https://thetvdb.com',SLUG='338282-show';
if(!username||!password)throw new Error('Missing credentials');
await fs.mkdir('reports/mcfly-unassigned',{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const p=await context.newPage();
async function go(u){const r=await p.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await p.waitForTimeout(700);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));}
await go(BASE+'/auth/login');
const f=p.locator('form').filter({has:p.locator('input[name="password"]')}).first();
await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);
await Promise.all([p.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
await p.waitForTimeout(500);
const probe=await context.request.get(BASE+'/auth/getuser');if(!probe.ok())throw new Error('Auth not proven');
await go(BASE+'/series/'+SLUG+'/seasons/official/unassigned/edit');
const tableRows=await p.locator('tr').evaluateAll(trs=>trs.map((tr,index)=>({
 index,
 text:(tr.textContent||'').replace(/\s+/g,' ').trim(),
 links:[...tr.querySelectorAll('a')].map(a=>({text:(a.textContent||'').replace(/\s+/g,' ').trim(),href:a.href})),
 selects:[...tr.querySelectorAll('select')].map(s=>({name:s.name,value:s.value,options:[...s.options].map(o=>({value:o.value,text:(o.textContent||'').trim(),selected:o.selected}))})),
 inputs:[...tr.querySelectorAll('input')].map(i=>({name:i.name,type:i.type,value:i.value}))
})).filter(r=>r.text));
const episodeRows=tableRows.filter(r=>r.links.some(a=>/\/episodes\/\d+/.test(a.href)));
const parsed=episodeRows.map(r=>{
 const a=r.links.find(a=>/\/episodes\/\d+/.test(a.href));
 const publicId=(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null;
 const date=(r.text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)||r.text.match(/\b(\d{4}-\d{2}-\d{2})\b/))?.[1]||null;
 return {publicId,title:a?.text||null,date,rowText:r.text,links:r.links,selects:r.selects,inputs:r.inputs};
});
const report={generatedAt:new Date().toISOString(),authenticated:true,url:p.url(),count:parsed.length,rows:parsed,allTableRows:tableRows};
await fs.writeFile('reports/mcfly-unassigned/unassigned.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/mcfly-unassigned/summary.txt',`count=${parsed.length}\n`+parsed.map(x=>`${x.publicId||''} | ${x.date||''} | ${x.title||x.rowText}`).join('\n')+'\n');
console.log(await fs.readFile('reports/mcfly-unassigned/summary.txt','utf8'));
await browser.close();