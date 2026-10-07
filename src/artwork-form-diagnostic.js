import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');

const BASE='https://thetvdb.com';
const X={slug:'elian-ventre-462729',series:'462729',episodeId:'11092255',code:'S2023E08'};
const OUT='reports/artwork-form-diagnostic-2026-10-07';
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_READ_ONLY_ARTWORK_FORM_DIAGNOSTIC',authenticated:false,target:X,form:null,controls:[],buttons:[],scripts:[],bodyText:null,blockedNonReadRequests:[],result:'NOT_STARTED'};

async function go(url){
  const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(700);
  if(!r||r.status()>=400) throw new Error('GET '+url+' '+(r?.status()??'n/a'));
  return r;
}

try{
  await go(BASE+'/auth/login');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);
  await lf.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(700);
  const probe=await context.request.get(BASE+'/auth/getuser');
  report.authenticated=probe.ok();
  if(!report.authenticated) throw new Error('Auth not proven');

  await context.route('**/*', async route=>{
    const req=route.request(),m=req.method().toUpperCase();
    if(/thetvdb\.com/i.test(req.url())&&!['GET','HEAD','OPTIONS'].includes(m)){
      report.blockedNonReadRequests.push({method:m,url:req.url()});
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  await go(BASE+'/artwork/upload?type=11&episode='+X.episodeId+'&series='+X.series);
  const form=page.locator('form[action*="/artwork/upload_handler"]').first();
  if(!(await form.count())) throw new Error('Artwork upload form missing');

  report.form=await form.evaluate(f=>({
    action:f.getAttribute('action'),
    method:f.getAttribute('method'),
    enctype:f.getAttribute('enctype'),
    acceptCharset:f.getAttribute('accept-charset'),
    id:f.id||null,
    className:f.className||null,
    outerHTML:f.outerHTML
  }));

  report.controls=await form.locator('input,select,textarea').evaluateAll(els=>els.map(el=>({
    tag:el.tagName.toLowerCase(),
    type:el.getAttribute('type'),
    name:el.getAttribute('name'),
    value:el.getAttribute('value'),
    required:el.hasAttribute('required'),
    accept:el.getAttribute('accept'),
    checked:'checked' in el ? el.checked : undefined,
    options:el.tagName==='SELECT'?[...el.options].map(o=>({value:o.value,text:o.text,selected:o.selected})):undefined
  })));

  report.buttons=await form.locator('button,input[type="submit"]').evaluateAll(els=>els.map(el=>({
    tag:el.tagName.toLowerCase(),
    type:el.getAttribute('type'),
    name:el.getAttribute('name'),
    value:el.getAttribute('value'),
    text:el.textContent?.trim()||null,
    disabled:el.disabled
  })));

  report.scripts=await page.locator('script').evaluateAll(els=>els.map(el=>el.src||el.textContent||'').filter(Boolean).filter(x=>/artwork|upload|crop|file|url/i.test(x)).slice(0,20));
  report.bodyText=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,8000);
  report.result='DIAGNOSTIC_COMPLETE_ZERO_WRITES';
}catch(e){
  report.error=String(e?.stack||e);
  report.result='DIAGNOSTIC_BLOCKED';
}finally{
  await browser.close();
}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({authenticated:report.authenticated,result:report.result,form:report.form?{action:report.form.action,method:report.form.method,enctype:report.form.enctype}:null,controls:report.controls,buttons:report.buttons},null,2));
if(report.result!=='DIAGNOSTIC_COMPLETE_ZERO_WRITES')process.exitCode=2;
