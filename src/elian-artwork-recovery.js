import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_ARTWORK_RECOVERY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',SERIES='462729',OUT='reports/elian-artwork-recovery-2026-10-07';
const TARGETS=[
  {episodeId:'11092251',code:'S2023E04',title:'STRUCTURE ESPORT DE LUXE ?',youtubeId:'QboHB6hZ5dg',imageUrl:'https://i.ytimg.com/vi/QboHB6hZ5dg/maxresdefault.jpg',proof:'pilot'},
  {episodeId:'11092253',code:'S2023E06',title:'13m2 dans PARIS ???',youtubeId:'lBYtMPlWRq4',imageUrl:'https://i.ytimg.com/vi/lBYtMPlWRq4/maxresdefault.jpg',proof:'batch'},
  {episodeId:'11092255',code:'S2024E02',title:'3000 BALLONS DANS MON APPARTEMENT !',youtubeId:'IKWScHFW_Mk',imageUrl:'https://i.ytimg.com/vi/IKWScHFW_Mk/maxresdefault.jpg',proof:'batch'},
  {episodeId:'11567244',code:'S2025E07',title:'Je TRANSFORME mon appartement !',youtubeId:'F3NCaUo25Ys',imageUrl:'https://i.ytimg.com/vi/F3NCaUo25Ys/maxresdefault.jpg',proof:'batch'}
];
const pilot=JSON.parse(await fs.readFile('reports/elian-artwork-pilot/report.json','utf8'));
const batch=JSON.parse(await fs.readFile('reports/elian-artwork-batch-preflight/report.json','utf8'));
for(const t of TARGETS){
  if(t.proof==='pilot'){
    if(pilot.write?.episodeId!==t.episodeId||pilot.preflight?.youtubeId!==t.youtubeId||pilot.preflight?.imageUrl!==t.imageUrl||pilot.preflight?.heading!==t.title) throw new Error('Pilot proof drift '+t.code);
  }else{
    const p=batch.planned?.find(x=>x.id===t.episodeId);
    if(!p||p.youtubeId!==t.youtubeId||p.imageUrl!==t.imageUrl||p.width!==1280||p.height!==720) throw new Error('Batch proof drift '+t.code);
  }
}
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'GUARDED_ELIAN_ARTWORK_RECOVERY_TWO_STAGE',authenticated:false,results:[],stopped:false,stopReason:null,result:'NOT_STARTED'};
const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g,'').replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const artUrls=html=>[...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];
async function go(p,url){let r=null;for(let i=0;i<3;i++){r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await p.waitForTimeout(400);return r;}await p.waitForTimeout(500*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}
async function ctrls(form){return form.locator('input,select,textarea').evaluateAll(els=>els.map(el=>({name:el.getAttribute('name'),value:el.value??el.getAttribute('value')})));}

try{
  await go(page,BASE+'/auth/login');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(650);
  report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
  if(!report.authenticated) throw new Error('Auth not proven');

  for(const t of TARGETS){
    const row={code:t.code,episodeId:t.episodeId,title:t.title,youtubeId:t.youtubeId,status:'NOT_STARTED',preflight:null,crop:null,verification:null,blocked:[]};report.results.push(row);
    try{
      await go(page,BASE+'/series/'+SLUG+'/episodes/'+t.episodeId);
      const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
      const before=artUrls(await page.content());
      row.preflight={heading,beforeArtwork:before};
      if(norm(heading)!==norm(t.title)) throw new Error('TITLE_DRIFT expected='+t.title+' actual='+heading);
      if(before.length){row.status='ALREADY_PRESENT_SKIP';row.verification={artworkPresent:true,artwork:before};continue;}

      const q=await context.newPage();
      let dim={w:null,h:null},imgStatus=null;
      try{
        const rr=await q.goto(t.imageUrl,{waitUntil:'load',timeout:30000});imgStatus=rr?.status()??null;
        dim=await q.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight}));
      }finally{await q.close();}
      const ir=await context.request.get(t.imageUrl),buf=await ir.body(),ctype=ir.headers()['content-type']||'';
      row.preflight.image={url:t.imageUrl,status:imgStatus,width:dim.w,height:dim.h,contentType:ctype,bytes:buf.length};
      if(imgStatus!==200||dim.w!==1280||dim.h!==720||!ir.ok()||!/^image\//i.test(ctype)||buf.length<10000) throw new Error('IMAGE_PREFLIGHT_INVALID');

      await go(page,BASE+'/artwork/upload?type=11&episode='+t.episodeId+'&series='+SERIES);
      const upload=page.locator('form[action="/artwork/upload_handler"]').first();
      if(!(await upload.count())) throw new Error('UPLOAD_FORM_MISSING');
      const uc=await ctrls(upload),uv=n=>uc.find(c=>c.name===n)?.value??null;
      if(uv('episode')!==t.episodeId||uv('series')!==SERIES||uv('type')!=='11') throw new Error('UPLOAD_SCOPE_DRIFT');
      await upload.locator('input[name="file"]').setInputFiles({name:t.youtubeId+'.jpg',mimeType:'image/jpeg',buffer:buf});
      const p1=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),upload.locator('#artwork-continue-button,button[type="submit"]').first().click()]);
      const r1=await p1;await page.waitForTimeout(650);if(!r1||r1.status()>=400) throw new Error('STAGE1_FAILED');row.stage1Status=r1.status();

      const crop=page.locator('form[action="/artwork/upload_cropper_handler"]').first();if(!(await crop.count())) throw new Error('CROP_FORM_MISSING');
      const cc=await ctrls(crop),cv=n=>cc.find(c=>c.name===n)?.value??null;
      const scope={id:cv('id'),x:cv('x'),y:cv('y'),width:cv('width'),height:cv('height'),scaleX:cv('scaleX'),scaleY:cv('scaleY')};
      const src=await page.locator('img#cropper').first().getAttribute('src').catch(()=>null);row.crop={...scope,cropImageSrc:src};
      if(!/^\d+$/.test(String(scope.id||''))||scope.x!=='0'||scope.y!=='0'||scope.width!=='1280'||scope.height!=='720'||scope.scaleX!=='1'||scope.scaleY!=='1'||!src||!/artworks\.thetvdb\.com\/incoming\//.test(src)) throw new Error('CROP_SCOPE_INVALID');

      const finish=crop.locator('button[type="submit"]').filter({hasText:'Finish'}).first();if(!(await finish.count())||await finish.isDisabled()) throw new Error('FINISH_UNAVAILABLE');
      const p2=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_cropper_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),finish.click()]);
      const r2=await p2;await page.waitForTimeout(700);const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
      row.stage2={status:r2?.status()??null,successMessage:/Artwork successfully added\./i.test(body)};
      if(!r2||![200,302].includes(r2.status())||!row.stage2.successMessage) throw new Error('STAGE2_NOT_CONFIRMED');

      await go(page,BASE+'/series/'+SLUG+'/episodes/'+t.episodeId);const after=artUrls(await page.content());
      row.verification={artworkPresent:after.length>0,artwork:after};if(!after.length) throw new Error('POST_WRITE_ARTWORK_MISSING');
      row.status='APPLIED_AND_VERIFIED';
    }catch(e){row.blocked.push({reason:String(e?.message||e)});row.status=row.stage2?'FAILED_AFTER_FINALIZE_DO_NOT_RETRY':(row.stage1Status?'STAGE1_ONLY_STOP_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE');report.stopped=true;report.stopReason=t.code+': '+String(e?.message||e);break;}
  }
  report.summary={requested:TARGETS.length,processed:report.results.length,applied:report.results.filter(x=>x.status==='APPLIED_AND_VERIFIED').length,skipped:report.results.filter(x=>x.status==='ALREADY_PRESENT_SKIP').length,failed:report.results.filter(x=>x.blocked.length).length};
  report.result=report.stopped?'RECOVERY_STOPPED_ON_GUARD':'RECOVERY_COMPLETE';
}catch(e){report.fatal=String(e?.stack||e);report.result='FATAL_BEFORE_RECOVERY';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'requested='+TARGETS.length,'processed='+(report.summary?.processed??0),'applied='+(report.summary?.applied??0),'skipped='+(report.summary?.skipped??0),'failed='+(report.summary?.failed??0),'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='RECOVERY_COMPLETE')process.exitCode=2;
