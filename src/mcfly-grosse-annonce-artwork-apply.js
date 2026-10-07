import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MCFLY_GROSSE_ANNONCE_ARTWORK_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com';
const SLUG='338282-show';
const SERIES='338282';
const X={id:'12023296',code:'S2015E01',title:'GROSSE ANNONCE',youtubeId:'fttKpTYRdMs',imageUrl:'https://i.ytimg.com/vi/fttKpTYRdMs/maxresdefault.jpg'};
const OUT='reports/mcfly-grosse-annonce-artwork-apply';
await fs.mkdir(OUT,{recursive:true});

const report={generatedAt:new Date().toISOString(),target:'Mcfly & Carlito '+X.code,mode:'GUARDED_SINGLE_OFFICIAL_YOUTUBE_ARTWORK_UPLOAD',armed,authenticated:false,preflight:{},write:null,verification:null,blocked:[],result:'NOT_STARTED'};
if(!armed){report.result='BLOCKED_NOT_ARMED';await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');throw new Error('Not armed');}
if(!username||!password){report.result='BLOCKED_MISSING_CREDENTIALS';await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');throw new Error('Missing credentials');}

const prior=JSON.parse(await fs.readFile('reports/mcfly-grosse-annonce-artwork-preflight/report.json','utf8'));
if(prior.result!=='PREFLIGHT_PASSED_ZERO_WRITES'||prior.episode?.heading!==X.title||prior.episode?.artwork?.length!==0||prior.chosenThumbnail?.url!==X.imageUrl||!prior.chosenThumbnail?.usable16x9){
  report.result='BLOCKED_PRIOR_PREFLIGHT_DRIFT';
  report.blocked.push({reason:'PRIOR_PREFLIGHT_NOT_CLEAN'});
  await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
  throw new Error('Prior preflight not clean');
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(u){
  const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  await page.waitForTimeout(450);
  if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));
  return r;
}
function artUrls(html){return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));}
try{
  await go(BASE+'/auth/login');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);
  await lf.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(700);
  const probe=await context.request.get(BASE+'/auth/getuser');
  report.authenticated=probe.ok();
  if(!report.authenticated)throw new Error('Auth not proven');

  await go(BASE+'/series/'+SLUG+'/episodes/'+X.id);
  const before=artUrls(await page.content());
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  report.preflight={heading,beforeArtwork:before,imageUrl:X.imageUrl};
  if(heading!==X.title){report.blocked.push({reason:'TITLE_DRIFT',heading});throw new Error('TITLE_DRIFT');}
  if(before.length){report.blocked.push({reason:'ARTWORK_ALREADY_PRESENT',before});throw new Error('ARTWORK_ALREADY_PRESENT');}

  await go(BASE+'/artwork/upload?type=11&episode='+X.id+'&series='+SERIES);
  const f=page.locator('form[action*="/artwork/upload_handler"]').first();
  if(!(await f.count()))throw new Error('Upload form missing');
  const ep=await f.locator('input[name="episode"]').inputValue();
  const series=await f.locator('input[name="series"]').inputValue();
  const type=await f.locator('input[name="type"]').inputValue();
  const action=await f.getAttribute('action');
  if(ep!==X.id||series!==SERIES||type!=='11'||action!=='/artwork/upload_handler'){
    report.blocked.push({reason:'FORM_SCOPE_DRIFT',ep,series,type,action});throw new Error('FORM_SCOPE_DRIFT');
  }
  await f.locator('input[name="url"]').fill(X.imageUrl);

  let bad=null;
  const h=async route=>{
    const req=route.request(),u=new URL(req.url()),method=req.method().toUpperCase();
    if(method==='DELETE'||/\/entity\/delete/.test(u.pathname)){bad='DESTRUCTIVE '+method+' '+u.pathname;return route.abort();}
    if(u.origin===BASE&&method==='POST'&&u.pathname!=='/artwork/upload_handler'){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
    return route.continue();
  };
  await context.route('**/*',h);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);
  await page.waitForTimeout(900);
  await context.unroute('**/*',h);
  if(bad)throw new Error(bad);
  report.write={episodeId:X.id,imageUrl:X.imageUrl,submitted:true,submittedAt:new Date().toISOString()};

  let after=[];
  const reads=[];
  for(let attempt=1;attempt<=6;attempt++){
    await go(BASE+'/series/'+SLUG+'/episodes/'+X.id);
    after=artUrls(await page.content());
    reads.push({attempt,artworkCount:after.length,artwork:after});
    if(after.length)break;
    await page.waitForTimeout(2000);
  }
  report.verification={reads,afterArtwork:after,artworkPresent:after.length>0,writeRetried:false};
  report.result=after.length?'APPLIED_AND_VERIFIED':'SUBMITTED_VERIFICATION_PENDING_DO_NOT_RETRY';
}catch(e){
  if(!report.blocked.length)report.blocked.push({reason:String(e?.stack||e)});
  if(report.result==='NOT_STARTED')report.result=report.write?'SUBMITTED_REVIEW_REQUIRED_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE';
}finally{await browser.close();}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'armed='+report.armed,
  'authenticated='+report.authenticated,
  'submitted='+(report.write?.submitted||false),
  'artworkPresent='+(report.verification?.artworkPresent||false),
  'writeRetried=false',
  'blocked='+report.blocked.length,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
