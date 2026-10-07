import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password)throw new Error('Missing credentials');
const BASE='https://thetvdb.com',SLUG='raska',SERIES='479597',OUT='reports/raska-missing-artwork-preflight';
await fs.mkdir(OUT,{recursive:true});
const source=JSON.parse(await fs.readFile('reports/raska-images/image-audit.json','utf8'));
const TARGETS=Object.values(source).filter(x=>x.provenance==='MISSING_IMAGE'&&x.youtube_id);
const historical=Object.values(source).filter(x=>x.provenance==='MISSING_IMAGE'&&!x.youtube_id);

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
let readOnly=false;const blockedRequests=[];
await context.route('**/*',async route=>{const req=route.request(),m=req.method().toUpperCase();if(readOnly&&/thetvdb\.com/i.test(req.url())&&!['GET','HEAD','OPTIONS'].includes(m)){blockedRequests.push({method:m,url:req.url()});return route.abort('blockedbyclient');}return route.continue();});
async function go(p,u){let r=null;for(let i=0;i<3;i++){r=await p.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await p.waitForTimeout(220);return r;}await p.waitForTimeout(500*(i+1));}throw new Error('GET '+u+' '+(r?.status()??'n/a'));}
const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g,'').replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
function artUrls(html){return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>s]+episode[^"'<>s]+\/screencap\/[^"'<>s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));}

const report={generatedAt:new Date().toISOString(),target:'Raska',mode:'MISSING_ARTWORK_PREFLIGHT_READ_ONLY',authenticated:false,sourceMissing:Object.values(source).filter(x=>x.provenance==='MISSING_IMAGE').length,historicalWithoutCurrentYoutube:historical.map(x=>({code:x.code,episodeId:x.episode_id,title:x.tvdb_title})),targets:[],planned:[],skips:[],blocked:[],result:'NOT_STARTED'};
try{
 await go(page,BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(600);const probe=await context.request.get(BASE+'/auth/getuser');report.authenticated=probe.ok();if(!report.authenticated)throw new Error('Auth not proven');readOnly=true;
 for(const x of TARGETS){
   const p=await context.newPage();const row={code:x.code,episodeId:x.episode_id,tvdbTitle:x.tvdb_title,youtubeId:x.youtube_id,youtubeTitle:x.youtube_title,variants:[],status:null};
   try{
     await go(p,BASE+'/series/'+SLUG+'/episodes/'+x.episode_id);
     row.heading=(await p.locator('h1,h2').allTextContents()).map(z=>z.trim()).find(Boolean)||null;
     row.artwork=artUrls(await p.content());
     if(row.artwork.length){row.status='ALREADY_PRESENT';report.skips.push({code:x.code,reason:'ALREADY_PRESENT',artwork:row.artwork});report.targets.push(row);continue;}
     if(norm(row.heading)!==norm(x.tvdb_title)){row.status='BLOCKED_TITLE_DRIFT';report.blocked.push({code:x.code,reason:'TITLE_DRIFT',expected:x.tvdb_title,actual:row.heading});report.targets.push(row);continue;}
     for(const variant of ['maxresdefault','sddefault','hqdefault']){
       const q=await context.newPage(),url='https://i.ytimg.com/vi/'+x.youtube_id+'/'+variant+'.jpg';
       try{const rr=await q.goto(url,{waitUntil:'load',timeout:30000});const dim=await q.locator('img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight})).catch(()=>({w:null,h:null}));row.variants.push({variant,url,status:rr?.status()??null,width:dim.w,height:dim.h,usable:Boolean(rr?.status()===200&&dim.w>=640&&dim.h>=360&&Math.abs(dim.w/dim.h-16/9)<0.03)});}catch(e){row.variants.push({variant,url,error:String(e?.message||e),usable:false});}finally{await q.close();}
     }
     row.chosen=row.variants.find(v=>v.usable)||null;
     if(!row.chosen){row.status='BLOCKED_NO_USABLE_16X9';report.blocked.push({code:x.code,reason:'NO_USABLE_16X9',youtubeId:x.youtube_id,variants:row.variants});report.targets.push(row);continue;}
     await go(p,BASE+'/artwork/upload?type=11&episode='+x.episode_id+'&series='+SERIES);
     const uf=p.locator('form[action*="/artwork/upload_handler"]').first();
     if(!(await uf.count())){row.status='BLOCKED_FORM_MISSING';report.blocked.push({code:x.code,reason:'FORM_MISSING'});report.targets.push(row);continue;}
     row.form={action:await uf.getAttribute('action'),episode:await uf.locator('input[name="episode"]').inputValue(),series:await uf.locator('input[name="series"]').inputValue(),type:await uf.locator('input[name="type"]').inputValue(),hasUrl:await uf.locator('input[name="url"]').count()>0,hasFile:await uf.locator('input[name="file"]').count()>0};
     if(row.form.action!=='/artwork/upload_handler'||row.form.episode!==x.episode_id||row.form.type!=='11'||(!row.form.hasUrl&&!row.form.hasFile)){row.status='BLOCKED_FORM_SCOPE';report.blocked.push({code:x.code,reason:'FORM_SCOPE_DRIFT',form:row.form});report.targets.push(row);continue;}
     row.status='PREFLIGHT_PASSED';report.planned.push({code:x.code,episodeId:x.episode_id,title:x.tvdb_title,youtubeId:x.youtube_id,imageUrl:row.chosen.url,width:row.chosen.width,height:row.chosen.height,series:row.form.series});report.targets.push(row);
   }catch(e){row.status='BLOCKED_ERROR';row.error=String(e?.stack||e);report.blocked.push({code:x.code,reason:row.error});report.targets.push(row);}finally{if(!p.isClosed())await p.close();}
 }
 report.result='PREFLIGHT_COMPLETE';
}catch(e){report.blocked.push({reason:String(e?.stack||e)});report.result='BLOCKED_ERROR';}
finally{report.readOnlyNetworkLock=true;report.blockedNonReadRequests=blockedRequests;await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'sourceMissing='+report.sourceMissing,'historicalWithoutYoutube='+report.historicalWithoutCurrentYoutube.length,'planned='+report.planned.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='PREFLIGHT_COMPLETE')process.exitCode=2;
