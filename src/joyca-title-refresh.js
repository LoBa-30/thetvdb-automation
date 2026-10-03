import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_JOYCA_TITLE_REFRESH||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='335805-show';
const EDIT={season:2026,episode:8,id:'11749116',from:'BLOQUÉS À LA PORTE ! (Avec Seb et Sofyan)',to:'ON NE DOIT PAS SE FAIRE RECALER ! (Avec Seb et Sofyan)'};

if(!armed) throw new Error('Not armed');
if(!username||!password) throw new Error('Missing credentials');

await fs.mkdir('reports/joyca-title-refresh',{recursive:true});
const report={generatedAt:new Date().toISOString(),mode:'JOYCA_SINGLE_TITLE_REFRESH',authenticated:false,edit:EDIT,preflight:null,write:null,verification:null,result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(url){
 let r=null;
 for(let i=1;i<=4;i++){
  r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(r&&r.status()<400){await page.waitForTimeout(300);return;}
  await page.waitForTimeout(i*700);
 }
 throw new Error('GET failed '+url+' '+(r?.status()??'n/a'));
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
async function currentRow(){
 await go(BASE+'/series/'+SLUG+'/seasons/official/'+EDIT.season+'/edit');
 return await page.locator('input[name^="episodes["]').evaluateAll((ins,id)=>{
  for(const input of ins){
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]');
   if((a?.href||'').includes('/episodes/'+id)) return {number:Number(input.value)||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
  }
  return null;
 },EDIT.id);
}
async function translation(){
 await go(BASE+'/series/'+SLUG+'/episodes/'+EDIT.id+'/translate/fra/0/single');
 const f=page.locator('form').filter({has:page.locator('input[name="episode_name"]')}).first();
 if(!(await f.count())) throw new Error('Translation form missing '+EDIT.id);
 const action=await f.getAttribute('action');
 const lang=await f.locator('[name="language"]').inputValue().catch(()=>'');
 if(action!=='/episodes/translatestore'||lang!=='fra') throw new Error('Unexpected translation form '+EDIT.id+' '+action+' '+lang);
 return {f,title:await f.locator('input[name="episode_name"]').inputValue()};
}

try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');
 const row=await currentRow();
 const tr=await translation();
 report.preflight={row,currentTitle:tr.title};
 if(!row||row.number!==EDIT.episode) throw new Error('MAPPING_DRIFT '+JSON.stringify(row));
 if(tr.title===EDIT.to){
  report.write={status:'SKIP_ALREADY_CORRECT'};
 }else{
  if(tr.title!==EDIT.from) throw new Error('TITLE_DRIFT expected='+EDIT.from+' actual='+tr.title);
  let unexpected=null;
  const handler=async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){unexpected='DESTRUCTIVE '+u.pathname;await route.abort();return;}
   if(u.origin===BASE&&req.method()==='POST'&&u.pathname!=='/episodes/translatestore'){unexpected='UNEXPECTED_POST '+u.pathname;await route.abort();return;}
   await route.continue();
  };
  await context.route('**/*',handler);
  await tr.f.locator('input[name="episode_name"]').fill(EDIT.to);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),tr.f.evaluate(form=>form.requestSubmit())]);
  await page.waitForTimeout(500);
  await context.unroute('**/*',handler);
  if(unexpected) throw new Error(unexpected);
  report.write={status:'WRITTEN',from:EDIT.from,to:EDIT.to};
 }
 const v=await translation();
 report.verification={title:v.title,ok:v.title===EDIT.to};
 if(!report.verification.ok) throw new Error('VERIFY_FAILED got='+v.title);
 report.result=report.write.status==='WRITTEN'?'APPLIED_AND_VERIFIED':'ALREADY_CORRECT_VERIFIED';
}catch(e){
 report.result='BLOCKED';
 report.error=e?.stack||String(e);
}finally{
 await browser.close();
}
await fs.writeFile('reports/joyca-title-refresh/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/joyca-title-refresh/summary.txt',[
 'authenticated='+report.authenticated,
 'result='+report.result,
 'preflight='+JSON.stringify(report.preflight),
 'write='+JSON.stringify(report.write),
 'verification='+JSON.stringify(report.verification)
].join('\n')+'\n');
console.log(await fs.readFile('reports/joyca-title-refresh/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','ALREADY_CORRECT_VERIFIED'].includes(report.result)) process.exitCode=2;
