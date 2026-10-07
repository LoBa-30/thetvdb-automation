import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const VIDEO_ID='EqFLIsSB2hg';
const OUT='reports/maxime-s2025e01-frame-pilot-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  viewport:{width:1280,height:720},
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
  locale:'fr-FR'
});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_YOUTUBE_VIDEO_FRAME_PILOT',videoId:VIDEO_ID,frames:[],blocked:[],result:'NOT_STARTED'};
try{
  const url='https://www.youtube-nocookie.com/embed/'+VIDEO_ID+'?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&cc_load_policy=0';
  const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  report.http=r?.status()??null;
  await page.waitForTimeout(2500);
  const body0=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,5000);
  report.initialBody=body0;
  report.buttons=await page.locator('button').evaluateAll(bs=>bs.map(b=>({text:(b.innerText||'').replace(/\s+/g,' ').trim(),title:b.getAttribute('title'),aria:b.getAttribute('aria-label')})).filter(x=>x.text||x.title||x.aria).slice(0,100));
  const consent=page.getByRole('button',{name:/Reject all|Accept all|Tout refuser|Tout accepter/i}).first();
  if(await consent.count()){
    await consent.click().catch(()=>{});
    await page.waitForTimeout(1500);
  }
  const play=page.locator('.ytp-large-play-button,button[aria-label*="Play"],button[aria-label*="Lire"]').first();
  if(await play.count()){
    await play.click().catch(()=>{});
    await page.waitForTimeout(4000);
  }
  const video=page.locator('video').first();
  if(!(await video.count())){
    report.body=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,4000);
    await page.screenshot({path:OUT+'/page-debug.png',fullPage:true}).catch(()=>{});
    throw new Error('VIDEO_ELEMENT_MISSING');
  }
  const meta=await video.evaluate(v=>({duration:v.duration,videoWidth:v.videoWidth,videoHeight:v.videoHeight,readyState:v.readyState,currentTime:v.currentTime,paused:v.paused}));
  report.meta=meta;
  if(!Number.isFinite(meta.duration)||meta.duration<30){
    report.body=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,5000);
    await page.screenshot({path:OUT+'/page-debug.png',fullPage:true}).catch(()=>{});
    throw new Error('VIDEO_DURATION_INVALID');
  }
  const times=[Math.min(30,meta.duration*0.15),Math.min(90,meta.duration*0.35),Math.min(180,meta.duration*0.6)];
  for(let i=0;i<times.length;i++){
    const t=Math.min(times[i],Math.max(1,meta.duration-5));
    await video.evaluate((v,t)=>new Promise((resolve,reject)=>{
      const done=()=>{v.pause();resolve();};
      v.addEventListener('seeked',done,{once:true});
      v.currentTime=t;
      setTimeout(()=>resolve(),7000);
    }),t);
    await page.waitForTimeout(600);
    const state=await video.evaluate(v=>({currentTime:v.currentTime,videoWidth:v.videoWidth,videoHeight:v.videoHeight,readyState:v.readyState}));
    const path=OUT+'/frame-'+String(i+1).padStart(2,'0')+'.png';
    await video.screenshot({path});
    const st=await fs.stat(path);
    report.frames.push({index:i+1,targetTime:t,state,path,bytes:st.size});
  }
  report.result='FRAMES_CAPTURED_ZERO_TVDB_WRITES';
}catch(e){report.blocked.push({reason:String(e?.stack||e)});report.result='FRAME_CAPTURE_BLOCKED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.result!=='FRAMES_CAPTURED_ZERO_TVDB_WRITES')process.exitCode=2;
