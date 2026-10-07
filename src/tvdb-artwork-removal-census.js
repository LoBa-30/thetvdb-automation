import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',OUT='reports/tvdb-artwork-removal-census-2026-10-07';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_READ_ONLY_ARTWORK_REMOVAL_CENSUS',authenticated:false,pages:[],notifications:[],reasonCounts:{},refs:[],episodeArtworkDashboard:null,result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(500);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);
 await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 report.authenticated=(await context.request.get(BASE+'/auth/getuser')).ok();
 if(!report.authenticated)throw new Error('Auth not proven');

 for(let p=1;p<=10;p++){
   const u=BASE+'/dashboard/notifications'+(p>1?'?page='+p:'');
   const r=await go(u);
   const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
   const refs=[...body.matchAll(/REF-(\d+)/g)].map(m=>'REF-'+m[1]);
   if(!refs.length&&p>1)break;
   report.pages.push({page:p,url:page.url(),refs});
   const re=/([A-Za-z0-9_ -]+)?\s*October 7, 2026\s+([0-9:]+[AP]M UTC)\s+(REF-\d+)\s+This artwork has been removed by a moderator as it was found to violate a site rule:\s*([^\.]+)\./gi;
   let m;
   while((m=re.exec(body))!==null){
     const item={page:p,moderator:(m[1]||'').trim()||null,time:m[2],ref:m[3],reason:m[4].trim()};
     report.notifications.push(item);
   }
   // fallback card extraction preserving text even if regex misses timestamp/name
   const cards=await page.locator('body *').evaluateAll(els=>els.map(el=>({text:(el.innerText||'').replace(/\s+/g,' ').trim(),html:el.outerHTML})).filter(x=>/REF-\d+/.test(x.text)&&/artwork has been removed by a moderator/i.test(x.text)&&x.text.length<1500));
   for(const c of cards){
     const rm=c.text.match(/REF-(\d+)/); if(!rm)continue;
     const ref='REF-'+rm[1];
     if(report.notifications.some(x=>x.ref===ref))continue;
     const reason=(c.text.match(/violate a site rule:\s*([^\.]+)\./i)||[])[1]||null;
     const hrefs=[...c.html.matchAll(/href="([^"]+)"/g)].map(x=>x[1]);
     report.notifications.push({page:p,ref,reason,text:c.text,hrefs});
   }
   if(!body.includes('»') && p>1) break;
 }

 report.refs=[...new Set(report.notifications.map(x=>x.ref))];
 for(const n of report.notifications){
   const key=n.reason||'UNKNOWN';
   report.reasonCounts[key]=(report.reasonCounts[key]||0)+1;
 }

 // Inspect user's episode artwork dashboard for any surviving records/metadata.
 try{
   await go(BASE+'/dashboard/artwork/11');
   const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
   const links=await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.innerText||'').replace(/\s+/g,' ').trim(),href:a.href})).filter(x=>x.text||x.href));
   report.episodeArtworkDashboard={url:page.url(),title:await page.title(),body:body.slice(0,30000),links:links.slice(0,600)};
 }catch(e){report.episodeArtworkDashboard={error:String(e)}}

 report.result='CENSUS_COMPLETE_ZERO_WRITES';
}catch(e){report.error=String(e?.stack||e);report.result='CENSUS_FAILED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',[
 'notifications='+report.notifications.length,
 'uniqueRefs='+report.refs.length,
 ...Object.entries(report.reasonCounts).map(([k,v])=>'reason['+k+']='+v),
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='CENSUS_COMPLETE_ZERO_WRITES')process.exitCode=2;
