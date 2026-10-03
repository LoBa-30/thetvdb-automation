import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const BASE='https://thetvdb.com',SLUG='338282-show';
const cfg=JSON.parse(await fs.readFile('config/mcfly-unassigned-exact-duplicates.json','utf8'));
if(!username||!password) throw new Error('Missing TVDB credentials');
await fs.mkdir('reports/mcfly-unassigned-duplicate-preflight',{recursive:true});

const canon=s=>String(s||'').normalize('NFC').replace(/\u200b/g,'').replace(/\s+/g,' ').trim();
const report={
 generatedAt:new Date().toISOString(),
 mode:'READ_ONLY_EXACT_UNASSIGNED_DUPLICATE_PREFLIGHT',
 authenticated:false,
 configured:cfg.pairs.length,
 currentUnassignedCount:null,
 ready:[],
 blocked:[],
 mutationRequestsBlocked:[],
 result:'NOT_STARTED'
};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
let authenticated=false;

const mutationPath=/\/entity\/delete|\/episodes\/translatestore|\/season\/official\/episodes\/\d+\/update|\/seasons\/official\/[^/]+\/update/i;
await context.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());
 if(authenticated && u.origin===BASE && req.method()!=='GET' && mutationPath.test(u.pathname)){
   report.mutationRequestsBlocked.push({method:req.method(),path:u.pathname});
   await route.abort(); return;
 }
 await route.continue();
});

async function go(url){
 let last=null;
 for(let i=1;i<=4;i++){
   last=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
   if(last && last.status()<400){await page.waitForTimeout(250);return last;}
   await page.waitForTimeout(400*i);
 }
 throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
}
async function login(){
 await go(BASE+'/auth/login');
 const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 if(!(await f.count())) return false;
 await f.locator('input[name="email"]').fill(username);
 await f.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(600);
 const probe=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
 return Boolean(probe?.ok());
}
async function readUnassigned(){
 await go(BASE+'/series/'+SLUG+'/seasons/official/unassigned/edit');
 const rows=await page.locator('tr').evaluateAll(trs=>trs.map(tr=>{
   const a=[...tr.querySelectorAll('a')].find(a=>/\/episodes\/\d+/.test(a.href));
   if(!a) return null;
   const text=(tr.textContent||'').replace(/\s+/g,' ').trim();
   return {
     publicId:(a.href.match(/\/episodes\/(\d+)/)||[])[1]||null,
     title:(a.textContent||'').replace(/\s+/g,' ').trim(),
     date:(text.match(/\b(\d{4}-\d{2}-\d{2})\b/)||[])[1]||null
   };
 }).filter(Boolean));
 return rows;
}
async function readSeason(year){
 await go(BASE+'/series/'+SLUG+'/seasons/official/'+year+'/edit');
 return await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]')||null;
   const href=a?.href||'';
   return {
     publicId:(href.match(/\/episodes\/(\d+)/)||[])[1]||null,
     number:Number(input.value)||null,
     title:(a?.textContent||'').replace(/\s+/g,' ').trim()
   };
 }).filter(x=>x.publicId));
}
async function readMetadata(id){
 await go(BASE+'/series/'+SLUG+'/episodes/'+id+'/0/edit');
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"]')}).first();
 if(!(await f.count())) return {airdate:null,formAction:null};
 return {airdate:await f.locator('input[name="airdate"]').first().inputValue(),formAction:await f.getAttribute('action')};
}

try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');
 authenticated=true;

 const unassigned=await readUnassigned();
 report.currentUnassignedCount=unassigned.length;
 const sourceMap=new Map(unassigned.map(x=>[x.publicId,x]));
 const seasons=new Map();
 for(const y of [...new Set(cfg.pairs.map(x=>x.season))]) seasons.set(y,await readSeason(y));
 const targetMaps=new Map([...seasons].map(([y,rs])=>[y,new Map(rs.map(r=>[r.publicId,r]))]));

 for(const x of cfg.pairs){
   const reasons=[];
   const source=sourceMap.get(x.sourceId)||null;
   const target=targetMaps.get(x.season)?.get(x.targetId)||null;
   if(!source) reasons.push('SOURCE_NOT_CURRENTLY_UNASSIGNED');
   if(source && canon(source.title)!==canon(x.title)) reasons.push('SOURCE_TITLE_DRIFT');
   if(source && source.date!==x.date) reasons.push('SOURCE_DATE_DRIFT');
   if(!target) reasons.push('TARGET_NOT_IN_EXPECTED_SEASON');
   if(target && target.number!==x.episode) reasons.push('TARGET_NUMBER_DRIFT');
   if(target && canon(target.title)!==canon(x.title)) reasons.push('TARGET_TITLE_DRIFT');
   if(x.sourceId===x.targetId) reasons.push('SOURCE_EQUALS_TARGET');

   let meta=null;
   if(reasons.length===0){
     meta=await readMetadata(x.targetId);
     if(meta.airdate!==x.date) reasons.push('TARGET_DATE_DRIFT');
     const expectedPath='/series/'+SLUG+'/season/official/episodes/'+x.targetId+'/update';
     if(!meta.formAction || !new URL(meta.formAction,BASE).pathname.includes(expectedPath)) reasons.push('UNEXPECTED_TARGET_FORM');
   }
   const item={...x,currentSource:source,currentTarget:target,targetMetadata:meta};
   if(reasons.length) report.blocked.push({...item,reasons});
   else report.ready.push(item);
 }
 report.result=report.mutationRequestsBlocked.length?'BLOCKED_UNEXPECTED_MUTATION_REQUEST':(report.blocked.length?'PARTIAL_READY':'ALL_READY');
}catch(e){
 report.blocked.push({reasons:['FATAL'],error:e?.stack||String(e)});
 report.result='FAILED';
}finally{
 await browser.close();
}

await fs.writeFile('reports/mcfly-unassigned-duplicate-preflight/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/mcfly-unassigned-duplicate-preflight/summary.txt',[
 'mode='+report.mode,
 'authenticated='+report.authenticated,
 'configured='+report.configured,
 'currentUnassignedCount='+report.currentUnassignedCount,
 'ready='+report.ready.length,
 'blocked='+report.blocked.length,
 'mutationRequestsBlocked='+report.mutationRequestsBlocked.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile('reports/mcfly-unassigned-duplicate-preflight/summary.txt','utf8'));
if(!['ALL_READY','PARTIAL_READY'].includes(report.result)) process.exitCode=2;
