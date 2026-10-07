import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');

const BASE='https://thetvdb.com';
const SLUG='338282-show';
const SERIES='338282';
const X={id:'12023296',code:'S2015E01',title:'GROSSE ANNONCE',youtubeId:'fttKpTYRdMs'};
const OUT='reports/mcfly-grosse-annonce-artwork-preflight';
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const page=await context.newPage();
let readOnly=false;
const blocked=[];
await context.route('**/*',async route=>{
  const req=route.request(),method=req.method().toUpperCase();
  if(readOnly && /thetvdb\.com/i.test(req.url()) && !['GET','HEAD','OPTIONS'].includes(method)){
    blocked.push({method,url:req.url()});return route.abort('blockedbyclient');
  }
  return route.continue();
});
async function go(p,u){
  const r=await p.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  await p.waitForTimeout(350);
  if(!r||r.status()>=400) throw new Error('GET '+u+' '+(r?.status()??'n/a'));
  return r;
}
function artUrls(html){return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));}

const report={generatedAt:new Date().toISOString(),target:'Mcfly & Carlito '+X.code,mode:'READ_ONLY_ARTWORK_PREFLIGHT',authenticated:false,episode:null,thumbnailVariants:[],uploadForm:null,blocked:[],result:'NOT_STARTED'};
try{
  await go(page,BASE+'/auth/login');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);
  await lf.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(700);
  const probe=await context.request.get(BASE+'/auth/getuser');
  report.authenticated=probe.ok();
  if(!report.authenticated) throw new Error('Auth not proven');
  readOnly=true;

  await go(page,BASE+'/series/'+SLUG+'/episodes/'+X.id);
  const html=await page.content();
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
  const artwork=artUrls(html);
  report.episode={heading,artwork,bodyPreview:body.slice(0,1200)};
  if(heading!==X.title) report.blocked.push({reason:'TITLE_DRIFT',heading});
  if(artwork.length) report.blocked.push({reason:'ARTWORK_ALREADY_PRESENT',artwork});

  for(const variant of ['maxresdefault','sddefault','hqdefault']){
    const p=await context.newPage();
    const url='https://i.ytimg.com/vi/'+X.youtubeId+'/'+variant+'.jpg';
    try{
      const r=await p.goto(url,{waitUntil:'load',timeout:30000});
      const dim=await p.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight})).catch(()=>({w:null,h:null}));
      report.thumbnailVariants.push({variant,url,status:r?.status()??null,width:dim.w,height:dim.h,ratio:dim.w&&dim.h?Number((dim.w/dim.h).toFixed(4)):null,usable16x9:Boolean(dim.w>=640&&dim.h>=360&&Math.abs(dim.w/dim.h-16/9)<0.03)});
    }catch(e){report.thumbnailVariants.push({variant,url,error:String(e?.message||e)});}
    finally{await p.close();}
  }
  const chosen=report.thumbnailVariants.find(v=>v.usable16x9);
  if(!chosen) report.blocked.push({reason:'NO_USABLE_16X9_OFFICIAL_THUMBNAIL'});

  await go(page,BASE+'/artwork/upload?type=11&episode='+X.id+'&series='+SERIES);
  const f=page.locator('form[action*="/artwork/upload_handler"]').first();
  if(!(await f.count())) report.blocked.push({reason:'UPLOAD_FORM_MISSING'});
  else{
    report.uploadForm={
      action:await f.getAttribute('action'),
      episode:await f.locator('input[name="episode"]').inputValue(),
      series:await f.locator('input[name="series"]').inputValue(),
      type:await f.locator('input[name="type"]').inputValue(),
      hasUrl:await f.locator('input[name="url"]').count()>0
    };
    if(report.uploadForm.episode!==X.id||report.uploadForm.series!==SERIES||report.uploadForm.type!=='11'||!report.uploadForm.hasUrl){
      report.blocked.push({reason:'UPLOAD_FORM_SCOPE_DRIFT',actual:report.uploadForm});
    }
  }

  report.chosenThumbnail=chosen||null;
  report.result=report.blocked.length?'BLOCKED':'PREFLIGHT_PASSED_ZERO_WRITES';
}catch(e){
  report.blocked.push({reason:String(e?.stack||e)});
  report.result='BLOCKED_ERROR';
}finally{
  report.readOnlyNetworkLock=true;
  report.blockedNonReadRequests=blocked;
  await browser.close();
}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'artworkPresent='+(report.episode?.artwork?.length||0),
  'usable16x9='+report.thumbnailVariants.filter(x=>x.usable16x9).length,
  'blocked='+report.blocked.length,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='PREFLIGHT_PASSED_ZERO_WRITES') process.exitCode=2;
