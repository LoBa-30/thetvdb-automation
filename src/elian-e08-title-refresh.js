
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_E08_TITLE_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');
const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',ID='12014528';
const FROM='Nos cabanes vont-elles résister au Loup ?! (ft. Maxime Biaggi)';
const TO="On s'affronte pour construire la meilleure cabane ! ft. Maxime Biaggi";
const OUT='reports/elian-e08-title-refresh';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),target:'Elian S2026E08',youtubeId:'xkGjW_FR8vI',mode:'GUARDED_CURRENT_TITLE_REFRESH',authenticated:false,writes:[],skips:[],blocked:[],verification:null,result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(300);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 const probe=await context.request.get(BASE+'/auth/getuser');report.authenticated=probe.ok();if(!report.authenticated)throw new Error('Auth not proven');
 await go(BASE+'/series/'+SLUG+'/episodes/'+ID+'/0/edit');
 const f=page.locator('form').filter({has:page.locator('input[name="name"]')}).first();
 if(!(await f.count()))throw new Error('Edit form missing');
 const name=f.locator('input[name="name"]').first();
 const current=await name.inputValue();report.currentTitle=current;
 const runtime=Number(await f.locator('input[name="runtime"]').first().inputValue().catch(()=>''))||null;report.runtime=runtime;
 if(current===TO){report.skips.push({reason:'ALREADY_CURRENT',title:current});}
 else if(current!==FROM){report.blocked.push({reason:'TITLE_DRIFT',expectedFrom:FROM,actual:current});throw new Error('TITLE_DRIFT');}
 else{
   await name.fill(TO);
   const action=await f.getAttribute('action');const path=new URL(action,BASE).pathname;let bad=null;
   const h=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete/.test(u.pathname)){bad='DESTRUCTIVE';return route.abort();}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}return route.continue();};
   await context.route('**/*',h);
   await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);
   await page.waitForTimeout(500);await context.unroute('**/*',h);
   if(bad)throw new Error(bad);
   report.writes.push({field:'title',from:FROM,to:TO});
 }
 await go(BASE+'/series/'+SLUG+'/episodes/'+ID+'/0/edit');
 const vf=page.locator('form').filter({has:page.locator('input[name="name"]')}).first();
 const finalTitle=await vf.locator('input[name="name"]').first().inputValue();
 const finalRuntime=Number(await vf.locator('input[name="runtime"]').first().inputValue().catch(()=>''))||null;
 report.verification={title:finalTitle,runtime:finalRuntime,titleOk:finalTitle===TO,runtimeOk:finalRuntime===34};
 report.result=report.verification.titleOk&&report.verification.runtimeOk?'APPLIED_AND_VERIFIED':'VERIFY_FAILED';
}catch(e){if(!report.blocked.length)report.blocked.push({reason:String(e?.message||e)});if(report.result==='NOT_STARTED')report.result='BLOCKED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
