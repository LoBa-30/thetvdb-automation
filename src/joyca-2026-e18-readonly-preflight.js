import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
// STRICTLY READ-ONLY structural preflight: NO episode creation, no editor submission, no artwork.
const USER=process.env.TVDB_USERNAME, PASS=process.env.TVDB_PASSWORD;
if(!USER || !PASS) throw Error('MISSING_AUTHENTICATION_SECRETS_STOP');
const BASE='https://thetvdb.com',SERIES='335805-show';
const VIDEO='H-yZMZ9AA_k',TITLE='Voici 3 mondes, lequel tu choisis ?',DATE='2026-10-11';
const DEST='reports/joyca-2026-e18-readonly-preflight';
await fs.mkdir(DEST,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR'});
const page=await context.newPage();
let locked=false;
const blocked=[], report={createdAt:new Date().toISOString(),mode:'AUTHENTICATED_READ_ONLY_STRUCTURAL_NO_SITE_WRITES',
  creator:'Joyca',videoId:VIDEO,officialVideoUrl:'https://www.youtube.com/watch?v='+VIDEO,
  claimedOfficialDate:DATE,claimedTitle:TITLE,authenticated:false,blockNonReadRequests:true,
  episodeCount2026:null,unassigned:[],existingAssignedMatches:[],unassignedMatches:[],
  safeToCreate:false,siteWrites:0,errors:[]};
await context.route('**/*',async route=>{
 const req=route.request(), method=req.method().toUpperCase();
 if(locked && /thetvdb\.com/i.test(req.url()) && !['GET','HEAD','OPTIONS'].includes(method)){
   blocked.push({method,url:req.url()});
   return route.abort('blockedbyclient');
 }
 return route.continue();
});
async function get(url){
 const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 if(!response || response.status()>=400)throw Error('GET_UNAVAILABLE '+url+' '+(response?.status()??'unknown'));
 if(/login/i.test(await page.title()))throw Error('LOGIN_REQUIRED '+url);
 return response;
}
const normalize=x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
try{
 await page.goto(BASE+'/auth/login',{waitUntil:'domcontentloaded',timeout:60000});
 const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await form.locator('input[name="email"]').fill(USER);
 await form.locator('input[name="password"]').fill(PASS);
 await form.locator('button[type="submit"],input[type="submit"]').first().click();
 await page.waitForTimeout(650);
 const probe=await context.request.get(BASE+'/auth/getuser');
 if(!probe.ok())throw Error('AUTH_NOT_PROVEN');
 const who=await probe.json().catch(()=>({}));
 if(!who || !Object.keys(who).length)throw Error('AUTH_EMPTY_PROFILE');
 report.authenticated=true;
 locked=true;
 await get(BASE+'/series/'+SERIES+'/seasons/official/2026');
 const assigned=await page.locator('a[href*="/series/'+SERIES+'/episodes/"]').evaluateAll(nodes=>
   nodes.map(a=>({href:a.href,title:(a.textContent||'').trim(),rowText:(a.closest('tr')?.textContent||'').replace(/\s+/g,' ').trim()}))
 );
 const assignedIds=new Set(assigned.map(a=>a.href.match(/\/episodes\/(\d+)/)?.[1]).filter(Boolean));
 report.episodeCount2026=assignedIds.size;
 report.assignedLastRows=assigned.slice(-3);
 report.existingAssignedMatches=assigned.filter(a=>normalize(a.title)===normalize(TITLE) || /S2026E18\b/i.test(a.rowText));
 await get(BASE+'/series/'+SERIES+'/seasons/official/unassigned/edit');
 report.unassignedPageTitle=await page.title();
 const links=await page.locator('a[href*="/series/'+SERIES+'/episodes/"]').evaluateAll(nodes=>{
  const found=[],seen=new Set();
  for(const a of nodes){
   const id=a.href.match(/\/episodes\/(\d+)/)?.[1];if(!id||seen.has(id))continue;
   seen.add(id);
   found.push({id,url:a.href,title:(a.textContent||'').trim(),rowText:(a.closest('tr')?.textContent||'').replace(/\s+/g,' ').trim()});
  }
  return found;
 });
 report.unassigned=links;
 for(const link of links){
  if(normalize(link.title)===normalize(TITLE)){report.unassignedMatches.push(link);continue;}
  await get(link.url);
  const headings=await page.locator('h1,h2').allTextContents();
  const heading=headings.map(x=>x.trim()).find(Boolean)||'';
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
  const entry={...link,heading,bodyExcerpt:body.slice(0,900)};
  report.unassignedDetails ||= [];
  report.unassignedDetails.push(entry);
  if(normalize(heading)===normalize(TITLE) || body.includes(VIDEO))report.unassignedMatches.push(entry);
 }
 report.noDuplicateProven=report.existingAssignedMatches.length===0&&report.unassignedMatches.length===0&&links.length>0;
 // Even if not found, this report does not authorize creating any episode.
 report.safeToCreate=false;
}catch(e){report.errors.push(String(e?.message||e));}
finally{
 report.blockedRequests=blocked;
 await browser.close();
 await fs.writeFile(DEST+'/report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({creator:report.creator,authenticated:report.authenticated,
  season2026Episodes:report.episodeCount2026,unassignedCount:report.unassigned.length,
  assignedMatches:report.existingAssignedMatches.length,unassignedMatches:report.unassignedMatches.length,
  errors:report.errors,siteWrites:0,blockedRequests:blocked.length,safeToCreate:false}));
 if(report.errors.length || blocked.length)process.exitCode=2;
}
