import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MAXIME_TEMP_FINALIZE||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com';
const X={
  slug:'maxime-biaggi',series:'475945',episodeId:'11696654',code:'S2025E18',
  title:'LE JEU DE LA NOTE (ft Billy, Grim, Elian, Djilsi)',
  tempId:'2329750',
  incoming:'https://artworks.thetvdb.com/incoming/6ac6780519205.jpeg'
};
const OUT='reports/maxime-s2025e18-temp-finalize-2026-10-07';
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'GUARDED_TEMP_ARTWORK_FINALIZE_NO_REUPLOAD',authenticated:false,target:X,preflight:{},post:null,verification:null,blocked:[],result:'NOT_STARTED'};

function norm(s){return String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function artUrls(html){return [...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];}
async function go(p,url){let r=null;for(let i=0;i<3;i++){r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await p.waitForTimeout(500);return r;}await p.waitForTimeout(500*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}

try{
  await go(page,BASE+'/auth/login');
  const lf=page.locator('form[action="/auth/login"]').first();
  const loginToken=await lf.locator('input[name="_token"]').inputValue();
  const loginResp=await context.request.post(BASE+'/auth/login',{form:{_token:loginToken,redirectTo:'',email:username,password,remember:'1'},maxRedirects:0});
  if(loginResp.status()!==302) throw new Error('LOGIN_POST_'+loginResp.status());
  report.authenticated=(await context.cookies(BASE)).some(c=>c.name==='TVDB_AUTHENTICATED');
  if(!report.authenticated) throw new Error('AUTH_COOKIE_MISSING');

  await go(page,BASE+'/series/'+X.slug+'/episodes/'+X.episodeId);
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  const before=artUrls(await page.content());
  report.preflight.heading=heading;
  report.preflight.beforeArtwork=before;
  if(norm(heading)!==norm(X.title)) throw new Error('TITLE_DRIFT expected='+X.title+' actual='+heading);
  if(before.length){
    report.verification={artworkPresent:true,artwork:before};
    report.result='ALREADY_PRESENT_NO_WRITE';
  } else {
    const temp=await context.newPage();
    let tempStatus=null,tempDims={w:null,h:null};
    try{
      const rr=await temp.goto(X.incoming,{waitUntil:'load',timeout:30000}).catch(()=>null);
      tempStatus=rr?.status()??null;
      if(tempStatus===200) tempDims=await temp.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight}));
    } finally { await temp.close(); }
    report.preflight.tempImage={url:X.incoming,status:tempStatus,width:tempDims.w,height:tempDims.h};
    if(tempStatus!==200||tempDims.w!==1280||tempDims.h!==720) throw new Error('TEMP_IMAGE_NOT_PROVEN_1280X720');

    await go(page,BASE+'/artwork/upload?type=11&episode='+X.episodeId+'&series='+X.series);
    const upload=page.locator('form[action="/artwork/upload_handler"]').first();
    if(!(await upload.count())) throw new Error('UPLOAD_FORM_MISSING');
    const episode=await upload.locator('input[name="episode"]').inputValue();
    const series=await upload.locator('input[name="series"]').inputValue();
    const type=await upload.locator('input[name="type"]').inputValue();
    const token=await upload.locator('input[name="_token"]').inputValue();
    report.preflight.scope={episode,series,type,tokenPresent:!!token};
    if(episode!==X.episodeId||series!==X.series||type!=='11'||!token) throw new Error('UPLOAD_SCOPE_OR_TOKEN_DRIFT');

    const post=await context.request.post(BASE+'/artwork/upload_cropper_handler',{
      form:{_token:token,id:X.tempId,x:'0',y:'0',width:'1280',height:'720',scaleX:'1',scaleY:'1'},
      maxRedirects:0
    });
    report.post={status:post.status(),location:post.headers()['location']||null};
    if(post.status()!==302) throw new Error('FINALIZE_POST_'+post.status());

    await go(page,BASE+'/series/'+X.slug+'/episodes/'+X.episodeId);
    const after=artUrls(await page.content());
    const body=(await page.locator('body').innerText().catch(()=>'' )).replace(/\s+/g,' ');
    report.verification={artworkPresent:after.length>0,artwork:after,successMessage:/Artwork successfully added\./i.test(body)};
    if(!after.length) throw new Error('FINALIZE_RETURNED_302_BUT_ARTWORK_MISSING');
    report.result='TEMP_FINALIZED_AND_VERIFIED';
  }
}catch(e){
  report.blocked.push({reason:String(e?.stack||e)});
  if(report.result==='NOT_STARTED') report.result=report.post?'FINALIZE_AMBIGUOUS_DO_NOT_RETRY':'BLOCKED_BEFORE_FINALIZE';
}finally{
  await browser.close();
}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'result='+report.result,
  'artworkPresent='+(report.verification?.artworkPresent??false),
  'postStatus='+(report.post?.status??'n/a'),
  'blocked='+report.blocked.length
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!['TEMP_FINALIZED_AND_VERIFIED','ALREADY_PRESENT_NO_WRITE'].includes(report.result)) process.exitCode=2;
