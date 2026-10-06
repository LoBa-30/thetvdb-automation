
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password)throw new Error('Missing credentials');
const BASE='https://thetvdb.com',EP='11092249',OUT='reports/elian-artwork-form-inspection';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_STRICT_READ_ONLY_FORM_INSPECTION',episodeId:EP,authenticated:false,links:[],forms:[],blocked:[],errors:[]};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(350);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(650);const probe=await context.request.get(BASE+'/auth/getuser');report.authenticated=probe.ok();if(!report.authenticated)throw new Error('Auth not proven');
 await context.route('**/*',async route=>{const q=route.request(),m=q.method().toUpperCase();if(/thetvdb\.com/i.test(q.url())&&!['GET','HEAD','OPTIONS'].includes(m)){report.blocked.push({method:m,url:q.url()});return route.abort();}return route.continue();});
 await go(BASE+'/series/elian-ventre-462729/episodes/'+EP);
 report.links=await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.textContent||'').replace(/\s+/g,' ').trim(),href:a.href||''})).filter(x=>/artwork/i.test(x.text)||/artwork/i.test(x.href)));
 const add=report.links.find(x=>/add artwork/i.test(x.text))||report.links.find(x=>/artwork.*add|add.*artwork/i.test(x.href))||null;
 if(!add)throw new Error('Add Artwork link not found');
 await go(add.href);
 report.pageUrl=page.url();report.pageTitle=await page.title();
 report.forms=await page.locator('form').evaluateAll(fs=>fs.map(f=>({
   action:f.action,method:f.method,
   inputs:[...f.querySelectorAll('input,select,textarea')].map(el=>({
     tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),name:el.getAttribute('name'),
     value:el.getAttribute('value'),accept:el.getAttribute('accept'),
     required:el.hasAttribute('required'),
     options:el.tagName==='SELECT'?[...el.querySelectorAll('option')].map(o=>({value:o.value,text:(o.textContent||'').trim(),selected:o.selected})):undefined
   }))
 })));
}catch(e){report.errors.push(String(e?.stack||e));}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.errors.length)process.exitCode=2;
