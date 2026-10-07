import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_SD_ARTWORK||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',SERIES='462729',OUT='reports/elian-sd-artwork-recovery-2026-10-07';
const TARGETS=[
 {episodeId:'11092249',code:'S2023E02',title:'RAP CONTENDERS ZEN ÉMISSION',youtubeId:'rDlPlsjuWXw',imageUrl:'https://i.ytimg.com/vi/rDlPlsjuWXw/sddefault.jpg'},
 {episodeId:'11665002',code:'S2026E02',title:'Son couple, ses projets, sa vie ft @Mastu',youtubeId:'jRU3jVvS8Wg',imageUrl:'https://i.ytimg.com/vi/jRU3jVvS8Wg/sddefault.jpg'}
];
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'GUARDED_ELIAN_SD_ARTWORK_RECOVERY',authenticated:false,results:[],stopped:false,stopReason:null,result:'NOT_STARTED'};

const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g,'').replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const artUrls=html=>[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];
async function go(url){let r=null;for(let i=0;i<3;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(450);return r;}await page.waitForTimeout(500*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}
async function ctrls(form){return form.locator('input,select,textarea').evaluateAll(els=>els.map(el=>({name:el.getAttribute('name'),value:el.value??el.getAttribute('value')})));}

try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(650);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated) throw new Error('Auth not proven');

 for(const t of TARGETS){
  const row={code:t.code,episodeId:t.episodeId,title:t.title,youtubeId:t.youtubeId,status:'NOT_STARTED',preflight:null,crop:null,verification:null,blocked:[]};
  report.results.push(row);
  try{
   await go(BASE+'/series/'+SLUG+'/episodes/'+t.episodeId);
   const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
   const before=artUrls(await page.content());
   row.preflight={heading,beforeArtwork:before};
   if(norm(heading)!==norm(t.title)) throw new Error('TITLE_DRIFT expected='+t.title+' actual='+heading);
   if(before.length){row.status='ALREADY_PRESENT_SKIP';row.verification={artworkPresent:true,artwork:before};continue;}

   const q=await context.newPage();let dims={w:null,h:null},imgStatus=null;
   try{const rr=await q.goto(t.imageUrl,{waitUntil:'load',timeout:30000});imgStatus=rr?.status()??null;dims=await q.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight}));}finally{await q.close();}
   const ir=await context.request.get(t.imageUrl),buf=await ir.body(),ctype=ir.headers()['content-type']||'';
   row.preflight.image={url:t.imageUrl,status:imgStatus,width:dims.w,height:dims.h,contentType:ctype,bytes:buf.length};
   if(imgStatus!==200||dims.w!==640||dims.h!==480||!ir.ok()||!/^image\//i.test(ctype)||buf.length<10000) throw new Error('SOURCE_SD_THUMBNAIL_NOT_EXACT_640X480');

   await go(BASE+'/artwork/upload?type=11&episode='+t.episodeId+'&series='+SERIES);
   const upload=page.locator('form[action="/artwork/upload_handler"]').first();if(!(await upload.count()))throw new Error('UPLOAD_FORM_MISSING');
   const uc=await ctrls(upload),uv=n=>uc.find(c=>c.name===n)?.value??null;
   if(uv('episode')!==t.episodeId||uv('series')!==SERIES||uv('type')!=='11')throw new Error('UPLOAD_SCOPE_DRIFT');
   await upload.locator('input[name="file"]').setInputFiles({name:t.youtubeId+'-sd.jpg',mimeType:'image/jpeg',buffer:buf});

   const p1=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
   await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),upload.locator('#artwork-continue-button,button[type="submit"]').first().click()]);
   const r1=await p1;await page.waitForTimeout(750);
   row.stage1={status:r1?.status()??null,pageUrl:page.url()};
   if(!r1||r1.status()>=400) throw new Error('STAGE1_FAILED');

   const crop=page.locator('form[action="/artwork/upload_cropper_handler"]').first();
   if(!(await crop.count())) throw new Error('CROP_FORM_MISSING');
   const cc=await ctrls(crop),cv=n=>cc.find(c=>c.name===n)?.value??null;
   const scope={id:cv('id'),x:cv('x'),y:cv('y'),width:cv('width'),height:cv('height'),scaleX:cv('scaleX'),scaleY:cv('scaleY')};
   const src=await page.locator('img#cropper').first().getAttribute('src').catch(()=>null);
   row.crop={...scope,cropImageSrc:src};
   if(!/^\d+$/.test(String(scope.id||''))||!src||!/artworks\.thetvdb\.com\/incoming\//.test(src)) throw new Error('CROP_TEMP_NOT_PROVEN');
   if(scope.width!=='640'||scope.height!=='360'||scope.scaleX!=='1'||scope.scaleY!=='1') throw new Error('CROP_NOT_SAFE_16X9 '+JSON.stringify(scope));
   const x=Number(scope.x),y=Number(scope.y);
   if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>0||y>120) throw new Error('CROP_COORDS_UNEXPECTED '+JSON.stringify(scope));

   const finish=crop.locator('button[type="submit"]').filter({hasText:'Finish'}).first();
   if(!(await finish.count())||await finish.isDisabled())throw new Error('FINISH_UNAVAILABLE');
   const p2=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_cropper_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
   await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),finish.click()]);
   const r2=await p2;await page.waitForTimeout(700);const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
   row.stage2={status:r2?.status()??null,successMessage:/Artwork successfully added\./i.test(body)};
   if(!r2||![200,302].includes(r2.status())||!row.stage2.successMessage)throw new Error('STAGE2_NOT_CONFIRMED');

   await go(BASE+'/series/'+SLUG+'/episodes/'+t.episodeId);
   const after=artUrls(await page.content());row.verification={artworkPresent:after.length>0,artwork:after};
   if(!after.length)throw new Error('POST_WRITE_ARTWORK_MISSING');
   row.status='APPLIED_AND_VERIFIED';
  }catch(e){
   row.blocked.push({reason:String(e?.message||e)});
   row.status=row.stage2?'FAILED_AFTER_FINALIZE_DO_NOT_RETRY':(row.stage1?'STAGE1_ONLY_STOP_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE');
   report.stopped=true;report.stopReason=t.code+': '+String(e?.message||e);break;
  }
 }
 report.summary={requested:TARGETS.length,processed:report.results.length,applied:report.results.filter(x=>x.status==='APPLIED_AND_VERIFIED').length,skipped:report.results.filter(x=>x.status==='ALREADY_PRESENT_SKIP').length,failed:report.results.filter(x=>x.blocked.length).length};
 report.result=report.stopped?'RECOVERY_STOPPED_ON_GUARD':'RECOVERY_COMPLETE';
}catch(e){report.fatal=String(e?.stack||e);report.result='FATAL_BEFORE_RECOVERY';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'requested='+TARGETS.length,'processed='+(report.summary?.processed??0),'applied='+(report.summary?.applied??0),'skipped='+(report.summary?.skipped??0),'failed='+(report.summary?.failed??0),'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='RECOVERY_COMPLETE')process.exitCode=2;
