import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ARTWORK_PILOT_BATCH||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com';
const OUT='reports/artwork-pilot-batch-2026-10-07';
await fs.mkdir(OUT,{recursive:true});

const TARGETS=[
  {target:'Mcfly & Carlito',slug:'338282-show',series:'338282',episodeId:'12023296',code:'S2015E01',title:'GROSSE ANNONCE',youtubeId:'fttKpTYRdMs',imageUrl:'https://i.ytimg.com/vi/fttKpTYRdMs/maxresdefault.jpg',width:1280,height:720,source:'mcfly-preflight'},
  {target:'Elian Ventre',slug:'elian-ventre-462729',series:'462729',episodeId:'11092260',code:'S2024E07',title:"C'est l'heure des travaux (on décore mon 13m2)",youtubeId:'DmXahVPYCbc',imageUrl:'https://i.ytimg.com/vi/DmXahVPYCbc/maxresdefault.jpg',width:1280,height:720,source:'elian-preflight'},
  {target:'Elian Ventre',slug:'elian-ventre-462729',series:'462729',episodeId:'11205952',code:'S2025E03',title:'TIKTOK CHALLENGERS #1 ! Ft @Djilsi',youtubeId:'UjZkmAczOI8',imageUrl:'https://i.ytimg.com/vi/UjZkmAczOI8/maxresdefault.jpg',width:1280,height:720,source:'elian-preflight'},
  {target:'Raska',slug:'raska',series:'479597',episodeId:'11960839',code:'S2017E03',title:'KRISY RAPPEUR ET PRODUCTEUR DE DAMSO !',youtubeId:'YarMW4AXR54',imageUrl:'https://i.ytimg.com/vi/YarMW4AXR54/maxresdefault.jpg',width:1280,height:720,source:'raska-preflight'},
  {target:'Raska',slug:'raska',series:'479597',episodeId:'11979236',code:'S2018E02',title:'PLK – DES TÉNEBRES AU PLATINE ! (Platinum)',youtubeId:'qaxb0pVb6No',imageUrl:'https://i.ytimg.com/vi/qaxb0pVb6No/maxresdefault.jpg',width:1280,height:720,source:'raska-preflight'},
  {target:'Raska',slug:'raska',series:'479597',episodeId:'11960853',code:'S2019E01',title:'PNL - DEUX FRÈRES : TOUS LES MYSTÈRES DU CLIP !',youtubeId:'95dKYYdIyik',imageUrl:'https://i.ytimg.com/vi/95dKYYdIyik/maxresdefault.jpg',width:1280,height:720,source:'raska-preflight'}
];

const elian=JSON.parse(await fs.readFile('reports/elian-artwork-batch-preflight/report.json','utf8'));
const raska=JSON.parse(await fs.readFile('reports/raska-missing-artwork-preflight/report.json','utf8'));
const mcfly=JSON.parse(await fs.readFile('reports/mcfly-grosse-annonce-artwork-preflight/report.json','utf8'));

function proveCheckpoint(t){
  if(t.source==='elian-preflight'){
    const p=elian.planned?.find(x=>x.id===t.episodeId);
    return !!p&&p.youtubeId===t.youtubeId&&p.imageUrl===t.imageUrl&&p.width===t.width&&p.height===t.height;
  }
  if(t.source==='raska-preflight'){
    const p=raska.planned?.find(x=>x.episodeId===t.episodeId);
    return !!p&&p.youtubeId===t.youtubeId&&p.imageUrl===t.imageUrl&&p.width===t.width&&p.height===t.height&&p.series===t.series;
  }
  if(t.source==='mcfly-preflight'){
    return mcfly.result==='PREFLIGHT_PASSED_ZERO_WRITES'&&mcfly.episode?.heading===t.title&&mcfly.episode?.artwork?.length===0&&mcfly.chosenThumbnail?.url===t.imageUrl&&mcfly.chosenThumbnail?.width===t.width&&mcfly.chosenThumbnail?.height===t.height;
  }
  return false;
}
for(const t of TARGETS) if(!proveCheckpoint(t)) throw new Error('Checkpoint proof failed for '+t.target+' '+t.code);

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'GUARDED_SMALL_ARTWORK_PILOT_BATCH',armed,authenticated:false,targets:TARGETS,results:[],stopped:false,stopReason:null,result:'NOT_STARTED'};

