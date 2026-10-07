import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing credentials');
const BASE='https://thetvdb.com',SLUG='338282-show';
const X={id:'12023296',title:'GROSSE ANNONCE'};
const OUT='reports/mcfly-grosse-annonce-artwork-delayed-verify';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const page=await context.newPage();
let readOnly=false;const blocked=[];
await context.route('**/*',async route=>{
  const req=route.request(),method=req.method().toUpperCase();
  if(readOnly&&/thetvdb\.com/i.test(req.url())&&!['GET','HEAD','OPTIONS'].includes(method)){blocked.push({method,url:req.url()});return route.abort('blockedbyclient');}
  return route.continue();
});
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);await page.waitForTimeout(500);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));}
function artUrls(html){return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));}
const report={generatedAt:new Date().toISOString(),mode:'DELAYED_READ_ONLY_ARTWORK_VERIFICATION',authenticated:false,episodeId:X.id,artwork:[],blocked:[],result:'NOT_STARTED'};
try{
  await go(BASE+'/auth/login');
  const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(650);
  const p=await context.request.get(BASE+'/auth/getuser');report.authenticated=p.ok();if(!report.authenticated)throw new Error('Auth not proven');
  readOnly=true;
  await go(BASE+'/series/'+SLUG+'/episodes/'+X.id);
  const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
  report.heading=heading;if(heading!==X.title)throw new Error('Title drift '+heading);
  report.artwork=artUrls(await page.content());
  report.result=report.artwork.length?'ARTWORK_NOW_PRESENT_VERIFIED':'ARTWORK_STILL_PENDING_DO_NOT_RETRY';
}catch(e){report.blocked.push({reason:String(e?.stack||e)});report.result='BLOCKED_READ_ONLY_CHECK';}
finally{report.readOnlyNetworkLock=true;report.blockedNonReadRequests=blocked;await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
await fs.writeFile(OUT+'/summary.txt',['authenticated='+report.authenticated,'artworkCount='+report.artwork.length,'blocked='+report.blocked.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result==='BLOCKED_READ_ONLY_CHECK')process.exitCode=2;
