import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const BASE='https://thetvdb.com';
if(!username||!password) throw new Error('Missing credentials');
await fs.mkdir('reports/mcfly-artwork-form-preflight',{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(500);return {status:r?.status(),url:page.url(),title:await page.title()};}
await go(BASE+'/auth/login');
const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
await page.waitForTimeout(800);
const probe=await context.request.get(BASE+'/auth/getuser');if(!probe.ok())throw new Error('Auth not proven');
const targets=[
 {label:'missing',episode:'11595720',url:BASE+'/artwork/upload?type=11&episode=11595720&series=338282'},
 {label:'existing',episode:'11740123',url:BASE+'/artwork/upload?type=11&episode=11740123&series=338282'}
];
const out={generatedAt:new Date().toISOString(),authenticated:true,targets:[]};
for(const t of targets){
 const meta=await go(t.url);
 const forms=await page.locator('form').evaluateAll(fs=>fs.map(f=>({
   action:f.getAttribute('action'),method:f.getAttribute('method'),
   enctype:f.getAttribute('enctype'),
   inputs:[...f.querySelectorAll('input,select,textarea,button')].map(n=>({
     tag:n.tagName.toLowerCase(),type:n.getAttribute('type'),name:n.getAttribute('name'),
     value:n.value??n.getAttribute('value'),text:(n.textContent||'').replace(/\s+/g,' ').trim(),
     accept:n.getAttribute('accept'),required:!!n.required
   })).filter(x=>x.name||x.type==='submit'||x.tag==='button')
 })));
 const body=(await page.locator('body').innerText().catch(()=>'' )).replace(/\s+/g,' ').trim().slice(0,3000);
 out.targets.push({...t,...meta,forms,bodyPreview:body});
}
await fs.writeFile('reports/mcfly-artwork-form-preflight/report.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
await browser.close();