import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const BASE='https://thetvdb.com',SLUG='djilsi',ID='9242991',SERIES='414993';
const OUT='reports/artwork-user192-form-restriction-v23-2';
await fs.mkdir(OUT,{recursive:true});
const report={createdAt:new Date().toISOString(),mode:'AUTHENTICATED_ARTWORK_FORM_READ_ONLY_DIAGNOSTIC',
 authenticated:false,episodeId:ID,formPage:null,blocks:[],networkWritesAfterAuth:0,result:'NOT_STARTED'};
let browser;
try{
 if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)throw Error('AUTH_SECRETS_MISSING');
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({locale:'fr-FR'});
 const page=await context.newPage();
 const login=await page.goto(BASE+'/auth/login',{waitUntil:'domcontentloaded',timeout:50000});
 if(!login||login.status()!==200)throw Error('LOGIN_HTTP_'+login?.status());
 const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 if(await f.count()!==1)throw Error('LOGIN_FORM_MISSING');
 await f.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
 await f.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
 await f.locator('button[type="submit"],input[type="submit"]').first().click();
 await page.waitForLoadState('domcontentloaded').catch(()=>{});
 const proof=await context.request.get(BASE+'/auth/getuser',{timeout:22000}).catch(()=>null);
 const info=await proof?.json().catch(()=>null);
 if(!proof?.ok()||!info||!Object.keys(info).length)throw Error('AUTH_NOT_PROVEN');
 report.authenticated=true;
 await context.route('**/*',async route=>{
   const request=route.request(),method=request.method().toUpperCase(),url=new URL(request.url());
   if(url.hostname.endsWith('thetvdb.com')&&!['GET','HEAD','OPTIONS'].includes(method)){
     report.networkWritesAfterAuth+=1;return route.abort('blockedbyclient');
   }
   return route.continue();
 });
 const url=BASE+'/artwork/upload?type=11&episode='+ID+'&series='+SERIES;
 const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 const status=r?.status();
 const body=(await page.locator('body').innerText().catch(()=>''))||'';
 const forms=await page.locator('form').evaluateAll(forms=>forms.map(f=>({
  action:f.getAttribute('action'),method:f.getAttribute('method'),
  inputNames:[...f.querySelectorAll('input')].map(el=>el.name).filter(Boolean).filter(x=>x!=='_token'),
  relevantButtons:[...f.querySelectorAll('button,input[type="submit"]')].map(el=>(el.textContent||el.value||'').trim()).filter(Boolean)
 })));
 const warnings=await page.locator('[role="alert"],.alert,.error,.warning,.invalid-feedback')
   .allTextContents().catch(()=>[]);
 report.formPage={requestedUrl:url,pageUrl:page.url(),http:status,title:await page.title(),
   formCount:forms.length,forms,warnings:warnings.map(x=>x.trim()).filter(Boolean).slice(0,12),
   text:body.replace(/\s+/g,' ').slice(0,3000),
   actionPresent:forms.some(x=>x.action==='/artwork/upload_handler')};
 report.result=![200,201].includes(status)?'SITE_HTTP_BLOCK':
    report.formPage.actionPresent?'FORM_AVAILABLE_READ_ONLY':'FORM_NOT_AVAILABLE_READ_ONLY';
}catch(e){report.blocks.push(String(e?.message||e));report.result='STOPPED_WITHOUT_SITE_WRITE';}
finally{await browser?.close().catch(()=>{});}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,authenticated:report.authenticated,
 http:report.formPage?.http,pageUrl:report.formPage?.pageUrl,
 forms:report.formPage?.forms,warnings:report.formPage?.warnings,
 text:report.formPage?.text,blocked:report.blocks}).slice(0,5700));
