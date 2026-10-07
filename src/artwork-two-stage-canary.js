import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ARTWORK_CROP_CANARY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com';
const X={
  target:'Elian Ventre',
  slug:'elian-ventre-462729',
  series:'462729',
  id:'11092257',
  code:'S2024E04',
  title:'4 anecdotes FOLLES sur mon parcours à l’ARMÉE !',
  youtubeId:'U6DoBQQk4OE',
  imageUrl:'https://i.ytimg.com/vi/U6DoBQQk4OE/maxresdefault.jpg'
};
const OUT='reports/artwork-two-stage-canary-2026-10-07';
await fs.mkdir(OUT,{recursive:true});

const prior=JSON.parse(await fs.readFile('reports/elian-artwork-batch-preflight/report.json','utf8'));
const planned=prior.planned?.find(p=>p.id===X.id);
if(!planned||planned.youtubeId!==X.youtubeId||planned.imageUrl!==X.imageUrl||planned.width!==1280||planned.height!==720){
  throw new Error('Prior exact artwork preflight missing or drifted');
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={
  generatedAt:new Date().toISOString(),
  mode:'GUARDED_TWO_STAGE_ARTWORK_CANARY',
  armed,
  authenticated:false,
  target:X,
  preflight:{},
  stage1:null,
  cropForm:null,
  stage2:null,
  verification:null,
  blocked:[],
  blockedNonReadRequests:[],
  result:'NOT_STARTED'
};

function norm(s){return String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();}
function artUrls(html){return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));}
async function go(url){
  let r=null;
  for(let i=0;i<3;i++){
    r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(r&&r.status()<400){await page.waitForTimeout(500);return r;}
    await page.waitForTimeout(600*(i+1));
  }
  throw new Error('GET '+url+' '+(r?.status()??'n/a'));
}
async function formSnapshot(locator){
  return locator.evaluate(f=>({
    action:f.getAttribute('action'),
    method:f.getAttribute('method'),
    enctype:f.getAttribute('enctype'),
    text:(f.innerText||'').replace(/\s+/g,' ').trim(),
    controls:[...f.querySelectorAll('input,select,textarea')].map(el=>({
      tag:el.tagName.toLowerCase(),
      type:el.getAttribute('type'),
      name:el.getAttribute('name'),
      value:el.value ?? el.getAttribute('value'),
      required:el.required||false,
      checked:'checked' in el?el.checked:undefined,
      accept:el.getAttribute('accept')
    })),
    buttons:[...f.querySelectorAll('button,input[type="submit"]')].map(el=>({
      tag:el.tagName.toLowerCase(),
      type:el.getAttribute('type'),
      name:el.getAttribute('name'),
      value:el.getAttribute('value'),
      text:(el.textContent||'').trim(),
      disabled:!!el.disabled
    }))
  }));
}

