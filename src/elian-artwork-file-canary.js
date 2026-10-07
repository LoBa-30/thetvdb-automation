import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_ARTWORK_FILE_CANARY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',SERIES='462729';
const X={id:'11092253',code:'S2023E06',title:'13m2 dans PARIS ???',youtubeId:'lBYtMPlWRq4',imageUrl:'https://i.ytimg.com/vi/lBYtMPlWRq4/maxresdefault.jpg'};
const OUT='reports/elian-artwork-file-canary';
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),target:'Elian '+X.code,mode:'GUARDED_FILE_UPLOAD_CANARY',armed,authenticated:false,preflight:{},write:null,verification:null,blocked:[],result:'NOT_STARTED'};
if(!armed){report.result='BLOCKED_NOT_ARMED';await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');throw new Error('Not armed');}
if(!username||!password){report.result='BLOCKED_MISSING_CREDENTIALS';await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');throw new Error('Missing credentials');}

const prior=JSON.parse(await fs.readFile('reports/elian-artwork-batch-preflight/report.json','utf8'));
const planned=prior.planned?.find(x=>x.id===X.id);
if(!planned||planned.imageUrl!==X.imageUrl||planned.width!==1280||planned.height!==720){
  report.result='BLOCKED_PRIOR_PREFLIGHT_DRIFT';report.blocked.push({reason:'PRIOR_PREFLIGHT_NOT_CLEAN',planned});await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');throw new Error('Prior preflight not clean');
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(u){let r=null;for(let i=0;i<3;i++){r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(350);return r;}await page.waitForTimeout(600*(i+1));}throw new Error('GET '+u+' '+(r?.status()??'n/a'));}
function artUrls(html){return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>s]+episode[^"'<>s]+\/screencap\/[^"'<>s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));}
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();

try{
  await go(BASE+'/auth/login');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(700);
  const probe=await context.request.get(BASE+'/auth/getuser');
  report.authenticated=probe.ok();
  if(!report.authenticated)throw new Error('Auth not proven');

  await go(BASE+'/series/'+SLUG+'/episodes/'+X.id);
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  const before=artUrls(await page.content());
  report.preflight={heading,beforeArtwork:before,imageUrl:X.imageUrl};
  if(norm(heading)!==norm(X.title)){report.blocked.push({reason:'TITLE_DRIFT',heading});throw new Error('TITLE_DRIFT');}
  if(before.length){report.result='ALREADY_PRESENT_NO_WRITE';report.verification={artworkPresent:true,artwork:before};await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');console.log('already present');await browser.close();process.exit(0);}

  const ir=await context.request.get(X.imageUrl);
  const contentType=ir.headers()['content-type']||'';
  const buf=await ir.body();
  report.preflight.imageFetch={status:ir.status(),contentType,bytes:buf.length};
  if(!ir.ok()||!/^image\//i.test(contentType)||buf.length<10000){report.blocked.push({reason:'IMAGE_FETCH_INVALID',status:ir.status(),contentType,bytes:buf.length});throw new Error('IMAGE_FETCH_INVALID');}

  await go(BASE+'/artwork/upload?type=11&episode='+X.id+'&series='+SERIES);
  const f=page.locator('form[action*="/artwork/upload_handler"]').first();
  if(!(await f.count()))throw new Error('Upload form missing');
  const ep=await f.locator('input[name="episode"]').inputValue(),series=await f.locator('input[name="series"]').inputValue(),type=await f.locator('input[name="type"]').inputValue(),action=await f.getAttribute('action');
  if(ep!==X.id||series!==SERIES||type!=='11'||action!=='/artwork/upload_handler'){report.blocked.push({reason:'FORM_SCOPE_DRIFT',ep,series,type,action});throw new Error('FORM_SCOPE_DRIFT');}
  await f.locator('input[name="file"]').setInputFiles({name:X.youtubeId+'.jpg',mimeType:'image/jpeg',buffer:buf});

  let unexpected=null;
  const h=async route=>{
    const req=route.request(),u=new URL(req.url()),m=req.method().toUpperCase();
    if(m==='DELETE'||/\/entity\/delete/.test(u.pathname)){unexpected='DESTRUCTIVE '+m+' '+u.pathname;return route.abort();}
    if(u.origin===BASE&&m==='POST'&&u.pathname!=='/artwork/upload_handler'){unexpected='UNEXPECTED_POST '+u.pathname;return route.abort();}
    return route.continue();
  };
  await context.route('**/*',h);
  const responsePromise=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);
  const resp=await responsePromise;
  await page.waitForTimeout(800);
  await context.unroute('**/*',h);
  if(unexpected)throw new Error(unexpected);
  const responseText=resp?await resp.text().catch(()=>''):'';
  report.write={submitted:true,submittedAt:new Date().toISOString(),postStatus:resp?.status()??null,postOk:resp?.ok()??null,postUrl:resp?.url()??null,responsePreview:responseText.replace(/\s+/g,' ').slice(0,1200)};
  if(!resp||resp.status()>=400){report.blocked.push({reason:'UPLOAD_HANDLER_FAILED',write:report.write});throw new Error('UPLOAD_HANDLER_FAILED');}

  const reads=[];
  let after=[];
  for(const delay of [0,3000,7000,15000,30000]){
    if(delay)await page.waitForTimeout(delay);
    await go(BASE+'/series/'+SLUG+'/episodes/'+X.id);
    after=artUrls(await page.content());
    reads.push({at:new Date().toISOString(),artworkCount:after.length,artwork:after});
    if(after.length)break;
  }
  report.verification={reads,artworkPresent:after.length>0,artwork:after,writeRetried:false};
  report.result=after.length?'APPLIED_AND_VERIFIED':'SUBMITTED_VERIFICATION_PENDING_DO_NOT_RETRY';
}catch(e){
  if(!report.blocked.length)report.blocked.push({reason:String(e?.stack||e)});
  if(report.result==='NOT_STARTED')report.result=report.write?'SUBMITTED_REVIEW_REQUIRED_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE';
}finally{if(browser.isConnected())await browser.close();}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'armed='+report.armed,
  'authenticated='+report.authenticated,
  'submitted='+(report.write?.submitted||false),
  'postStatus='+(report.write?.postStatus??'n/a'),
  'artworkPresent='+(report.verification?.artworkPresent||false),
  'blocked='+report.blocked.length,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','SUBMITTED_VERIFICATION_PENDING_DO_NOT_RETRY','ALREADY_PRESENT_NO_WRITE'].includes(report.result))process.exitCode=2;
