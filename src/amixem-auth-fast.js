
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username = process.env.TVDB_USERNAME;
const password = process.env.TVDB_PASSWORD;
const BASE='https://thetvdb.com';
const SLUG='328213-show';
const OUT='reports/amixem-auth-fast';
await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),authenticated:false,seasons:{},unassigned:[],targets:{},result:'NOT_STARTED'};

if(!username||!password) throw new Error('Missing TVDB credentials');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(url){
  let r=null;
  for(let i=0;i<4;i++){
    r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(r && r.status()<400){await page.waitForTimeout(300);return;}
    await page.waitForTimeout(600*(i+1));
  }
  throw new Error('GET failed '+url+' '+(r?.status()??'n/a'));
}
async function login(){
  await go(BASE+'/auth/login');
  const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await f.locator('input[name="email"]').fill(username);
  await f.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(700);
  const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
  return Boolean(p?.ok());
}
async function readSeason(year){
  await go(\`\${BASE}/series/\${SLUG}/seasons/official/\${year}/edit\`);
  const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
    const internalId=(input.getAttribute('name')||'').match(/^episodes\[(\d+)\]$/)?.[1]||null;
    const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
    const a=c?.querySelector('a[href*="/episodes/"]')||null;
    const href=a?.href||'';
    return {
      internalId,
      publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,
      number:Number(input.value)||null,
      title:(a?.textContent||'').replace(/\s+/g,' ').trim(),
      rowText:(c?.textContent||'').replace(/\s+/g,' ').trim(),
      href
    };
  }));
  return rows;
}
async function readUnassigned(){
  await go(\`\${BASE}/series/\${SLUG}/seasons/official/unassigned/edit\`);
  return await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
    const internalId=(input.getAttribute('name')||'').match(/^episodes\[(\d+)\]$/)?.[1]||null;
    const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
    const a=c?.querySelector('a[href*="/episodes/"]')||null;
    const href=a?.href||'';
    return {
      internalId,
      publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,
      number:Number(input.value)||null,
      title:(a?.textContent||'').replace(/\s+/g,' ').trim(),
      rowText:(c?.textContent||'').replace(/\s+/g,' ').trim(),
      href
    };
  }));
}
async function readEpisode(publicId){
  await go(\`\${BASE}/series/\${SLUG}/episodes/\${publicId}/0/edit\`);
  const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();
  const airdate=await f.locator('input[name="airdate"]').first().inputValue().catch(()=>'');
  const runtime=await f.locator('input[name="runtime"]').first().inputValue().catch(()=>'');
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
  return {publicId,airdate,runtime:Number(runtime)||null,body:body.slice(0,2000)};
}

try{
  report.authenticated=await login();
  if(!report.authenticated) throw new Error('Authentication not proven');
  for(let y=2012;y<=2026;y++) report.seasons[y]=await readSeason(y);
  report.unassigned=await readUnassigned();

  const ids=new Set();
  for(const y of [2016,2017,2020]){
    for(const r of report.seasons[y]||[]){
      if((y===2016 && [97,98].includes(r.number)) ||
         (y===2017 && r.number>=10 && r.number<=22) ||
         (y===2020 && [61,72,73].includes(r.number))) ids.add(r.publicId);
    }
  }
  for(const id of ids) if(id) report.targets[id]=await readEpisode(id);
  report.result='OK_READ_ONLY';
}catch(e){
  report.result='FAILED';
  report.error=e?.stack||String(e);
}finally{
  await browser.close();
}
await fs.writeFile(OUT+'/snapshot.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'result='+report.result,
  'seasonCounts='+JSON.stringify(Object.fromEntries(Object.entries(report.seasons).map(([y,v])=>[y,v.length]))),
  'unassigned='+report.unassigned.length,
  ...report.unassigned.map(x=>\`UNASSIGNED | \${x.publicId} | E\${x.number} | \${x.title} | \${x.rowText}\`)
].join('\n'));
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='OK_READ_ONLY') process.exitCode=2;
