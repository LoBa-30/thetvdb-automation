import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
const BASE='https://thetvdb.com',OUT='reports/mcfly-priorities-v22-4-form-diagnostic';
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_LOCAL_FORM_DIAGNOSTIC_NO_SUBMISSION',
  authenticated:false,targets:[],blocked:[],errors:[],tvdbWrites:0,result:'NOT_STARTED'};
let browser,locked=false;
async function go(p,url){
 const r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 if(!r||r.status()!==200)throw Error('GET_HTTP_'+(r?.status()||'NONE'));
 if(/\/auth\/login/.test(p.url())&&!/\/auth\/login/.test(url))throw Error('AUTH_REDIRECT');
 const body=((await p.locator('body').innerText().catch(()=>''))||'').slice(0,1600);
 if(/captcha|verify you are human|access denied|rate limit|checking your browser/i.test(body))throw Error('SITE_RESTRICTED');
}
async function inspect(p,x){
 const out={series:x.series,episodeId:x.id,expectedDate:x.expected,formPresent:false,readonlyOnly:true};
 await go(p,BASE+'/series/'+x.slug+'/episodes/'+x.id+'/0/edit');
 out.finalUrl=p.url();out.title=await p.title();
 const form=p.locator('form').filter({has:p.locator('input[name="airdate"]')}).first();
 if(await form.count()!==1)throw Error('FORM_MISSING_'+x.id);
 out.formPresent=true;out.action=await form.getAttribute('action');
 out.method=await form.getAttribute('method');
 out.fields=await form.locator('input,select,textarea').evaluateAll(els=>els.map(el=>{
   const type=el.getAttribute('type')||el.tagName.toLowerCase();
   const name=el.getAttribute('name')||'';
   return {name,type,required:el.required,disabled:el.disabled,readOnly:el.readOnly,
     filled:!!el.value,visible:!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length)};
 }).filter(x=>x.name).slice(0,80));
 const date=form.locator('input[name="airdate"]').first();
 out.currentDate=await date.inputValue();
 out.dateReadOnly=await date.evaluate(e=>e.readOnly||e.disabled);
 out.formSubmitButtons=await form.locator('button,input[type="submit"]').evaluateAll(els=>els.map(el=>({
   tag:el.tagName,type:el.getAttribute('type'),name:el.getAttribute('name'),
   disabled:el.disabled,text:(el.textContent||el.getAttribute('value')||'').trim().slice(0,60)
 })));
 // Only local DOM validation, never requestSubmit(), click submit or send a POST.
 await date.fill(x.expected);
 out.localValidation=await form.evaluate(f=>({
   valid:f.checkValidity(),
   invalid:[...f.elements].filter(e=>e.willValidate&&!e.checkValidity()).map(e=>({
     name:e.name,type:e.type,required:e.required,
     message:String(e.validationMessage||'').slice(0,140)
   })).slice(0,30)
 }));
 out.visibleFormMessages=await p.locator('form .invalid-feedback,form .alert,form [role="alert"]')
  .allTextContents().catch(()=>[]);
 out.visibleFormMessages=out.visibleFormMessages.map(x=>x.trim()).filter(Boolean).slice(0,10);
 await date.fill(out.currentDate);
 return out;
}
try{
 if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)throw Error('MISSING_SECRETS');
 browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({locale:'fr-FR'}),p=await ctx.newPage();
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(locked&&u.hostname.endsWith('thetvdb.com')&&!['GET','HEAD','OPTIONS'].includes(req.method().toUpperCase())){
   report.blocked.push({reason:'NON_READ_REQUEST_BLOCKED',method:req.method(),path:u.pathname});
   return route.abort('blockedbyclient');
  }
  await route.continue();
 });
 await go(p,BASE+'/auth/login');
 const form=p.locator('form').filter({has:p.locator('input[name="password"]')}).first();
 if(await form.count()!==1)throw Error('LOGIN_FORM_MISSING');
 await form.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
 await form.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
 await form.locator('button[type="submit"],input[type="submit"]').first().click();
 await p.waitForLoadState('domcontentloaded').catch(()=>{});
 const s=await ctx.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
 const payload=await s?.json().catch(()=>null);
 if(!s?.ok()||!payload||!Object.keys(payload).length)throw Error('LOGIN_NOT_PROVEN');
 locked=true;report.authenticated=true;
 for(const x of [
   {series:'Mcfly & Carlito',slug:'338282-show',id:'12022496',expected:'2026-10-06'},
   {series:'Mastu (known successful older date edit, no changes)',slug:'346011-show',id:'9195816',expected:'2017-05-27'}
 ]){try{report.targets.push(await inspect(p,x));}catch(e){report.errors.push({target:x.id,error:String(e?.message||e)});}}
 report.result=report.targets.length===2&&!report.errors.length?'COMPARED_READ_ONLY':'PARTIAL_DIAGNOSTIC';
}catch(e){report.errors.push({error:String(e?.message||e)});report.result='BLOCKED';}
finally{if(browser)await browser.close().catch(()=>{});}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,authenticated:report.authenticated,
 targets:report.targets.map(x=>({id:x.episodeId,date:x.currentDate,readonly:x.dateReadOnly,
 formAction:x.action,validation:x.localValidation})),errors:report.errors}));
if(report.result!=='COMPARED_READ_ONLY')process.exitCode=2;
