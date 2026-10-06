import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MCFLY_MARADON_DATE_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='338282-show';
const X={id:'8189288',season:2020,episode:7,title:'LE MARADON : une journée en live pour les hôpitaux de France',oldDate:'2020-03-02',newDate:'2020-04-02'};
if(!armed)throw new Error('Not armed'); if(!username||!password)throw new Error('Missing credentials');
await fs.mkdir('reports/mcfly-maradon-date-apply',{recursive:true});
const report={generatedAt:new Date().toISOString(),authenticated:false,checks:[],writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage(); const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
async function go(u){let r;for(let i=1;i<=4;i++){r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return;}await page.waitForTimeout(i*700);}throw new Error('GET failed '+u+' '+(r?.status()??'n/a'));}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(700);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function row(){await go(BASE+'/series/'+SLUG+'/seasons/official/'+X.season+'/edit');return await page.locator('input[name^="episodes["]').evaluateAll((ins,n)=>{for(const input of ins){if(Number(input.value)!==n)continue;const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]');const m=(a?.href||'').match(/\/episodes\/(\d+)/);return {number:Number(input.value),id:m?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};}return null;},X.episode);}
async function meta(){await go(BASE+'/series/'+SLUG+'/episodes/'+X.id+'/0/edit');const f=page.locator('form').filter({has:page.locator('input[name="airdate"]')}).first();if(!(await f.count()))throw new Error('Metadata form missing '+X.id);const action=await f.getAttribute('action');return {f,path:new URL(action,BASE).pathname,date:await f.locator('input[name="airdate"]').inputValue()};}
async function submit(f,path){let bad=null;const h=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+u.pathname;await route.abort();return;}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;await route.abort();return;}await route.continue();};await context.route('**/*',h);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);await page.waitForTimeout(500);await context.unroute('**/*',h);return bad;}
try{
 report.authenticated=await login();if(!report.authenticated)throw new Error('Authenticated session not proven');
 const r=await row(),m=await meta();report.checks.push({row:r,date:m.date});
 if(!r||r.id!==X.id||r.number!==X.episode)report.blocked.push({reason:'MAPPING_DRIFT',actual:r});
 if(r&&norm(r.title)!==norm(X.title))report.blocked.push({reason:'TITLE_DRIFT',actual:r.title});
 if(![X.oldDate,X.newDate].includes(m.date))report.blocked.push({reason:'DATE_DRIFT',actual:m.date});
 if(report.blocked.length)throw new Error('STOP_AFTER_PREFLIGHT');
 if(m.date===X.newDate){report.skips.push({field:'date',reason:'ALREADY_CORRECT'});report.verifications.push({field:'date',ok:true,value:m.date});}
 else{await m.f.locator('input[name="airdate"]').fill(X.newDate);const bad=await submit(m.f,m.path);if(bad)report.blocked.push({field:'date',reason:bad});else{const v=await meta();if(v.date!==X.newDate)report.blocked.push({field:'date',reason:'VERIFY_FAILED',actual:v.date});else{report.writes.push({field:'date',from:m.date,to:X.newDate});report.verifications.push({field:'date',ok:true,value:v.date});}}}
 report.result=report.blocked.length?'REVIEW_REQUIRED':'APPLIED_AND_VERIFIED';
}catch(e){if(e?.message!=='STOP_AFTER_PREFLIGHT')report.blocked.push({reason:e?.stack||String(e)});report.result=report.writes.length?'REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';}
finally{await browser.close();}
await fs.writeFile('reports/mcfly-maradon-date-apply/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/mcfly-maradon-date-apply/summary.txt',['authenticated='+report.authenticated,'writes='+report.writes.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'verifications='+report.verifications.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile('reports/mcfly-maradon-date-apply/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
