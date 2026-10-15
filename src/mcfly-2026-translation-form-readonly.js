import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const BASE='https://thetvdb.com';
const SLUG='338282-show';
const OUT='reports/mcfly-2026-translation-form-readonly';
const IDS=['12024665','12031978'];
const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_TRANSLATION_FORM_READONLY_NO_SITE_POST_AFTER_LOGIN',
  authenticated:false,formRecords:[],errors:[],nonReadRequestsBlocked:0,tvdbWrites:0,artworkWrites:0,result:'NOT_STARTED'};
await fs.mkdir(OUT,{recursive:true});
let browser;
try {
 if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)throw Error('CREDENTIALS_MISSING');
 browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({locale:'fr-FR'});
 const page=await ctx.newPage();
 const go=async url=>{
   const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
   if(!r||r.status()>=400)throw Error('GET_STATUS_'+(r?.status()||'MISSING'));
   if(/\/auth\/login/.test(page.url())&&!/\/auth\/login/.test(url))throw Error('AUTH_REDIRECT');
   const body=(await page.locator('body').innerText().catch(()=>'')).slice(0,1300);
   if(/captcha|verify you are human|access denied|rate limit|too many requests|security challenge/i.test(body))throw Error('BROWSER_SECURITY_BLOCKED');
 };
 await go(BASE+'/auth/login');
 const login=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 if(await login.count()!==1)throw Error('LOGIN_FORM_MISSING');
 await login.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
 await login.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
 await login.locator('button[type="submit"],input[type="submit"]').first().click();
 await page.waitForLoadState('domcontentloaded').catch(()=>{});
 const auth=await ctx.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
 const user=await auth?.json().catch(()=>null);
 if(!auth?.ok()||!user||!Object.keys(user).length)throw Error('AUTH_NOT_PROVEN');
 report.authenticated=true;
 // Every POST except the completed login is blocked at network level.
 await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.hostname.endsWith('thetvdb.com')&&!['GET','HEAD','OPTIONS'].includes(req.method().toUpperCase())){
     report.nonReadRequestsBlocked++;
     return route.abort('blockedbyclient');
   }
   return route.continue();
 });
 for(const id of IDS){
   await go(BASE+'/series/'+SLUG+'/episodes/'+id);
   const publicTitle=(await page.locator('h1').first().innerText().catch(()=>'')).trim();
   const firstHref=await page.locator('a[href*="/episodes/'+id+'/translate/"]').first().getAttribute('href').catch(()=>null);
   if(!firstHref)throw Error('TRANSLATION_LINK_ABSENT_'+id);
   await go(new URL(firstHref,BASE).href);
   let forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});
   if(await forms.count()===0){
     const links=await page.locator('a[href*="/translate/"]').evaluateAll(as=>as.map(a=>({
       text:(a.textContent||'').trim(),href:a.getAttribute('href')
     })).filter(x=>x.href));
     const fr=links.find(x=>/fran[cç]ais|french/i.test(x.text)||/\/fra(?:\/|$)/i.test(x.href)||/\/fr(?:\/|$)/i.test(x.href));
     if(fr){
       await go(new URL(fr.href,BASE).href);
       forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});
     }
   }
   const rows=[];
   for(let i=0;i<await forms.count();i++){
     const f=forms.nth(i),raw=await f.getAttribute('action');
     const action=new URL(raw||'',BASE);
     rows.push({
       method:(await f.getAttribute('method')||'GET').toUpperCase(),
       actionOrigin:action.origin,actionPath:action.pathname,
       language:await f.locator('[name="language"]').first().inputValue().catch(()=>''),
       formTitle:await f.locator('[name="episode_name"]').first().inputValue().catch(()=>''),
       hasCsrfToken:(await f.locator('input[name="_token"]').count())>0,
       hasEpisodeName:(await f.locator('input[name="episode_name"],textarea[name="episode_name"]').count())===1
     });
   }
   report.formRecords.push({tvdbEpisodeId:id,publicTitle,pageUrl:page.url(),forms:rows});
   if(!rows.length)throw Error('TRANSLATION_FORM_NOT_FOUND_'+id);
 }
 report.result='READ_ONLY_INSPECTED';
}catch(e){
 report.errors.push({message:String(e?.message||e)});
 report.result='BLOCKED_READ_ONLY';
}finally{if(browser)await browser.close().catch(()=>{});}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(report.result!=='READ_ONLY_INSPECTED')process.exitCode=2;
