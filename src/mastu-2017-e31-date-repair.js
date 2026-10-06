import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MASTU_2017_E31_DATE_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='346011-show',ID='9195816';
const TITLE='PROVOQUER UNE ÉMEUTE DE VACHES EN VOITURE';
const FROM='2017-05-25',TO='2017-05-27';
const OUT='reports/mastu-2017-e31-date-repair';
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),target:'Mastu S2017E31 date',youtubeId:'XT-M3Z-wnVE',mode:'GUARDED_DATE_REPAIR',authenticated:false,preflight:null,writes:[],verifications:[],blocked:[],result:'NOT_STARTED'};
const canon=s=>String(s||'').normalize('NFC').replace(/\s+/g,' ').trim();

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(u){
 let r=null;
 for(let i=1;i<=4;i++){
  r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(r&&r.status()<400){await page.waitForTimeout(350);return r;}
  await page.waitForTimeout(i*700);
 }
 throw new Error('GET failed '+u+' '+(r?.status()??'n/a'));
}
async function login(){
 await go(BASE+'/auth/login');
 const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await f.locator('input[name="email"]').fill(username);
 await f.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
 return Boolean(p?.ok());
}
async function seasonRow(){
 await go(`${BASE}/series/${SLUG}/seasons/official/2017/edit`);
 const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]')||null;
   const href=a?.href||'';
   return {number:Number(input.value)||null,publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
 return rows.find(x=>x.publicId===ID)||null;
}
async function meta(){
 await go(`${BASE}/series/${SLUG}/episodes/${ID}/0/edit`);
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"]')}).first();
 if(!(await f.count())) throw new Error('Metadata form missing');
 const action=await f.getAttribute('action');
 const path=new URL(action,BASE).pathname;
 if(!path.includes(`/series/${SLUG}/season/official/episodes/${ID}/update`)) throw new Error('Unexpected form action '+path);
 return {f,path,date:await f.locator('input[name="airdate"]').inputValue()};
}
async function guardedSubmit(form,path){
 let bad=null;
 const h=async route=>{
  const req=route.request(),u=new URL(req.url());
  if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();}
  if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
  return route.continue();
 };
 await context.route('**/*',h);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(600);
 await context.unroute('**/*',h);
 if(bad) throw new Error(bad);
}
try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');
 const row=await seasonRow(); const m=await meta();
 report.preflight={row,airdate:m.date,expectedTitle:TITLE,allowedDates:[FROM,TO],officialYoutube:{id:'XT-M3Z-wnVE',title:TITLE,published:'2017-05-27'}};
 if(!row||canon(row.title)!==canon(TITLE)) throw new Error('TITLE_DRIFT '+JSON.stringify(row));
 if(![FROM,TO].includes(m.date)) throw new Error('DATE_DRIFT '+m.date);
 if(m.date===FROM){
   await m.f.locator('input[name="airdate"]').fill(TO);
   await guardedSubmit(m.f,m.path);
   report.writes.push({field:'airdate',id:ID,from:FROM,to:TO});
 }
 const v=await meta();
 const ok=v.date===TO;
 report.verifications.push({id:ID,airdate:v.date,ok});
 if(!ok) throw new Error('POST_WRITE_VERIFY_FAILED '+v.date);
 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:String(e?.stack||e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,'writes='+report.writes.length,'blocked='+report.blocked.length,'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
