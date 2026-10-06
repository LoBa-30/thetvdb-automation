
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const OUT='reports/elian-thumbnail-probe';
await fs.mkdir(OUT,{recursive:true});
const vids=[
['S2023E02','rDlPlsjuWXw'],['S2023E04','QboHB6hZ5dg'],['S2023E06','lBYtMPlWRq4'],
['S2024E02','IKWScHFW_Mk'],['S2024E04','U6DoBQQk4OE'],['S2024E07','DmXahVPYCbc'],
['S2025E03','UjZkmAczOI8'],['S2025E07','F3NCaUo25Ys'],['S2026E02','jRU3jVvS8Wg'],['S2026E08','xkGjW_FR8vI']
];
const browser=await chromium.launch({headless:true});
const context=await browser.newContext();
const report={generatedAt:new Date().toISOString(),mode:'READ_ONLY_OFFICIAL_YOUTUBE_THUMBNAIL_PROBE',rows:[],errors:[]};
for(const [code,id] of vids){
 const row={code,id,variants:[]};
 for(const variant of ['maxresdefault','sddefault','hqdefault']){
   const p=await context.newPage(),url='https://i.ytimg.com/vi/'+id+'/'+variant+'.jpg';
   try{
     const r=await p.goto(url,{waitUntil:'load',timeout:30000});
     const ct=r?.headers()['content-type']||null;
     const dim=await p.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight})).catch(()=>({w:null,h:null}));
     row.variants.push({variant,url,status:r?.status()??null,contentType:ct,width:dim.w,height:dim.h,ratio:dim.w&&dim.h?Number((dim.w/dim.h).toFixed(4)):null,usable16x9:Boolean(dim.w>=640&&dim.h>=360&&Math.abs(dim.w/dim.h-16/9)<0.03)});
   }catch(e){row.variants.push({variant,url,error:String(e?.message||e)});}
   finally{await p.close();}
 }
 report.rows.push(row);
}
await browser.close();
report.summary={videos:report.rows.length,withUsable16x9:report.rows.filter(r=>r.variants.some(v=>v.usable16x9)).length};
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
