import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_E08_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='elian-ventre-462729';
const X={id:'12014528',season:2026,episode:8,
 oldTitle:"On s'affronte pour construire la meilleure cabane ! ft. Maxime Biaggi",
 newTitle:"Nos cabanes vont-elles résister au Loup ?! (ft. Maxime Biaggi)",
 newRuntime:34
};
if(!armed) throw new Error('Not armed');
if(!username||!password) throw new Error('Missing credentials');
await fs.mkdir('reports/elian-e08-apply',{recursive:true});
const report={generatedAt:new Date().toISOString(),authenticated:false,checks:[],writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
async function go(url){let r=null;for(let i=1;i<=4;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return;}await page.waitForTimeout(i*700);}throw new Error('GET failed '+url+' '+(r?.status()??'n/a'));}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(700);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function row(){await go(BASE+'/series/'+SLUG+'/seasons/official/2026/edit');return await page.locator('input[name^="episodes["]').evaluateAll((ins,ep)=>{for(const input of ins){if(Number(input.value)!==ep)continue;const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]');if(!a)continue;const m=(a.href||'').match(/\/episodes\/(\d+)/);return {number:Number(input.value)||null,title:(a.textContent||'').replace(/\s+/g,' ').trim(),id:m?m[1]:null};}return null;},8);}
async function translation(){await go(BASE+'/series/'+SLUG+'/episodes/'+X.id+'/translate/fra/0/single');const f=page.locator('form').filter({has:page.locator('input[name="episode_name"]')}).first();if(!(await f.count()))throw new Error('Translation form missing');return {f,title:await f.locator('input[name="episode_name"]').inputValue()};}
async function meta(){await go(BASE+'/series/'+SLUG+'/episodes/'+X.id+'/0/edit');const f=page.locator('form').filter({has:page.locator('input[name="runtime"]')}).first();if(!(await f.count()))throw new Error('Metadata form missing');const action=await f.getAttribute('action');return {f,actionUrl:new URL(action,BASE).href,runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())};}
async function guardedSubmit(f,allowedPath){let unexpected=null;const handler=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){unexpected='DESTRUCTIVE '+u.pathname;await route.abort();return;}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==allowedPath){unexpected='UNEXPECTED_POST '+u.pathname;await route.abort();return;}await route.continue();};await context.route('**/*',handler);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);await page.waitForTimeout(500);await context.unroute('**/*',handler);return unexpected;}

try{
 report.authenticated=await login(); if(!report.authenticated)throw new Error('Authenticated session not proven');
 const rr=await row(); report.checks.push({row:rr});
 if(!rr||rr.id!==X.id||rr.number!==8){report.blocked.push({reason:'MAPPING_DRIFT',actual:rr});throw new Error('STOP_AFTER_MAPPING_DRIFT');}

 const tr=await translation(); report.checks.push({currentTitle:tr.title});
 if(norm(tr.title)===norm(X.newTitle)){report.skips.push({field:'title',reason:'ALREADY_CORRECT'});}
 else if(norm(tr.title)!==norm(X.oldTitle)){report.blocked.push({field:'title',reason:'TITLE_DRIFT',actual:tr.title});}
 else{
   await tr.f.locator('input[name="episode_name"]').fill(X.newTitle);
   const bad=await guardedSubmit(tr.f,'/episodes/translatestore');
   if(bad)report.blocked.push({field:'title',reason:bad});
   else{
     const v=await translation();
     if(norm(v.title)!==norm(X.newTitle))report.blocked.push({field:'title',reason:'VERIFY_FAILED',actual:v.title});
     else{report.writes.push({field:'title',from:tr.title,to:X.newTitle});report.verifications.push({field:'title',ok:true,value:v.title});}
   }
 }

 const m=await meta(); report.checks.push({currentRuntime:m.runtime});
 if(m.runtime===X.newRuntime){report.skips.push({field:'runtime',reason:'ALREADY_CORRECT'});}
 else if(!(m.runtime===0||Number.isNaN(m.runtime))){report.blocked.push({field:'runtime',reason:'RUNTIME_DRIFT',actual:m.runtime});}
 else{
   await m.f.locator('input[name="runtime"]').fill(String(X.newRuntime));
   const bad=await guardedSubmit(m.f,new URL(m.actionUrl).pathname);
   if(bad)report.blocked.push({field:'runtime',reason:bad});
   else{
     const v=await meta();
     if(v.runtime!==X.newRuntime)report.blocked.push({field:'runtime',reason:'VERIFY_FAILED',actual:v.runtime});
     else{report.writes.push({field:'runtime',from:m.runtime,to:X.newRuntime});report.verifications.push({field:'runtime',ok:true,value:v.runtime});}
   }
 }
 report.result=report.blocked.length?'APPLIED_WITH_BLOCKED_DRIFT':'APPLIED_AND_VERIFIED';
}catch(e){
 if(String(e?.message)!=='STOP_AFTER_MAPPING_DRIFT')report.blocked.push({reason:e?.stack||String(e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile('reports/elian-e08-apply/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/elian-e08-apply/summary.txt',['authenticated='+report.authenticated,'writes='+report.writes.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'verifications='+report.verifications.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile('reports/elian-e08-apply/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','APPLIED_WITH_BLOCKED_DRIFT'].includes(report.result))process.exitCode=2;
