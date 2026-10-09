import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const BASE='https://thetvdb.com';
const ID='9242991', SLUG='djilsi', SERIES='414993', CODE='S2018E02';
const OUT='reports/artwork-user192-canary-djilsi-s2018e02-v23-2';
await fs.mkdir(OUT,{recursive:true});
const armed=process.env.TVDB_USER192_CANARY_APPLY==='yes';
const user=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const report={createdAt:new Date().toISOString(),mode:'GUARDED_USER_APPROVED_TWO_STAGE_SINGLE_ARTWORK_CANARY',
  target:{creator:'Djilsi',code:CODE,id:ID,slug:SLUG,series:SERIES},
  armed,authenticated:false,checks:[],stage1:null,stage2:null,
  verification:null,blocked:[],outcome:'NOT_STARTED',siteDeleteCount:0,
  retries:0};
let browser;
function stop(s){throw new Error(s)}
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
 .replace(/[^a-z0-9]+/gi,' ').toLowerCase().trim().replace(/\s+/g,' ');
const artUrls=html=>[...new Set([...html.matchAll(
 /https:\/\/artworks\.thetvdb\.com\/[^"'<> \n]+\/episode\/\d+\/screencap\/[^"'<> \n]+/g
 )].map(x=>x[0].replace(/&amp;/g,'&')))];
async function go(page,url){
 const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 const status=response?.status();
 if(!response||![200,201].includes(status))stop('STOP_SITE_HTTP_'+status);
 if(/\/auth\/login/.test(page.url())&& !/\/auth\/login/.test(url))stop('STOP_AUTH_REDIRECT');
 const body=(await page.locator('body').innerText().catch(()=>''))||'';
 if(/captcha|verify you are human|your account (?:is|has been) (?:suspended|restricted)|artwork privileges.*(?:removed|disabled)|access denied|rate limit|checking your browser/i.test(body.slice(0,5500)))
   stop('STOP_ACCOUNT_RESTRICTION_OR_CHALLENGE');
 return body;
}
try{
 if(!armed)stop('NOT_ARMED');
 if(!user||!password)stop('MISSING_GITHUB_SECRETS');
 const approvals=JSON.parse(await fs.readFile('reports/artwork-user-approvals-v23-2-2026-10-09.json','utf8'));
 const proofs=JSON.parse(await fs.readFile('reports/artwork-user192-source-preflight-v23-2/report.json','utf8'));
 const live=JSON.parse(await fs.readFile('reports/artwork-user192-live-preflight-v23-2/report.json','utf8'));
 const x=approvals.targets.find(t=>t.creator==='Djilsi'&&t.code===CODE&&t.tvdbEpisodeId===ID);
 const source=proofs.rows.find(t=>t.tvdbEpisodeId===ID);
 const l=live.checked.find(t=>t.id===ID);
 if(!x||!x.userApproved||!x.provenanceVerified||x.requested!=='ADD_ONLY_IF_CURRENTLY_MISSING'||
   !source||!source.result.startsWith('TECHNICALLY_VALID')||!source.fileSha256||
   !l||l.status!=='STILL_MISSING_IDENTITY_VERIFIED')stop('SOURCE_OR_USER_APPROVAL_PREFLIGHT_MISSING');
 if(l.availableUploadLinks?.length!==1||l.availableUploadLinks[0]!==
   BASE+'/artwork/upload?type=11&episode='+ID+'&series='+SERIES)stop('LIVE_UPLOAD_LINK_DRIFT');
 const expectedImage='https://i.ytimg.com/vi/k1blyDB6xj4/maxres2.jpg';
 if(x.selectedImageUrl!==expectedImage||x.youtubeId!=='k1blyDB6xj4'||
    source.selectedImageUrl!==expectedImage||source.width!==1280||source.height!==720)
   stop('IMMUTABLE_ARTWORK_SOURCE_DRIFT');
 report.target={...report.target,youtubeId:x.youtubeId,url:x.selectedImageUrl,title:x.episodeTitle};
 report.checks.push({name:'USER_APPROVED_URL_MATCHES_SOURCE_AND_PRIOR_LIVE_PROOF',ok:true,
  fileSha256:source.fileSha256});

 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({locale:'fr-FR'});
 const page=await context.newPage();
 await go(page,BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 if(await lf.count()!==1)stop('AUTH_FORM_MISSING');
 await lf.locator('input[name="email"]').fill(user);
 await lf.locator('input[name="password"]').fill(password);
 await lf.locator('button[type="submit"],input[type="submit"]').first().click();
 await page.waitForLoadState('domcontentloaded').catch(()=>{});
 const auth=await context.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
 const authInfo=await auth?.json().catch(()=>null);
 if(!auth?.ok()||!authInfo||!Object.keys(authInfo).length)stop('AUTH_NOT_VERIFIED');
 report.authenticated=true;
 await go(page,BASE+'/series/'+SLUG+'/episodes/'+ID);
 const title=(await page.locator('h1,h2').allTextContents()).map(s=>s.trim()).find(Boolean)||'';
 const before=artUrls(await page.content());
 if(norm(title)!==norm(x.episodeTitle))stop('STOP_TITLE_IDENTITY_DRIFT');
 if(before.length){report.outcome='ALREADY_PRESENT_NO_WRITE';report.verification={before};}
 else{
  const ir=await context.request.get(x.selectedImageUrl,{timeout:30000});
  if(ir.status()!==200||!(ir.headers()['content-type']||'').startsWith('image/'))stop('SOURCE_IMAGE_HTTP_INVALID_'+ir.status());
  const imageBytes=await ir.body();
  const actualHash=createHash('sha256').update(imageBytes).digest('hex');
  if(imageBytes.length<12000||actualHash!==source.fileSha256)stop('SOURCE_IMAGE_HASH_DRIFT');
  report.checks.push({name:'LIVE_SOURCE_BYTES_MATCH_CERTIFIED_SHA256',ok:true,
    size:imageBytes.length,sha256:actualHash,editorialReview:'VISUALLY_CLEAN_FRAME_INSPECTED'});
  const allowedPosts=new Set(['/artwork/upload_handler']);
  let unexpectedRequest=null;
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),method=req.method().toUpperCase();
   if(u.origin===BASE&&!['GET','HEAD','OPTIONS'].includes(method)&&
     !(method==='POST'&&allowedPosts.has(u.pathname))){
       unexpectedRequest=method+' '+u.pathname;return route.abort('blockedbyclient');
     }
   return route.continue();
  });
  await go(page,BASE+'/artwork/upload?type=11&episode='+ID+'&series='+SERIES);
  const form=page.locator('form[action*="/artwork/upload_handler"]').first();
  if(await form.count()!==1)stop('UPLOAD_FORM_MISSING_OR_RESTRICTED');
  const vals={};
  for(const name of ['episode','series','type'])vals[name]=await form.locator('input[name="'+name+'"]').inputValue();
  if(vals.episode!==ID||vals.series!==SERIES||vals.type!=='11'||
      await form.getAttribute('action')!=='/artwork/upload_handler')stop('UPLOAD_FORM_SCOPE_DRIFT');
  await form.locator('input[name="file"]').setInputFiles({name:'k1blyDB6xj4-maxres2.jpg',
    mimeType:'image/jpeg',buffer:imageBytes});
  const resp1P=page.waitForResponse(r=>r.request().method()==='POST'&&
    new URL(r.url()).pathname==='/artwork/upload_handler',{timeout:60000});
  await form.locator('#artwork-continue-button,button[type="submit"]').first().click();
  const resp1=await resp1P;
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  const body1=((await page.locator('body').innerText().catch(()=>''))||'').slice(0,1500);
  report.stage1={http:resp1.status(),url:page.url(),body:body1};
  if(unexpectedRequest)stop('UNEXPECTED_WRITE_'+unexpectedRequest);
  if(resp1.status()===202||resp1.status()===401||resp1.status()===403||
     resp1.status()===429||resp1.status()>=400)stop('UPLOAD_STAGE1_DENIED_'+resp1.status());
  if(/captcha|verify you are human|account.*(?:restricted|suspended)|access denied/i.test(body1))
    stop('UPLOAD_STAGE1_RESTRICTION');
  if(page.url()!==BASE+'/artwork/upload_handler')stop('STAGE1_DESTINATION_DRIFT');
  const crop=page.locator('form[action="/artwork/upload_cropper_handler"]').first();
  if(await crop.count()!==1)stop('CROPPER_FORM_ABSENT_DO_NOT_RESUBMIT');
  const formVals={};
  for(const name of ['id','x','y','width','height','scaleX','scaleY']){
    const el=crop.locator('input[name="'+name+'"]');
    formVals[name]=await el.count()?await el.inputValue():null;
  }
  report.crop={...formVals};
  if(!/^\d+$/.test(String(formVals.id))||formVals.x!=='0'||formVals.y!=='0'||
    formVals.width!=='1280'||formVals.height!=='720'||
    formVals.scaleX!=='1'||formVals.scaleY!=='1')stop('CROP_SCOPE_UNEXPECTED_DO_NOT_RETRY');
  allowedPosts.add('/artwork/upload_cropper_handler');
  const resp2P=page.waitForResponse(r=>r.request().method()==='POST'&&
   new URL(r.url()).pathname==='/artwork/upload_cropper_handler',{timeout:60000});
  await crop.locator('button[type="submit"]').first().click();
  const resp2=await resp2P;
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  const body2=((await page.locator('body').innerText().catch(()=>''))||'').slice(0,1900);
  report.stage2={http:resp2.status(),url:page.url(),body:body2};
  if(unexpectedRequest)stop('UNEXPECTED_WRITE_'+unexpectedRequest);
  if(resp2.status()===202||resp2.status()===401||resp2.status()===403||
     resp2.status()===429||resp2.status()>=400)stop('UPLOAD_STAGE2_DENIED_'+resp2.status());
  if(!/artwork successfully added/i.test(body2)){
    report.outcome='FINALIZED_UNCONFIRMED_DO_NOT_RETRY';
    stop('NO_SUCCESS_MESSAGE');
  }
  let after=[];
  const observations=[];
  for(const pause of [0,2500,5000]){
    if(pause)await page.waitForTimeout(pause);
    await go(page,BASE+'/series/'+SLUG+'/episodes/'+ID);
    after=artUrls(await page.content());
    observations.push({at:new Date().toISOString(),count:after.length,images:after});
    if(after.length)break;
  }
  report.verification={observations,after,artworkPersisted:after.length>0};
  report.outcome=after.length?'APPLIED_AND_VERIFIED':'FINALIZED_PENDING_MODERATION_DO_NOT_RETRY';
 }
}catch(e){
 report.blocked.push({reason:String(e?.message||e)});
 if(report.outcome==='NOT_STARTED')report.outcome=report.stage2?
    'SUBMITTED_NEEDS_POSTCHECK_NO_RETRY':report.stage1?
    'STAGE1_STARTED_NO_RETRY':'BLOCKED_BEFORE_ANY_UPLOAD';
}finally{await browser?.close().catch(()=>{});}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({outcome:report.outcome,authenticated:report.authenticated,
 stage1:report.stage1?.http,stage2:report.stage2?.http,
 persisted:report.verification?.artworkPersisted??false,blocks:report.blocked}));
if(!['APPLIED_AND_VERIFIED','ALREADY_PRESENT_NO_WRITE'].includes(report.outcome))process.exitCode=2;
