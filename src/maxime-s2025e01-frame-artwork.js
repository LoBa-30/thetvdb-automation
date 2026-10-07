import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MAXIME_FRAME_ARTWORK||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='maxime-biaggi',SERIES='475945',OUT='reports/maxime-s2025e01-frame-artwork-2026-10-07';
const X={episodeId:'11696637',code:'S2025E01',title:"2 jours pour faire une piste noire (j'ai jamais skié)",youtubeId:'EqFLIsSB2hg',url:'https://www.youtube.com/watch?v=EqFLIsSB2hg'};
await fs.mkdir(OUT,{recursive:true});
const VIDEO='/tmp/maxime-s2025e01.mp4',FRAME='/tmp/maxime-s2025e01-frame.jpg';

const report={generatedAt:new Date().toISOString(),mode:'GUARDED_MAXIME_FRAME_ARTWORK',target:X,authenticated:false,frame:null,preflight:null,crop:null,verification:null,blocked:[],result:'NOT_STARTED'};
const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g,'').replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const artUrls=html=>[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];
async function go(page,url){const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(500);if(!r||r.status()>=400)throw new Error('GET '+url+' '+(r?.status()??'n/a'));return r;}
async function ctrls(form){return form.locator('input,select,textarea').evaluateAll(els=>els.map(el=>({name:el.getAttribute('name'),value:el.value??el.getAttribute('value')})));}

try{
  execFileSync('yt-dlp',['--no-warnings','-f','best[height<=720][ext=mp4]/best[height<=720]','-o',VIDEO,X.url],{stdio:'inherit'});
  const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',VIDEO],{encoding:'utf8'}).trim());
  if(!Number.isFinite(duration)||duration<120) throw new Error('VIDEO_DURATION_INVALID');
  const timestamp=Math.max(60,Math.min(duration-60,duration*0.40));
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-ss',String(timestamp),'-i',VIDEO,'-frames:v','1','-vf','scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2','-q:v','2','-y',FRAME]);
  const dims=execFileSync('ffprobe',['-v','error','-show_entries','stream=width,height','-of','csv=p=0:s=x',FRAME],{encoding:'utf8'}).trim();
  const buf=await fs.readFile(FRAME);
  if(dims!=='1280x720'||buf.length<20000) throw new Error('FRAME_INVALID '+dims+' '+buf.length);
  report.frame={timestampSeconds:Number(timestamp.toFixed(3)),durationSeconds:Number(duration.toFixed(3)),dimensions:dims,bytes:buf.length,sha256:crypto.createHash('sha256').update(buf).digest('hex'),source:'official YouTube video frame'};

  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
  const page=await context.newPage();
  try{
    await go(page,BASE+'/auth/login');
    const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
    await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
    await page.waitForTimeout(650);
    report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();if(!report.authenticated)throw new Error('Auth not proven');

    await go(page,BASE+'/series/'+SLUG+'/episodes/'+X.episodeId);
    const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
    const before=artUrls(await page.content());report.preflight={heading,beforeArtwork:before};
    if(norm(heading)!==norm(X.title))throw new Error('TITLE_DRIFT');
    if(before.length){report.verification={artworkPresent:true,artwork:before};report.result='ALREADY_PRESENT_NO_WRITE';}
    else{
      await go(page,BASE+'/artwork/upload?type=11&episode='+X.episodeId+'&series='+SERIES);
      const upload=page.locator('form[action="/artwork/upload_handler"]').first();if(!(await upload.count()))throw new Error('UPLOAD_FORM_MISSING');
      const uc=await ctrls(upload),uv=n=>uc.find(c=>c.name===n)?.value??null;
      if(uv('episode')!==X.episodeId||uv('series')!==SERIES||uv('type')!=='11')throw new Error('UPLOAD_SCOPE_DRIFT');
      await upload.locator('input[name="file"]').setInputFiles(FRAME);
      const p1=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),upload.locator('#artwork-continue-button,button[type="submit"]').first().click()]);
      const r1=await p1;await page.waitForTimeout(700);report.stage1={status:r1?.status()??null};if(!r1||r1.status()>=400)throw new Error('STAGE1_FAILED');

      const crop=page.locator('form[action="/artwork/upload_cropper_handler"]').first();if(!(await crop.count()))throw new Error('CROP_FORM_MISSING');
      const cc=await ctrls(crop),cv=n=>cc.find(c=>c.name===n)?.value??null;
      const scope={id:cv('id'),x:cv('x'),y:cv('y'),width:cv('width'),height:cv('height'),scaleX:cv('scaleX'),scaleY:cv('scaleY')};
      const src=await page.locator('img#cropper').first().getAttribute('src').catch(()=>null);report.crop={...scope,cropImageSrc:src};
      if(!/^\d+$/.test(String(scope.id||''))||scope.x!=='0'||scope.y!=='0'||scope.width!=='1280'||scope.height!=='720'||scope.scaleX!=='1'||scope.scaleY!=='1'||!src||!/artworks\.thetvdb\.com\/incoming\//.test(src))throw new Error('CROP_SCOPE_INVALID');

      const finish=crop.locator('button[type="submit"]').filter({hasText:'Finish'}).first();if(!(await finish.count())||await finish.isDisabled())throw new Error('FINISH_UNAVAILABLE');
      const p2=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_cropper_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),finish.click()]);
      const r2=await p2;await page.waitForTimeout(700);const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
      report.stage2={status:r2?.status()??null,successMessage:/Artwork successfully added\./i.test(body)};
      if(!r2||![200,302].includes(r2.status())||!report.stage2.successMessage)throw new Error('STAGE2_NOT_CONFIRMED');

      await go(page,BASE+'/series/'+SLUG+'/episodes/'+X.episodeId);const after=artUrls(await page.content());
      report.verification={artworkPresent:after.length>0,artwork:after};
      if(!after.length)throw new Error('POST_WRITE_ARTWORK_MISSING');
      report.result='APPLIED_AND_VERIFIED';
    }
  }finally{await browser.close();}
}catch(e){report.blocked.push({reason:String(e?.stack||e)});if(report.result==='NOT_STARTED')report.result=report.stage2?'FAILED_AFTER_FINALIZE_DO_NOT_RETRY':(report.stage1?'STAGE1_ONLY_STOP_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE');}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,frame:report.frame,verification:report.verification,blocked:report.blocked},null,2));
if(!['APPLIED_AND_VERIFIED','ALREADY_PRESENT_NO_WRITE'].includes(report.result))process.exitCode=2;