function norm(s){return String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g,'').replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function artUrls(html){return [...new Set([...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&')))];}
async function go(p,url){
  let r=null;
  for(let i=0;i<3;i++){
    r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(r&&r.status()<400){await p.waitForTimeout(450);return r;}
    await p.waitForTimeout(500*(i+1));
  }
  throw new Error('GET '+url+' '+(r?.status()??'n/a'));
}
async function snap(form){
  return form.evaluate(f=>({
    action:f.getAttribute('action'),
    method:f.getAttribute('method'),
    controls:[...f.querySelectorAll('input,select,textarea')].map(el=>({name:el.getAttribute('name'),type:el.getAttribute('type'),value:el.value??el.getAttribute('value')})),
    buttons:[...f.querySelectorAll('button,input[type="submit"]')].map(el=>({type:el.getAttribute('type'),text:(el.textContent||'').trim(),disabled:!!el.disabled}))
  }));
}

try{
  await go(page,BASE+'/auth/login');
  const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await lf.locator('input[name="email"]').fill(username);
  await lf.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(650);
  const probe=await context.request.get(BASE+'/auth/getuser');
  report.authenticated=probe.ok();
  if(!report.authenticated) throw new Error('Auth not proven');

  for(const t of TARGETS){
    const row={target:t.target,code:t.code,episodeId:t.episodeId,title:t.title,youtubeId:t.youtubeId,status:'NOT_STARTED',preflight:null,stage1:null,crop:null,stage2:null,verification:null,blocked:[]};
    report.results.push(row);
    try{
      await go(page,BASE+'/series/'+t.slug+'/episodes/'+t.episodeId);
      const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
      const before=artUrls(await page.content());
      row.preflight={heading,beforeArtwork:before};
      if(norm(heading)!==norm(t.title)) throw new Error('TITLE_DRIFT expected='+t.title+' actual='+heading);
      if(before.length){row.status='ALREADY_PRESENT_SKIP';row.verification={artworkPresent:true,artwork:before};continue;}

      const ir=await context.request.get(t.imageUrl);
      const buf=await ir.body(),ctype=ir.headers()['content-type']||'';
      row.preflight.image={url:t.imageUrl,status:ir.status(),contentType:ctype,bytes:buf.length,width:t.width,height:t.height};
      if(!ir.ok()||!/^image\//i.test(ctype)||buf.length<10000) throw new Error('IMAGE_FETCH_INVALID');

      await go(page,BASE+'/artwork/upload?type=11&episode='+t.episodeId+'&series='+t.series);
      const upload=page.locator('form[action="/artwork/upload_handler"]').first();
      if(!(await upload.count())) throw new Error('UPLOAD_FORM_MISSING');
      const us=await snap(upload);
      const uv=(n)=>us.controls.find(c=>c.name===n)?.value??null;
      if(uv('episode')!==t.episodeId||uv('series')!==t.series||uv('type')!=='11') throw new Error('UPLOAD_FORM_SCOPE_DRIFT');
      await upload.locator('input[name="file"]').setInputFiles({name:t.youtubeId+'.jpg',mimeType:'image/jpeg',buffer:buf});

      const p1=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),upload.locator('#artwork-continue-button,button[type="submit"],input[type="submit"]').first().click()]);
      const r1=await p1; await page.waitForTimeout(750);
      row.stage1={status:r1?.status()??null,url:r1?.url()??null,pageUrl:page.url(),body:(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,1000)};
      if(!r1||r1.status()>=400) throw new Error('STAGE1_FAILED');

      const crop=page.locator('form[action="/artwork/upload_cropper_handler"]').first();
      if(!(await crop.count())) throw new Error('CROP_FORM_MISSING');
      const cs=await snap(crop),cv=(n)=>cs.controls.find(c=>c.name===n)?.value??null;
      const scope={id:cv('id'),x:cv('x'),y:cv('y'),width:cv('width'),height:cv('height'),scaleX:cv('scaleX'),scaleY:cv('scaleY')};
      const cropImageSrc=await page.locator('img#cropper').first().getAttribute('src').catch(()=>null);
      row.crop={...scope,cropImageSrc};
      if(!/^\d+$/.test(String(scope.id||''))) throw new Error('CROP_TEMP_ID_INVALID');
      if(scope.x!=='0'||scope.y!=='0'||Number(scope.width)!==t.width||Number(scope.height)!==t.height||scope.scaleX!=='1'||scope.scaleY!=='1') throw new Error('CROP_SCOPE_DRIFT '+JSON.stringify(scope));
      if(!cropImageSrc||!/artworks\.thetvdb\.com\/incoming\//.test(cropImageSrc)) throw new Error('CROP_SOURCE_NOT_TEMP_INCOMING');

      const finish=crop.locator('button[type="submit"]').filter({hasText:'Finish'}).first();
      if(!(await finish.count())||await finish.isDisabled()) throw new Error('FINISH_UNAVAILABLE');
      const p2=page.waitForResponse(r=>new URL(r.url()).origin===BASE&&new URL(r.url()).pathname==='/artwork/upload_cropper_handler'&&r.request().method()==='POST',{timeout:60000}).catch(()=>null);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),finish.click()]);
      const r2=await p2; await page.waitForTimeout(800);
      const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
      row.stage2={status:r2?.status()??null,url:r2?.url()??null,pageUrl:page.url(),successMessage:/Artwork successfully added\./i.test(body),body:body.slice(0,1200)};
      if(!r2||![200,302].includes(r2.status())||!row.stage2.successMessage) throw new Error('STAGE2_NOT_CONFIRMED');

      await go(page,BASE+'/series/'+t.slug+'/episodes/'+t.episodeId);
      const after=artUrls(await page.content());
      row.verification={artworkPresent:after.length>0,artwork:after};
      if(!after.length) throw new Error('POST_WRITE_ARTWORK_MISSING');
      row.status='APPLIED_AND_VERIFIED';
    }catch(e){
      row.blocked.push({reason:String(e?.message||e)});
      row.status=row.stage2?'FAILED_AFTER_FINALIZE_DO_NOT_RETRY':(row.stage1?'STAGE1_ONLY_STOP_DO_NOT_RETRY':'BLOCKED_BEFORE_WRITE');
      report.stopped=true;
      report.stopReason=t.target+' '+t.code+': '+String(e?.message||e);
      break;
    }
  }
  const applied=report.results.filter(x=>x.status==='APPLIED_AND_VERIFIED').length;
  const skipped=report.results.filter(x=>x.status==='ALREADY_PRESENT_SKIP').length;
  report.summary={requested:TARGETS.length,processed:report.results.length,applied,skipped,failed:report.results.filter(x=>x.blocked.length).length};
  report.result=report.stopped?'PILOT_STOPPED_ON_GUARD':'PILOT_BATCH_COMPLETE';
}catch(e){
  report.fatal=String(e?.stack||e);report.result='FATAL_BEFORE_BATCH';
}finally{
  await browser.close();
}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'requested='+TARGETS.length,
  'processed='+(report.summary?.processed??0),
  'applied='+(report.summary?.applied??0),
  'skipped='+(report.summary?.skipped??0),
  'failed='+(report.summary?.failed??0),
  'stopped='+report.stopped,
  'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!['PILOT_BATCH_COMPLETE'].includes(report.result)) process.exitCode=2;
