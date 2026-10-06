import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_JOYCA_2026_RUNTIME_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='335805-show',YEAR=2026;
const OUT='reports/joyca-2026-runtime-apply';
const PLAN=[
 {id:'11553598',episode:1,title:'ON REND FOU DES INCONNUS AU TELEPHONE ! (Avec @Djilsi)',date:'2026-01-11',from:27,to:28,youtubeId:'mn1WK--10sk',duration:'27:43'},
 {id:'11775704',episode:9,title:"TIK TOK M'A FAIT ACHETER ÇA ! (j'ai failli tout cramer) #11",date:'2026-05-03',from:45,to:46,youtubeId:'HE9yP4drJ1w',duration:'45:34'},
 {id:'11809946',episode:10,title:'SAUVE LE SHERIF ! (Avec Djilsi, Maxime Biaggi, Seb, Sofyan, Etoiles, Mathieu)',date:'2026-05-24',from:67,to:68,youtubeId:'5TjFUj3JaLg',duration:'1:07:33'}
];

await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),target:'Joyca 2026 runtimes',mode:'GUARDED_RUNTIME_APPLY',authenticated:false,preflight:[],writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
const canon=s=>String(s||'').normalize('NFC').replace(/\s+/g,' ').trim();
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(url){
 let last=null;
 for(let i=1;i<=4;i++){
  last=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(last&&last.status()<400){await page.waitForTimeout(300);return;}
  await page.waitForTimeout(i*700);
 }
 throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
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
async function seasonMap(){
 await go(`${BASE}/series/${SLUG}/seasons/official/${YEAR}/edit`);
 const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]')||null;
   const href=a?.href||'';
   return {number:Number(input.value)||null,publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
 return new Map(rows.filter(x=>x.publicId).map(x=>[x.publicId,x]));
}
async function meta(id){
 await go(`${BASE}/series/${SLUG}/episodes/${id}/0/edit`);
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();
 if(!(await f.count())) throw new Error('Metadata form missing '+id);
 const action=await f.getAttribute('action');
 if(!action||!action.includes(`/series/${SLUG}/season/official/episodes/${id}/update`)) throw new Error('Unexpected form action '+id+' '+action);
 return {f,path:new URL(action,BASE).pathname,airdate:await f.locator('input[name="airdate"]').first().inputValue(),runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())};
}
async function guardedSubmit(form,path){
 let bad=null;
 const handler=async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();}
   if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
   return route.continue();
 };
 await context.route('**/*',handler);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(600);
 await context.unroute('**/*',handler);
 if(bad) throw new Error(bad);
}
try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');
 const sm=await seasonMap();
 for(const x of PLAN){
   const row=sm.get(x.id);
   const m=await meta(x.id);
   report.preflight.push({id:x.id,episode:x.episode,currentRow:row||null,airdate:m.airdate,runtime:m.runtime,expectedFrom:x.from,desired:x.to,youtubeId:x.youtubeId,duration:x.duration});
   if(!row||row.number!==x.episode||canon(row.title)!==canon(x.title)) throw new Error('CURRENT_MAPPING_DRIFT '+x.id+' '+JSON.stringify(row));
   if(m.airdate!==x.date) throw new Error('AIRDATE_DRIFT '+x.id+' '+m.airdate);
   if(![x.from,x.to].includes(m.runtime)) throw new Error('RUNTIME_DRIFT '+x.id+' '+m.runtime);
 }
 for(const x of PLAN){
   const m=await meta(x.id);
   if(m.runtime===x.to){
     report.skips.push({id:x.id,reason:'ALREADY_CORRECT',runtime:m.runtime});
   }else{
     await m.f.locator('input[name="runtime"]').fill(String(x.to));
     await guardedSubmit(m.f,m.path);
     report.writes.push({id:x.id,episode:x.episode,from:x.from,to:x.to,youtubeId:x.youtubeId,duration:x.duration});
   }
   const v=await meta(x.id);
   const ok=v.runtime===x.to&&v.airdate===x.date;
   report.verifications.push({id:x.id,episode:x.episode,runtime:v.runtime,airdate:v.airdate,ok});
   if(!ok) throw new Error('POST_WRITE_VERIFY_FAILED '+x.id+' '+JSON.stringify(v));
 }
 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:String(e?.stack||e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,
 'planned='+PLAN.length,
 'writes='+report.writes.length,
 'skips='+report.skips.length,
 'blocked='+report.blocked.length,
 'verifications='+report.verifications.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
