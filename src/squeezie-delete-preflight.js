import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const cases=[
 {id:'6975388',duplicateOf:'2019E01',note:'Je vide mon sac! duplicate of assigned S2019E01'},
 {id:'10779950',duplicateOf:'2024E16',note:'Unknown duplicate of assigned S2024E16'},
 {id:'10779951',duplicateOf:'2024E16',note:'Unknown duplicate of assigned S2024E16'},
 {id:'10940462',duplicateOf:'2025E01',note:'Unknown duplicate of assigned S2025E01'},
 {id:'10940463',duplicateOf:'2025E01',note:'Unknown duplicate of assigned S2025E01'}
];
await fs.mkdir('reports/squeezie-deep',{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const page=await context.newPage();
await page.goto('https://thetvdb.com/auth/login',{waitUntil:'domcontentloaded'});
const form=page.locator('form').filter({has:page.locator('input[type=password]')}).first();
await form.locator('input[name=email]').fill(username);await form.locator('input[name=password]').fill(password);
await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.locator('button[type=submit],input[type=submit]').first().click()]);
await page.waitForTimeout(1200);
if(/\/auth\/login/.test(page.url())) throw new Error('Auth failed');
const result=[];
for(const c of cases){
 await page.goto('https://thetvdb.com/series/279758-show/episodes/'+c.id,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(300);
 const data=await page.evaluate(()=>{
   const forms=[...document.querySelectorAll('form')].map(f=>({
     action:f.action,method:f.method,
     text:(f.innerText||'').replace(/\s+/g,' ').trim().slice(0,500),
     fields:[...f.querySelectorAll('input,select,textarea,button')].map(el=>({
       tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),name:el.getAttribute('name'),id:el.id||null,
       value:el.getAttribute('value'),text:(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,100),
       options:el.tagName==='SELECT'?[...el.options].map(o=>({value:o.value,text:o.text})):undefined
     }))
   }));
   return {url:location.href,title:document.title,forms};
 });
 result.push({...c,...data});
}
await browser.close();
await fs.writeFile('reports/squeezie-deep/delete-preflight.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result.map(r=>({id:r.id,title:r.title,forms:r.forms})),null,2));
