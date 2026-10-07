import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',SLUG='maxime-biaggi',SERIES='475945';
const X={episodeId:'11696606',code:'S2023E04',title:"J'organise une chasse à l'homme dans Paris !!!"};
const OUT='reports/maxime-auth-diagnostic-v2-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_MAXIME_AUTH_V2',target:X,login:null,episode:null,upload:null,result:'NOT_STARTED'};
async function go(url){const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);await page.waitForTimeout(700);return r;}
try{
  let r=await go(BASE+'/auth/login'); if(!r||r.status()>=400) throw new Error('login GET failed');
  const form=page.locator('form[action="/auth/login"]').first();
  const token=await form.locator('input[name="_token"]').inputValue();
  const resp=await context.request.post(BASE+'/auth/login',{
    form:{_token:token,redirectTo:'',email:username,password,remember:'1'},
    maxRedirects:0
  });
  report.login={postStatus:resp.status(),postHeaders:resp.headers(),cookiesAfter:(await context.cookies(BASE)).map(c=>({name:c.name,domain:c.domain,path:c.path,expires:c.expires,httpOnly:c.httpOnly,secure:c.secure}))};

  r=await go(BASE+'/series/'+SLUG+'/episodes/'+X.episodeId);
  const episodeBody=(await page.locator('body').innerText()).replace(/\s+/g,' ');
  report.episode={http:r?.status()??null,pageUrl:page.url(),heading:(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null,showsLoginLink:/\bLogin\b/.test(episodeBody),body:episodeBody.slice(0,2500)};

  r=await go(BASE+'/artwork/upload?type=11&episode='+X.episodeId+'&series='+SERIES);
  const forms=await page.locator('form').evaluateAll(fs=>fs.map(f=>({action:f.getAttribute('action'),method:f.getAttribute('method'),controls:[...f.querySelectorAll('input')].map(e=>({name:e.name,type:e.type,value:e.value}))})));
  report.upload={http:r?.status()??null,pageUrl:page.url(),title:await page.title(),forms,body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,3500)};
  const expected=forms.find(f=>f.action==='/artwork/upload_handler');
  report.result=expected?'AUTH_AND_UPLOAD_FORM_PROVEN':'AUTH_NOT_PROVEN';
}catch(e){report.error=String(e?.stack||e);report.result='DIAGNOSTIC_ERROR';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,login:report.login&&{postStatus:report.login.postStatus},episode:report.episode&&{pageUrl:report.episode.pageUrl,showsLoginLink:report.episode.showsLoginLink},upload:report.upload&&{pageUrl:report.upload.pageUrl,forms:report.upload.forms.map(f=>f.action)}},null,2));
if(report.result==='DIAGNOSTIC_ERROR')process.exitCode=2;