try{
  await go(BASE+'/auth/login');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);
  await lf.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(()=>{}),
    lf.locator('button[type="submit"],input[type="submit"]').first().click()
  ]);
  await page.waitForTimeout(700);
  const probe=await context.request.get(BASE+'/auth/getuser');
  report.authenticated=probe.ok();
  if(!report.authenticated) throw new Error('Authentication not proven');

  await go(BASE+'/series/'+X.slug+'/episodes/'+X.id);
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  const before=artUrls(await page.content());
  if(norm(heading)!==norm(X.title)) throw new Error('Title drift: '+heading);
  if(before.length){
    report.preflight={heading,beforeArtwork:before};
    report.result='ALREADY_PRESENT_NO_WRITE';
    throw new Error('ALREADY_PRESENT');
  }

  const ir=await context.request.get(X.imageUrl);
  const buf=await ir.body();
  const ctype=ir.headers()['content-type']||'';
  report.preflight={heading,beforeArtwork:before,imageUrl:X.imageUrl,imageStatus:ir.status(),contentType:ctype,bytes:buf.length,width:planned.width,height:planned.height};
  if(!ir.ok()||!/^image\//i.test(ctype)||buf.length<10000) throw new Error('Image fetch invalid');

  let allowedPostPaths=new Set(['/artwork/upload_handler']);
  await context.route('**/*',async route=>{
    const req=route.request(),m=req.method().toUpperCase(),u=new URL(req.url());
    if(u.origin===BASE&&m==='POST'&&!allowedPostPaths.has(u.pathname)){
      report.blockedNonReadRequests.push({method:m,url:req.url()});
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  await go(BASE+'/artwork/upload?type=11&episode='+X.id+'&series='+X.series);
  const upload=page.locator('form[action*="/artwork/upload_handler"]').first();
  if(!(await upload.count())) throw new Error('Initial artwork form missing');
  const uploadSnap=await formSnapshot(upload);
  const value=(name)=>uploadSnap.controls.find(c=>c.name===name)?.value ?? null;
  if(uploadSnap.action!=='/artwork/upload_handler'||value('episode')!==X.id||value('series')!==X.series||value('type')!=='11') throw new Error('Initial form scope drift');
  await upload.locator('input[name="file"]').setInputFiles({name:X.youtubeId+'.jpg',mimeType:'image/jpeg',buffer:buf});

  const firstRespPromise=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(()=>{}),
    upload.locator('#artwork-continue-button,button[type="submit"],input[type="submit"]').first().click()
  ]);
  const firstResp=await firstRespPromise;
  await page.waitForTimeout(900);
  const firstText=firstResp?await firstResp.text().catch(()=>''):'';
  report.stage1={
    postStatus:firstResp?.status()??null,
    postOk:firstResp?.ok()??null,
    responseUrl:firstResp?.url()??null,
    pageUrl:page.url(),
    title:await page.title(),
    bodyText:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,6000),
    responsePreview:firstText.replace(/\s+/g,' ').slice(0,4000)
  };
  if(!firstResp||firstResp.status()>=400) throw new Error('Stage1 upload handler failed');

  const forms=page.locator('form');
  const count=await forms.count();
  let crop=null,cropSnap=null;
  for(let i=0;i<count;i++){
    const cand=forms.nth(i);
    const snap=await formSnapshot(cand);
    if(snap.action==='/artwork/upload_cropper_handler'){
      crop=cand;cropSnap=snap;break;
    }
  }
  if(!crop||!cropSnap){
    const all=[];
    for(let i=0;i<count;i++) all.push(await formSnapshot(forms.nth(i)));
    report.cropForm={found:false,forms:all};
    throw new Error('Expected /artwork/upload_cropper_handler form not found');
  }

  const actionUrl=new URL(cropSnap.action,BASE);
  const cv=(name)=>cropSnap.controls.find(c=>c.name===name)?.value ?? null;
  const cropId=cv('id');
  const cropScope={
    id:cropId,
    x:cv('x'),
    y:cv('y'),
    width:cv('width'),
    height:cv('height'),
    scaleX:cv('scaleX'),
    scaleY:cv('scaleY')
  };
  const cropImageSrc=await page.locator('img#cropper').first().getAttribute('src').catch(()=>null);
  report.cropForm={found:true,...cropSnap,resolvedAction:actionUrl.pathname,cropScope,cropImageSrc,provenance:'TEMP_CROP_PAGE_CREATED_BY_STAGE1_IN_SAME_AUTHENTICATED_SESSION'};
  if(actionUrl.origin!==BASE||actionUrl.pathname!=='/artwork/upload_cropper_handler') throw new Error('Unexpected second-stage action '+actionUrl.pathname);
  if(!/^\\d+$/.test(String(cropId||''))) throw new Error('Missing numeric temporary artwork id');
  if(cropScope.x!=='0'||cropScope.y!=='0'||cropScope.width!=='1280'||cropScope.height!=='720'||cropScope.scaleX!=='1'||cropScope.scaleY!=='1'){
    throw new Error('Unexpected crop scope '+JSON.stringify(cropScope));
  }
  const stage1Body=report.stage1?.bodyText||'';
  if(!/Adjust Image/i.test(stage1Body)||!/Finish/i.test(stage1Body)) throw new Error('Crop page identity not proven');
  const submit=crop.locator('button[type="submit"],input[type="submit"]').filter({hasText:'Finish'}).first();
  if(!(await submit.count())||await submit.isDisabled()) throw new Error('Finish submit unavailable');

  report.cropForm.provenance='TEMP_ID_CREATED_BY_STAGE1_IN_SAME_AUTHENTICATED_SESSION';
  allowedPostPaths.add(actionUrl.pathname);

  const secondRespPromise=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname===actionUrl.pathname&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(()=>{}),
    submit.click()
  ]);
  const secondResp=await secondRespPromise;
  await page.waitForTimeout(1000);
  const secondText=secondResp?await secondResp.text().catch(()=>''):'';
  report.stage2={
    postStatus:secondResp?.status()??null,
    postOk:secondResp?.ok()??null,
    responseUrl:secondResp?.url()??null,
    pageUrl:page.url(),
    title:await page.title(),
    bodyText:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,6000),
    responsePreview:secondText.replace(/\s+/g,' ').slice(0,4000)
  };
  if(!secondResp||secondResp.status()>=400) throw new Error('Stage2 artwork finalize failed');

  const reads=[];let after=[];
  for(const delay of [0,3000,10000,30000,60000]){
    if(delay) await page.waitForTimeout(delay);
    await go(BASE+'/series/'+X.slug+'/episodes/'+X.id);
    after=artUrls(await page.content());
    reads.push({at:new Date().toISOString(),artworkCount:after.length,artwork:after});
    if(after.length) break;
  }
  report.verification={reads,artworkPresent:after.length>0,artwork:after};
  report.result=after.length?'APPLIED_AND_VERIFIED_TWO_STAGE':'FINALIZED_VERIFICATION_PENDING_DO_NOT_RETRY';
}catch(e){
  if(String(e?.message||e)!=='ALREADY_PRESENT') report.blocked.push({reason:String(e?.stack||e)});
  if(report.result==='NOT_STARTED') report.result=report.stage2?'FINALIZED_REVIEW_REQUIRED_DO_NOT_RETRY':(report.stage1?'STAGE1_COMPLETE_STAGE2_BLOCKED_NO_RETRY':'BLOCKED_BEFORE_WRITE');
}finally{
  await browser.close();
}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'stage1Status='+(report.stage1?.postStatus??'n/a'),
  'cropFormFound='+(report.cropForm?.found??false),
  'stage2Status='+(report.stage2?.postStatus??'n/a'),
  'artworkPresent='+(report.verification?.artworkPresent??false),
  'blocked='+report.blocked.length,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED_TWO_STAGE','FINALIZED_VERIFICATION_PENDING_DO_NOT_RETRY','ALREADY_PRESENT_NO_WRITE'].includes(report.result)) process.exitCode=2;
