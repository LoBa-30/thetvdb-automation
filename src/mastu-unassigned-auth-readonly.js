import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');

const BASE='https://thetvdb.com';
const SLUG='346011-show';
const OUT='reports/mastu-unassigned-auth';
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'en-US',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
});
const page=await context.newPage();

let logged=false,writeRequests=0;
context.on('request',r=>{
  if(logged && r.method()==='POST' && /thetvdb\.com/i.test(r.url())) writeRequests++;
});

async function goto(p,url){
  let last=null;
  for(let a=1;a<=3;a++){
    last=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(last && last.status()<400){await p.waitForTimeout(250);return last;}
    await p.waitForTimeout(600*a);
  }
  throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
}

// Existing project login flow. No challenge bypass.
await goto(page,BASE+'/auth/login');
const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
await form.locator('input[name="email"]').fill(username);
await form.locator('input[name="password"]').fill(password);
await Promise.all([
  page.waitForLoadState('domcontentloaded').catch(()=>{}),
  form.locator('button[type="submit"],input[type="submit"]').first().click()
]);
await page.waitForTimeout(800);
const probe=await context.request.get(BASE+'/auth/getuser');
if(!probe.ok()) throw new Error('Authentication not proven; possible human verification or session failure');
let userPayload={};
try{userPayload=await probe.json();}catch{}
if(!userPayload || !Object.keys(userPayload).length) throw new Error('Empty authenticated user payload');
logged=true;

const url=`${BASE}/series/${SLUG}/seasons/official/unassigned/edit`;
await goto(page,url);
const pageTitle=await page.title();
if(/login/i.test(pageTitle)) throw new Error('Authenticated request redirected to login');

const rows=await page.locator('a[href*="/series/'+SLUG+'/episodes/"]').evaluateAll(as=>{
  const out=[]; const seen=new Set();
  for(const a of as){
    const href=a.href||''; const m=href.match(/\/episodes\/(\d+)/);
    if(!m||seen.has(m[1])) continue;
    seen.add(m[1]);
    const c=a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement;
    out.push({
      id:m[1],
      href,
      linkText:(a.textContent||'').replace(/\s+/g,' ').trim(),
      rowText:(c?.textContent||'').replace(/\s+/g,' ').trim()
    });
  }
  return out;
});

const report={
  generatedAt:new Date().toISOString(),
  target:'Mastu',
  mode:'AUTHENTICATED_READ_ONLY',
  authenticated:true,
  listing:{url,pageTitle,count:rows.length,rows},
  episodes:[],
  errors:[]
};

for(const row of rows){
  const p=await context.newPage();
  try{
    await goto(p,row.href);
    const body=(await p.locator('body').innerText()).replace(/\s+/g,' ').trim();
    const hs=await p.locator('h1,h2').allTextContents();
    const heading=hs.map(x=>x.trim()).find(Boolean)||null;
    const aired=body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null;
    const runtime=body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1]||null;
    const links=await p.locator('a').evaluateAll(nodes=>nodes.map(n=>n.href||'').filter(Boolean));
    report.episodes.push({
      id:row.id,rowText:row.rowText,pageUrl:row.href,pageTitle:await p.title(),heading,
      firstAired:aired,runtimeMinutes:runtime?Number(runtime):null,
      officialYoutubeLinks:links.filter(u=>/youtube\.com\/watch|youtu\.be\//i.test(u)),
      bodyPreview:body.slice(0,2200)
    });
  }catch(e){report.errors.push({id:row.id,error:String(e?.message||e)});}
  finally{await p.close();}
}

report.writeRequestsDetected=writeRequests;
await fs.writeFile(`${OUT}/report.json`,JSON.stringify(report,null,2));
await fs.writeFile(`${OUT}/summary.txt`,
  [
    'Mastu authenticated Unassigned read-only',
    'Authenticated: true',
    'Found: '+rows.length,
    'Read: '+report.episodes.length,
    'Errors: '+report.errors.length,
    'Write requests detected: '+writeRequests
  ].join('\n')+'\n'
);
console.log('found='+rows.length+' read='+report.episodes.length+' errors='+report.errors.length+' writes='+writeRequests);
await browser.close();
if(report.errors.length||writeRequests!==0) process.exitCode=2;
