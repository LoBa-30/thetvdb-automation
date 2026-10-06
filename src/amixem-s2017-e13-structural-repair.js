import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_AMIXEM_S2017_E13_REPAIR||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='328213-show',YEAR=2017;
const OUT='reports/amixem-s2017-e13-structural-repair';
const PLAN=[
 {id:'6102812',from:20,to:13,title:"JE JOUE À L'INSTRUMENT DE MUSIQUE LE PLUS BIZARRE !"},
 {id:'6102813',from:13,to:14,title:"LE PIRE COLIS QU'UN ABONNÉ M'AIT ENVOYÉ !"},
 {id:'6102814',from:14,to:15,title:"MA PREMIÈRE PARTIE D'AIRSOFT EN HÉLICOPTÈRE !"},
 {id:'6102822',from:15,to:16,title:"JE TESTE LES PIRES INSTRUMENTS DE MUSIQUES !"},
 {id:'6102824',from:16,to:17,title:"L'AVENTURE LA PLUS DINGUE DE MA VIE ! - 4L Trophy EP #1"},
 {id:'6102827',from:17,to:18,title:"LES PIRES ARTICLES AMAZON !"},
 {id:'6102828',from:18,to:19,title:"ENSABLÉS DANS LE DÉSERT ! 4L Trophy EP #3"},
 {id:'6102829',from:19,to:20,title:"JE VISITE LA STATION SPATIALE !"}
];
const DATE={id:'6102812',from:'2017-03-16',to:'2017-02-16'};

if(!armed)throw new Error('Not armed');
if(!username||!password)throw new Error('Missing credentials');
await fs.mkdir(OUT,{recursive:true});
const report={
 generatedAt:new Date().toISOString(),target:'Amixem S2017 E13-E20',mode:'GUARDED_STRUCTURAL_REPAIR',
 evidence:{
  youtubeVideoId:'fu-nBHrmokA',
  currentOfficialChannelOrder:'between 2017-02-11 and 2017-02-19 uploads',
  historicalIndexDate:'2017-02-16',
  youtubeDurationSeconds:859,
  note:'No title write; no delete; no create.'
 },
 authenticated:false,preflight:[],writes:[],verifications:[],blocked:[],result:'NOT_STARTED'
};
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
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
async function seasonRows(){
 await go(`${BASE}/series/${SLUG}/seasons/official/${YEAR}/edit`);
 return await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
  const name=input.getAttribute('name')||'';
  const internalId=name.match(/^episodes\[(\d+)\]$/)?.[1]||null;
  const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
  const a=c?.querySelector('a[href*="/episodes/"]')||null;
  return {internalId,publicId:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,number:Number(input.value),title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
}
function validate(rows,final=false){
 const byId=new Map(rows.map(r=>[r.publicId,r]));
 for(const x of PLAN){
  const r=byId.get(x.id);
  const n=final?x.to:x.from;
  if(!r||r.number!==n||norm(r.title)!==norm(x.title)){
   throw new Error(`STATE_DRIFT ${x.id}: expected E${n} "${x.title}", got ${JSON.stringify(r)}`);
  }
 }
 const focus=PLAN.map(x=>byId.get(x.id));
 const nums=focus.map(r=>r.number);
 if(new Set(nums).size!==nums.length)throw new Error('DUPLICATE_FOCUS_NUMBERING '+nums.join(','));
 return byId;
}
async function meta(){
 await go(`${BASE}/series/${SLUG}/episodes/${DATE.id}/0/edit`);
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"]')}).first();
 if(!(await f.count()))throw new Error('Metadata form missing');
 const action=await f.getAttribute('action');
 const path=new URL(action,BASE).pathname;
 if(!path.includes(`/series/${SLUG}/season/official/episodes/${DATE.id}/update`))throw new Error('Unexpected metadata action '+path);
 return {f,path,date:await f.locator('input[name="airdate"]').inputValue()};
}
async function guardedSubmit(form,allowedPath){
 let bad=null;
 const h=async route=>{
  const req=route.request(),u=new URL(req.url());
  if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();}
  if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==allowedPath){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
  return route.continue();
 };
 await context.route('**/*',h);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(700);
 await context.unroute('**/*',h);
 if(bad)throw new Error(bad);
}
try{
 report.authenticated=await login();
 if(!report.authenticated)throw new Error('Authenticated session not proven');

 const before=await seasonRows();
 const byId=validate(before,false);
 const m0=await meta();
 if(![DATE.from,DATE.to].includes(m0.date))throw new Error('DATE_DRIFT '+m0.date);
 report.preflight=PLAN.map(x=>({id:x.id,title:x.title,from:x.from,to:x.to,current:byId.get(x.id)}));
 report.preflight.push({id:DATE.id,field:'airdate',expected:[DATE.from,DATE.to],actual:m0.date});

 const alreadyNumbered=PLAN.every(x=>byId.get(x.id)?.number===x.to);
 if(!alreadyNumbered){
  await go(`${BASE}/series/${SLUG}/seasons/official/${YEAR}/edit`);
  const current=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
   const name=input.getAttribute('name')||'';const internalId=name.match(/^episodes\[(\d+)\]$/)?.[1]||null;
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]')||null;
   return {internalId,publicId:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,number:Number(input.value),title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
  }));
  const curById=validate(current,false);
  for(const x of PLAN){
   const r=curById.get(x.id);
   await page.locator(`input[name="episodes[${r.internalId}]"]`).fill(String(x.to));
  }
  const f=page.locator('form').filter({has:page.locator('input[name="season_number"]')}).first();
  if(!(await f.count()))throw new Error('Season form missing');
  const action=new URL(await f.getAttribute('action'),BASE).pathname;
  if(!action.includes(`/series/${SLUG}/official/`)||!action.endsWith('/saveseason'))throw new Error('Unexpected season action '+action);
  await guardedSubmit(f,action);
  const after=await seasonRows();validate(after,true);
  report.writes.push({type:'RENUMBER_SEASON',year:YEAR,changes:PLAN.map(x=>({id:x.id,from:x.from,to:x.to}))});
  report.verifications.push({type:'SEASON_NUMBERING',ok:true,changes:PLAN.map(x=>({id:x.id,episode:x.to}))});
 }else{
  report.verifications.push({type:'SEASON_NUMBERING',ok:true,alreadyCorrect:true});
 }

 const m=await meta();
 if(m.date===DATE.from){
  await m.f.locator('input[name="airdate"]').fill(DATE.to);
  await guardedSubmit(m.f,m.path);
  const v=await meta();
  if(v.date!==DATE.to)throw new Error('DATE_VERIFY_FAILED '+v.date);
  report.writes.push({type:'AIRDATE',id:DATE.id,from:DATE.from,to:DATE.to});
  report.verifications.push({type:'AIRDATE',id:DATE.id,ok:true,value:v.date});
 }else if(m.date===DATE.to){
  report.verifications.push({type:'AIRDATE',id:DATE.id,ok:true,alreadyCorrect:true,value:m.date});
 }else throw new Error('DATE_DRIFT_AFTER_RENUMBER '+m.date);

 const finalRows=await seasonRows();validate(finalRows,true);
 const finalMeta=await meta();
 if(finalMeta.date!==DATE.to)throw new Error('FINAL_DATE_DRIFT '+finalMeta.date);
 report.verifications.push({type:'FINAL_STATE',ok:true,episode13Id:DATE.id,date:finalMeta.date});
 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:e?.stack||String(e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,
 'writes='+report.writes.length,
 'verifications='+report.verifications.length,
 'blocked='+report.blocked.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
