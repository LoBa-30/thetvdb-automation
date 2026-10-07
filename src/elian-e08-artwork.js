import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_E08_ARTWORK||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',SERIES='462729',OUT='reports/elian-e08-artwork-2026-10-07';
const X={episodeId:'12014528',code:'S2026E08',title:"On s'affronte pour construire la meilleure cabane ! ft. Maxime Biaggi",youtubeId:'xkGjW_FR8vI',imageUrl:'https://i.ytimg.com/vi/xkGjW_FR8vI/maxresdefault.jpg'};

const refresh=JSON.parse(await fs.readFile('reports/elian-e08-title-refresh/report.json','utf8'));
if(refresh.youtubeId!==X.youtubeId||refresh.verification?.title!==X.title||refresh.result!=='APPLIED_AND_VERIFIED') throw new Error('Prior exact identity proof drift');

await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'GUARDED_ELIAN_E08_ARTWORK',authenticated:false,target:X,preflight:{},stage1:null,crop:null,stage2:null,verification:null,blocked:[],result:'NOT_STARTED'};
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
  report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();if(!report.authenticated)throw new Error('Auth not proven');

  await go(BASE+'/series/'+SLUG+'/episodes/'+X.episodeId);
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null,before=artUrls(await page.content());
  report.preflight.heading=heading;report.preflight.beforeArtwork=before;
  if(norm(heading)!==norm(X.title))throw new Error('TITLE_NOT_CURRENT_EXACT');
  if(before.length){report.verification={artworkPresent:true,artwork:before};report.result='ALREADY_PRESENT_NO_WRITE';throw new Error('ALREADY_PRESENT');}

  const q=await context.newPage();let dims={w:null,h:null},status=null;
  try{const rr=await q.goto(X.imageUrl,{waitUntil:'load',timeout:30000});status=rr?.status()??null;dims=await q.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight}));}finally{await q.close();}
  const ir=await context.request.get(X.imageUrl),buf=await ir.body(),ctype=ir.headers()['content-type']||'';
  report.preflight.image={url:X.imageUrl,status,width:dims.w,height:dims.h,contentType:ctype,bytes:buf.length};
  if(status!==200||dims.w!==1280||dims.h!==720||!ir.ok()||!/^image\//i.test(ctype)||buf.length<10000)throw new Error('NO_CLEAN_1280X720_OFFICIAL_IMAGE');

  await go(BASE+'/artwork/upload?type=11&episode='+X.episodeId+'&series='+SERIES);
  const upload=page.locator('form[action="/artwork/upload_handler"]').first();if(!(await upload.count()))throw new Error('UPLOAD_FORM_MISSING');
  const uc=await ctrls(upload),uv=n=>uc.find(c=>c.name===n)?.value??null;if(uv('episode')!==X.episodeId||uv('series')!==SERIES||uv('type')!=='11')throw new Error('UPLOAD_SCOPE_DRIFT');
  await upload.locator('input[name="file"]').setInputFiles({name:X.youtubeId+'.jpg',mimeType:'image/jpeg',buffer:buf});
  const p1=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),upload.locator('#artwork-continue-button,button[type="submit"]').first().click()]);
  const r1=await p1;await page.waitForTimeout(700);report.stage1={status:r1?.status()??null};if(!r1||r1.status()>=400)throw new Error('STAGE1_FAILED');

  const crop=page.locator('form[action="/artwork/upload_cropper_handler"]').first();if(!(await crop.count()))throw new Error('CROP_FORM_MISSING');
  const cc=await ctrls(crop),cv=n=>cc.find(c=>c.name===n)?.value??null;const scope={id:cv('id'),x:cv('x'),y:cv('y'),width:cv('width'),height:cv('height'),scaleX:cv('scaleX'),scaleY:cv('scaleY')};
  const src=await page.locator('img#cropper').first().getAttribute('src').catch(()=>null);report.crop={...scope,cropImageSrc:src};
  if(!/^\d+$/.test(String(scope.id||''))||scope.x!=='0'||scope.y!=='0'||scope.width!=='1280'||scope.height!=='720'||scope.scaleX!=='1'||scope.scaleY!=='1'||!src||!/artworks\.thetvdb\.com\/incoming\//.test(src))throw new Error('CROP_SCOPE_INVALID');

  const finish=crop.locator('button[type="submit"]').filter({hasText:'Finish'}).first();if(!(await finish.count())||await finish.isDisabled())throw new Error('FINISH_UNAVAILABLE');
  const p2=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_cropper_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),finish.click()]);
  const r2=await p2;await page.waitForTimeout(700);const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');report.stage2={status:r2?.status()??null,successMessage:/Artwork successfully added\./i.test(body)};
  if(!r2||![200,302].includes(r2.status())||!report.stage2.successMessage)throw new Error('STAGE2_NOT_CONFIRMED');

  await go(BASE+'/series/'+SLUG+'/episodes/'+X.episodeId);const after=artUrls(await page.content());report.verification={artworkPresent:after.length>0,artwork:after};if(!after.length)throw new Error('POST_WRITE_ARTWORK_MISSING');
  report.result='APPLIED_AND_VERIFIED';
}catch(e){if(String(e?.message||e)!=='ALREADY_PRESENT')report.blocked.push({reason:String(e?.stack||e)});if(report.result==='NOT_STARTED')report.result=report.stage2?'FAILED_AFTER_FINALIZE_DO_NOT_RETRY':(report.stage1?'STAGE1_ONLY_STOP_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE');}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'result='+report.result,'artworkPresent='+(report.verification?.artworkPresent??false),'blocked='+report.blocked.length].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','ALREADY_PRESENT_NO_WRITE','BLOCKED_BEFORE_WRITE'].includes(report.result))process.exitCode=2;
