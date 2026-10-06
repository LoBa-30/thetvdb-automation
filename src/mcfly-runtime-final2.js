import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MCFLY_RUNTIME_FINAL2_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='338282-show',OUT='reports/mcfly-runtime-final2';
const PLAN=[
 {id:'11261488',code:'S2025E54',season:2025,episode:54,title:'MÉLI-MÉLO 4 (tout simplement)',date:'2025-07-27',from:99,to:109,youtubeId:'LvPzscrOVdc',duration:'1:48:51'},
 {id:'9915826',code:'S2023E06',season:2023,episode:6,title:'La maison est incroyable ! Fin de l’aventure Bizeneuille',date:'2023-07-30',from:64,to:65,youtubeId:'FmHZ3o6bdUM',duration:'1:04:32'}
];
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),target:'Mcfly & Carlito final two runtimes',authenticated:false,preflight:[],writes:[],skips:[],verifications:[],blocked:[],result:'NOT_STARTED'};
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(u){let r=null;for(let i=1;i<=4;i++){r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return r;}await page.waitForTimeout(i*600);}throw new Error('GET failed '+u);}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(650);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function seasonRow(x){await go(`${BASE}/series/${SLUG}/seasons/official/${x.season}/edit`);const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]')||null;const href=a?.href||'';return {number:Number(input.value)||null,publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};}));return rows.find(r=>r.publicId===x.id)||null;}
async function meta(x){await go(`${BASE}/series/${SLUG}/episodes/${x.id}/0/edit`);const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();if(!(await f.count()))throw new Error('Metadata form missing '+x.code);const action=await f.getAttribute('action');const path=new URL(action,BASE).pathname;if(!path.includes(`/series/${SLUG}/season/official/episodes/${x.id}/update`))throw new Error('Unexpected action '+path);return {f,path,date:await f.locator('input[name="airdate"]').first().inputValue(),runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())};}
async function submit(form,path){let bad=null;const h=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete/.test(u.pathname)){bad='DESTRUCTIVE';return route.abort();}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}return route.continue();};await context.route('**/*',h);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);await page.waitForTimeout(500);await context.unroute('**/*',h);if(bad)throw new Error(bad);}

try{
 report.authenticated=await login();if(!report.authenticated)throw new Error('Auth not proven');
 for(const x of PLAN){const row=await seasonRow(x);const m=await meta(x);const ok=row&&row.number===x.episode&&norm(row.title)===norm(x.title)&&m.date===x.date&&[x.from,x.to].includes(m.runtime);report.preflight.push({code:x.code,row,airdate:m.date,runtime:m.runtime,ok});if(!ok)throw new Error('PREFLIGHT_DRIFT '+x.code+' '+JSON.stringify({row,date:m.date,runtime:m.runtime}));}
 for(const x of PLAN){const m=await meta(x);if(m.runtime===x.to)report.skips.push({code:x.code,reason:'ALREADY_CORRECT'});else{await m.f.locator('input[name="runtime"]').fill(String(x.to));await submit(m.f,m.path);report.writes.push({code:x.code,id:x.id,from:x.from,to:x.to,youtubeId:x.youtubeId,duration:x.duration});}}
 for(const x of PLAN){const v=await meta(x);const ok=v.runtime===x.to&&v.date===x.date;report.verifications.push({code:x.code,runtime:v.runtime,airdate:v.date,ok});if(!ok)throw new Error('VERIFY_FAILED '+x.code);}
 report.result='APPLIED_AND_VERIFIED';
}catch(e){report.blocked.push({reason:String(e?.stack||e)});report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'writes='+report.writes.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'verifications='+report.verifications.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
