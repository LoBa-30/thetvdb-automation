import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const ROOT='reports/mastu-youtube-browser';
await fs.mkdir(ROOT,{recursive:true});
const cat=JSON.parse(await fs.readFile(ROOT+'/catalogue.json','utf8'));
const entries=(cat.entries||[]).filter(e=>e.id&&e.title);
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'fr-FR',
  timezoneId:'Europe/Paris',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
});
const page=await context.newPage();

async function inspect(e,index){
  const url='https://www.youtube.com/watch?v='+e.id+'&hl=fr';
  const row={index,id:e.id,flatTitle:e.title,flatDuration:e.duration,url,publishDate:null,uploadDate:null,lengthSeconds:null,videoTitle:null,status:null,error:null};
  try{
    let resp=null;
    for(let a=1;a<=3;a++){
      resp=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>null);
      if(resp && resp.status()<400) break;
      await page.waitForTimeout(500*a);
    }
    row.status=resp?.status()??null;
    await page.waitForTimeout(350);
    const data=await page.evaluate(()=>{
      const p=window.ytInitialPlayerResponse||null;
      const m=p?.microformat?.playerMicroformatRenderer||null;
      const v=p?.videoDetails||null;
      return {
        publishDate:m?.publishDate||null,
        uploadDate:m?.uploadDate||null,
        lengthSeconds:v?.lengthSeconds?Number(v.lengthSeconds):null,
        videoTitle:v?.title||null,
        playability:p?.playabilityStatus?.status||null
      };
    }).catch(()=>({}));
    Object.assign(row,data);
    if(!row.publishDate || !row.lengthSeconds || !row.videoTitle){
      const html=await page.content().catch(()=>'');
      row.publishDate=row.publishDate||html.match(/"publishDate":"(\d{4}-\d{2}-\d{2})"/)?.[1]||null;
      row.uploadDate=row.uploadDate||html.match(/"uploadDate":"(\d{4}-\d{2}-\d{2})"/)?.[1]||null;
      row.videoTitle=row.videoTitle||html.match(/"title":"((?:\\.|[^"\\])*)","lengthSeconds"/)?.[1]?.replace(/\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16)))||null;
      const ls=html.match(/"lengthSeconds":"(\d+)"/)?.[1];
      row.lengthSeconds=row.lengthSeconds||(ls?Number(ls):null);
      row.challenge=/confirm that you.?re not a bot|confirmer que vous n.?êtes pas un robot/i.test(html);
    }
  }catch(err){ row.error=err?.message||String(err); }
  if((index+1)%25===0) console.log('inspected',index+1,'/',entries.length,'dates',results.filter(x=>x?.publishDate).length,'challenge',results.filter(x=>x?.challenge).length);
  return row;
}

const results=[];
for(let i=0;i<entries.length;i++){
  results[i]=await inspect(entries[i],i);
}
await browser.close();
const summary={
  total:results.length,
  withPublishDate:results.filter(x=>x.publishDate).length,
  withUploadDate:results.filter(x=>x.uploadDate).length,
  withDuration:results.filter(x=>x.lengthSeconds!=null).length,
  withVideoTitle:results.filter(x=>x.videoTitle).length,
  challengeCount:results.filter(x=>x.challenge).length,
  errors:results.filter(x=>x.error).length
};
await fs.writeFile(ROOT+'/metadata.json',JSON.stringify(results,null,2));
await fs.writeFile(ROOT+'/summary.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
