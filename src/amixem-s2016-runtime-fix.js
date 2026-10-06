import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_AMIXEM_S2016_RUNTIME_FIX||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');
const BASE='https://thetvdb.com',SLUG='328213-show',OUT='reports/amixem-s2016-runtime-fix';
const PLAN=[
 {id:'6102789',episode:97,title:'JE JUGE LES YOUTUBERS !',date:'2016-12-17',from:11,to:13,youtubeId:'Tu0tDXPx_4k',duration:'12:41'},
 {id:'6102787',episode:98,title:"J'AI CRASHÉ MON NOUVEAU DRONE ! (Oui, encore...)",date:'2016-12-18',from:13,to:11,youtubeId:'Zja5z7C0c7g',duration:'10:48'}
];
await fs.mkdir(OUT,{recursive:true});
const canon=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
const report={generatedAt:new Date().toISOString(),target:'Amixem S2016E97-E98 runtimes',authenticated:false,preflight:[],writes:[],verifications:[],blocked:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(u){let r=null;for(let i=1;i<=4;i++){r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return;}await page.waitForTimeout(i*600);}throw new Error('GET '+u+' '+(r?.status()??'n/a'));}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(650);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function seasonMap(){await go(BASE+'/series/'+SLUG+'/seasons/official/2016/edit');const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]')||null;const href=a?.href||'';return {number:Number(input.value)||null,publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};}));return new Map(rows.filter(x=>x.publicId).map(x=>[x.publicId,x]));}
async function meta(id){await go(BASE+'/series/'+SLUG+'/episodes/'+id+'/0/edit');const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();if(!(await f.count()))throw new Error('Metadata form missing '+id);const action=await f.getAttribute('action');const path=new URL(action,BASE).pathname;if(!path.includes('/series/'+SLUG+'/season/official/episodes/'+id+'/update'))throw new Error('Unexpected action '+path);return {f,path,airdate:await f.locator('input[name="airdate"]').first().inputValue(),runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())};}
async function submit(form,path){let bad=null;const h=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE';return route.abort();}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}return route.continue();};await context.route('**/*',h);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);await page.waitForTimeout(500);await context.unroute('**/*',h);if(bad)throw new Error(bad);}
try{
 report.authenticated=await login();if(!report.authenticated)throw new Error('Authenticated session not proven');
 const sm=await seasonMap();
 for(const x of PLAN){const row=sm.get(x.id);const m=await meta(x.id);report.preflight.push({id:x.id,episode:x.episode,row,airdate:m.airdate,runtime:m.runtime,youtubeId:x.youtubeId,duration:x.duration});if(!row||row.number!==x.episode||canon(row.title)!==canon(x.title))throw new Error('MAPPING_DRIFT '+x.id);if(m.airdate!==x.date)throw new Error('DATE_DRIFT '+x.id+' '+m.airdate);if(![x.from,x.to].includes(m.runtime))throw new Error('RUNTIME_DRIFT '+x.id+' '+m.runtime);}
 for(const x of PLAN){const m=await meta(x.id);if(m.runtime!==x.to){await m.f.locator('input[name="runtime"]').fill(String(x.to));await submit(m.f,m.path);report.writes.push({id:x.id,episode:x.episode,from:m.runtime,to:x.to,youtubeId:x.youtubeId,duration:x.duration});}const v=await meta(x.id);const ok=v.runtime===x.to&&v.airdate===x.date;report.verifications.push({id:x.id,episode:x.episode,runtime:v.runtime,airdate:v.airdate,ok});if(!ok)throw new Error('VERIFY_FAILED '+x.id);}
 report.result='APPLIED_AND_VERIFIED';
}catch(e){report.blocked.push({reason:String(e?.stack||e)});report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'writes='+report.writes.length,'blocked='+report.blocked.length,'result='+report.result].join('\n')+'\n');console.log(await fs.readFile(OUT+'/summary.txt','utf8'));if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
