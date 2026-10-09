import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const BASE='https://thetvdb.com';
const SRC='reports/artwork-user-approvals-v23-2-2026-10-09.json';
const IMG='reports/artwork-user192-source-preflight-v23-2/report.json';
const OUT='reports/artwork-user192-live-preflight-v23-2';
await fs.mkdir(OUT,{recursive:true});
const state={
 generatedAt:new Date().toISOString(),mode:'SAMPLED_AUTHENTICATED_LIVE_PREFLIGHT_NO_WRITES',
 authenticated:false,checked:[],blocked:[],siteWrites:0,siteDeletes:0,
 policy:'Stop immediately on HTTP 202/401/403/429, human verification, login denied or account restriction',
 result:'NOT_STARTED'
};
const slugs={'Djilsi':'djilsi','Raska':'raska','Maxime Biaggi':'maxime-biaggi','Mastu':'346011-show'};
const manifest=JSON.parse(await fs.readFile(SRC,'utf8'));
const proof=JSON.parse(await fs.readFile(IMG,'utf8'));
const proofById=new Map(proof.rows.map(x=>[x.tvdbEpisodeId,x]));
const targets=[];
for(const creator of ['Djilsi','Raska','Maxime Biaggi','Mastu']){
 let rows=manifest.targets.filter(x=>x.creator===creator&&x.provenanceVerified===true&&
    proofById.get(x.tvdbEpisodeId)?.result?.startsWith('TECHNICALLY_VALID'));
 if(creator==='Mastu') rows=manifest.targets.filter(x=>x.creator===creator&&x.provenanceVerified===true&&
     proofById.get(x.tvdbEpisodeId)?.result?.startsWith('TECHNICALLY_VALID'));
 targets.push(...rows.slice(0,2));
}
if(!targets.length)throw Error('NO_VERIFIED_PROVENANCE_TARGETS');
const canonical=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
let browser,lock=false;
async function get(page,url){
 const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:55000});
 if(!r||![200,201].includes(r.status()))throw Error('STOP_SITE_HTTP_'+(r?.status()??'NONE')+'_'+url);
 if(lock&&/\/auth\/login/.test(page.url()))throw Error('STOP_AUTH_REDIRECT');
 const body=((await page.locator('body').innerText().catch(()=>''))||'');
 if(/captcha|verify you are human|your account (?:has been|is) (?:restricted|suspended)|you are not allowed|access denied|rate limit|checking your browser/i.test(body.slice(0,5500)))
   throw Error('STOP_SITE_RESTRICTION_OR_CHALLENGE');
 return body;
}
function artUrls(html) {
 return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<> \n]+\/episode\/\d+\/screencap\/[^"'<> \n]+/g)]
   .map(x=>x[0].replace(/&amp;/g,'&'));
}
try{
 if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)throw Error('MISSING_AUTH_SECRETS');
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({locale:'fr-FR'});
 const page=await context.newPage();
 await context.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(lock&&u.hostname.endsWith('thetvdb.com')&&!['GET','HEAD','OPTIONS'].includes(r.method().toUpperCase()))
   return route.abort('blockedbyclient');
  return route.continue();
 });
 await get(page,BASE+'/auth/login');
 const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 if(await form.count()!==1)throw Error('STOP_LOGIN_FORM_MISSING');
 await form.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
 await form.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
 await form.locator('button[type="submit"],input[type="submit"]').first().click();
 await page.waitForLoadState('domcontentloaded').catch(()=>{});
 const auth=await context.request.get(BASE+'/auth/getuser',{timeout:25000}).catch(()=>null);
 const p=await auth?.json().catch(()=>null);
 if(!auth?.ok()||!p||!Object.keys(p).length)throw Error('STOP_AUTH_NOT_CONFIRMED');
 state.authenticated=true;lock=true;
 for(const target of targets){
  const row={creator:target.creator,code:target.code,id:target.tvdbEpisodeId,
    youtubeId:target.youtubeId,imageUrl:target.selectedImageUrl,
    pageUrl:BASE+'/series/'+slugs[target.creator]+'/episodes/'+target.tvdbEpisodeId,
    status:'NOT_CHECKED'};
  try{
   await get(page,row.pageUrl);
   const html=await page.content();
   row.liveArtwork=artUrls(html);
   const headings=await page.locator('h1,h2').allTextContents();
   row.heading=headings.map(x=>x.trim()).filter(Boolean)[0]||'';
   row.expectedTitle=target.episodeTitle;
   row.titleMatched=canonical(row.heading)===canonical(target.episodeTitle);
   if(row.liveArtwork.length)row.status='ALREADY_PRESENT_SKIP';
   else if(!row.titleMatched)row.status='BLOCKED_TITLE_IDENTITY_DRIFT';
   else{
    row.status='STILL_MISSING_IDENTITY_VERIFIED';
    const upload=await page.locator('a[href*="/artwork/upload?"]').allAttributes?.().catch(()=>null);
    const hrefs=await page.locator('a[href*="/artwork/upload?"]').evaluateAll(as=>as.map(a=>a.href).slice(0,10));
    row.availableUploadLinks=hrefs;
   }
   state.checked.push(row);
  }catch(e){
   row.status='SITE_RESTRICTED_OR_UNAVAILABLE';
   row.problem=String(e?.message||e);
   state.checked.push(row);state.blocked.push(row.problem);
   break; // stop on any restriction; never retry or evade
  }
 }
 state.result=state.blocked.length?'STOPPED_ON_SITE_RESTRICTION':'READ_ONLY_COMPLETED';
}catch(e){state.blocked.push(String(e?.message||e));state.result='STOPPED_BEFORE_OR_DURING_SITE_CHECK';}
finally{await browser?.close().catch(()=>{});}
state.summary={selected:targets.length,checked:state.checked.length,alreadyPresent:state.checked.filter(x=>x.status==='ALREADY_PRESENT_SKIP').length,
 stillMissingVerified:state.checked.filter(x=>x.status==='STILL_MISSING_IDENTITY_VERIFIED').length,
 titleDrift:state.checked.filter(x=>x.status==='BLOCKED_TITLE_IDENTITY_DRIFT').length,
 blocked:state.blocked.length};
await fs.writeFile(OUT+'/report.json',JSON.stringify(state,null,2)+'\n');
console.log(JSON.stringify({result:state.result,authenticated:state.authenticated,summary:state.summary,
   checked:state.checked.map(x=>({id:x.id,creator:x.creator,code:x.code,status:x.status,uploadLinks:x.availableUploadLinks?.length})),blocked:state.blocked}));
if(state.blocked.length)process.exitCode=2;
