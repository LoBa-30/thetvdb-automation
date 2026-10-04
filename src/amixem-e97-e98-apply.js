import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_AMIXEM_E97_E98_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='328213-show';
const X=[
 {id:'6102789',episode:97,oldTitle:"J'AI CRASHÉ MON NOUVEAU DRONE ! (Oui, encore...)",oldDate:'2016-12-17',newTitle:'JE JUGE LES YOUTUBERS !',newDate:'2016-12-17'},
 {id:'6102787',episode:98,oldTitle:'JE JUGE LES YOUTUBERS !',oldDate:'2016-12-17',newTitle:"J'AI CRASHÉ MON NOUVEAU DRONE ! (Oui, encore...)",newDate:'2016-12-18'}
];
if(!armed)throw new Error('Not armed'); if(!username||!password)throw new Error('Missing credentials');
await fs.mkdir('reports/amixem-e97-e98-apply',{recursive:true});
const report={generatedAt:new Date().toISOString(),authenticated:false,checks:[],writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage(); const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
async function go(u){let r;for(let i=1;i<=4;i++){r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return;}await page.waitForTimeout(i*700);}throw new Error('GET failed '+u+' '+(r?.status()??'n/a'));}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(700);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function row(ep){await go(BASE+'/series/'+SLUG+'/seasons/official/2016/edit');return await page.locator('input[name^="episodes["]').evaluateAll((ins,n)=>{for(const input of ins){if(Number(input.value)!==n)continue;const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]');const m=(a?.href||'').match(/\/episodes\/(\d+)/);return {number:Number(input.value),id:m?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim(),text:(c?.textContent||'').replace(/\s+/g,' ').trim()};}return null;},ep);}
async function tr(x){await go(BASE+'/series/'+SLUG+'/episodes/'+x.id+'/translate/fra/0/single');const f=page.locator('form').filter({has:page.locator('input[name="episode_name"]')}).first();if(!(await f.count()))throw new Error('Translation form missing '+x.id);return {f,title:await f.locator('input[name="episode_name"]').inputValue()};}
async function meta(x){await go(BASE+'/series/'+SLUG+'/episodes/'+x.id+'/0/edit');const f=page.locator('form').filter({has:page.locator('input[name="airdate"]')}).first();if(!(await f.count()))throw new Error('Metadata form missing '+x.id);const action=await f.getAttribute('action');return {f,path:new URL(action,BASE).pathname,date:await f.locator('input[name="airdate"]').inputValue()};}
async function submit(f,path){let bad=null;const h=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+u.pathname;await route.abort();return;}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;await route.abort();return;}await route.continue();};await context.route('**/*',h);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);await page.waitForTimeout(500);await context.unroute('**/*',h);return bad;}
try{
 report.authenticated=await login();if(!report.authenticated)throw new Error('Authenticated session not proven');
 // Global preflight first: no writes unless BOTH mappings, titles and dates still exactly match the proven snapshot (or are already final).
 const states=[];
 for(const x of X){const r=await row(x.episode),t=await tr(x),m=await meta(x);const s={x,row:r,title:t.title,date:m.date};states.push(s);report.checks.push({id:x.id,row:r,title:t.title,date:m.date});if(!r||r.id!==x.id||r.number!==x.episode)report.blocked.push({id:x.id,reason:'MAPPING_DRIFT',actual:r});if(![norm(x.oldTitle),norm(x.newTitle)].includes(norm(t.title)))report.blocked.push({id:x.id,reason:'TITLE_DRIFT',actual:t.title});if(![x.oldDate,x.newDate].includes(m.date))report.blocked.push({id:x.id,reason:'DATE_DRIFT',actual:m.date});}
 if(report.blocked.length)throw new Error('STOP_AFTER_GLOBAL_PREFLIGHT');
 for(const s of states){const x=s.x;
  if(norm(s.title)===norm(x.newTitle))report.skips.push({id:x.id,field:'title',reason:'ALREADY_CORRECT'});else{const t=await tr(x);await t.f.locator('input[name="episode_name"]').fill(x.newTitle);const bad=await submit(t.f,'/episodes/translatestore');if(bad){report.blocked.push({id:x.id,field:'title',reason:bad});continue;}const v=await tr(x);if(norm(v.title)!==norm(x.newTitle))report.blocked.push({id:x.id,field:'title',reason:'VERIFY_FAILED',actual:v.title});else{report.writes.push({id:x.id,field:'title',from:s.title,to:x.newTitle});report.verifications.push({id:x.id,field:'title',ok:true,value:v.title});}}
  const m=await meta(x);if(m.date===x.newDate)report.skips.push({id:x.id,field:'date',reason:'ALREADY_CORRECT'});else if(m.date!==x.oldDate)report.blocked.push({id:x.id,field:'date',reason:'DATE_DRIFT_AFTER_TITLE',actual:m.date});else{await m.f.locator('input[name="airdate"]').fill(x.newDate);const bad=await submit(m.f,m.path);if(bad){report.blocked.push({id:x.id,field:'date',reason:bad});continue;}const v=await meta(x);if(v.date!==x.newDate)report.blocked.push({id:x.id,field:'date',reason:'VERIFY_FAILED',actual:v.date});else{report.writes.push({id:x.id,field:'date',from:m.date,to:x.newDate});report.verifications.push({id:x.id,field:'date',ok:true,value:v.date});}}
 }
 report.result=report.blocked.length?'PARTIAL_REVIEW_REQUIRED':'APPLIED_AND_VERIFIED';
}catch(e){if(e?.message!=='STOP_AFTER_GLOBAL_PREFLIGHT')report.blocked.push({reason:e?.stack||String(e)});report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';}
finally{await browser.close();}
await fs.writeFile('reports/amixem-e97-e98-apply/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/amixem-e97-e98-apply/summary.txt',['authenticated='+report.authenticated,'writes='+report.writes.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'verifications='+report.verifications.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile('reports/amixem-e97-e98-apply/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
