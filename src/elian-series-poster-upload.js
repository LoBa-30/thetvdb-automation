import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_POSTER||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',SERIES='462729',OUT='reports/elian-series-poster-2026-10-07';
const POSTER='/tmp/elian-ventre-poster.jpg';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'GUARDED_ELIAN_SERIES_POSTER',authenticated:false,preflight:null,stage1:null,crop:null,stage2:null,verification:null,blocked:[],result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(600);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
async function ctrls(form){return form.locator('input,select,textarea').evaluateAll(els=>els.map(el=>({name:el.getAttribute('name'),value:el.value??el.getAttribute('value')})));}
function posterUrls(html){return [...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+series\/462729\/posters\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);
 await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated) throw new Error('Auth not proven');

 await go(BASE+'/series/'+SLUG);
 const before=posterUrls(await page.content());
 report.preflight={beforePosters:before,posterFile:POSTER};
 if(before.length){report.verification={posterPresent:true,posters:before};report.result='ALREADY_PRESENT_NO_WRITE';throw new Error('ALREADY_PRESENT');}

 const st=await fs.stat(POSTER);
 if(st.size<10000||st.size>10_000_000) throw new Error('POSTER_FILE_SIZE_INVALID '+st.size);

 await go(BASE+'/artwork/upload?type=2&series='+SERIES);
 const form=page.locator('form[action="/artwork/upload_handler"]').first();
 if(!(await form.count())) throw new Error('POSTER_UPLOAD_FORM_MISSING');
 const cc=await ctrls(form),cv=n=>cc.find(c=>c.name===n)?.value??null;
 if(cv('type')!=='2'||cv('series')!==SERIES) throw new Error('POSTER_SCOPE_DRIFT');
 await form.locator('select[name="language"]').selectOption('fra');
 await form.locator('input[name="file"]').setInputFiles({name:'elian-ventre-poster.jpg',mimeType:'image/jpeg',buffer:await fs.readFile(POSTER)});

 const p1=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.locator('button[type="submit"],input[type="submit"]').last().click()]);
 const r1=await p1; await page.waitForTimeout(800);
 report.stage1={status:r1?.status()??null,pageUrl:page.url(),body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,1600)};
 if(!r1||r1.status()>=400) throw new Error('STAGE1_FAILED');

 const crop=page.locator('form[action="/artwork/upload_cropper_handler"]').first();
 if(!(await crop.count())) throw new Error('CROP_FORM_MISSING');
 const kc=await ctrls(crop),kv=n=>kc.find(c=>c.name===n)?.value??null;
 const scope={id:kv('id'),x:kv('x'),y:kv('y'),width:kv('width'),height:kv('height'),scaleX:kv('scaleX'),scaleY:kv('scaleY')};
 const src=await page.locator('img#cropper').first().getAttribute('src').catch(()=>null);
 report.crop={...scope,cropImageSrc:src};
 if(!/^\d+$/.test(String(scope.id||''))||!src||!/artworks\.thetvdb\.com\/incoming\//.test(src)) throw new Error('CROP_TEMP_NOT_PROVEN');
 const w=Number(scope.width),h=Number(scope.height),x=Number(scope.x),y=Number(scope.y);
 if(!Number.isFinite(w)||!Number.isFinite(h)||Math.abs(w/h-0.68)>0.005) throw new Error('CROP_RATIO_INVALID '+JSON.stringify(scope));
 if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0) throw new Error('CROP_COORDS_INVALID '+JSON.stringify(scope));

 const finish=crop.locator('button[type="submit"]').filter({hasText:'Finish'}).first();
 if(!(await finish.count())||await finish.isDisabled()) throw new Error('FINISH_UNAVAILABLE');
 const p2=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_cropper_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),finish.click()]);
 const r2=await p2; await page.waitForTimeout(800);
 const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
 report.stage2={status:r2?.status()??null,successMessage:/Artwork successfully added\./i.test(body)};
 if(!r2||![200,302].includes(r2.status())||!report.stage2.successMessage) throw new Error('STAGE2_NOT_CONFIRMED');

 await go(BASE+'/series/'+SLUG);
 const after=posterUrls(await page.content());
 report.verification={posterPresent:after.length>0,posters:after};
 if(!after.length) throw new Error('POST_WRITE_POSTER_MISSING');
 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 if(String(e?.message||e)!=='ALREADY_PRESENT')report.blocked.push({reason:String(e?.stack||e)});
 if(report.result==='NOT_STARTED')report.result=report.stage2?'FAILED_AFTER_FINALIZE_DO_NOT_RETRY':(report.stage1?'STAGE1_ONLY_STOP_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE');
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,verification:report.verification,crop:report.crop,blocked:report.blocked},null,2));
if(!['APPLIED_AND_VERIFIED','ALREADY_PRESENT_NO_WRITE'].includes(report.result))process.exitCode=2;
