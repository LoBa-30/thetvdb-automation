import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const BASE='https://thetvdb.com';
const SLUG='328213-show';
if(!username||!password) throw new Error('Missing TVDB credentials');
await fs.mkdir('reports/amixem-auth-snapshot',{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'en-US',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
});
const page=await context.newPage();
let writeRequests=0, logged=false;
context.on('request',r=>{
  if(logged && r.method()==='POST' && /thetvdb\.com/i.test(r.url())) writeRequests++;
});

async function goto(url){
  let last=null;
  for(let a=1;a<=3;a++){
    last=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(last && last.status()<400){ await page.waitForTimeout(250); return; }
    await page.waitForTimeout(600*a);
  }
  throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
}

await goto(BASE+'/auth/login');
const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
await form.locator('input[name="email"]').fill(username);
await form.locator('input[name="password"]').fill(password);
await Promise.all([
  page.waitForLoadState('domcontentloaded').catch(()=>{}),
  form.locator('button[type="submit"],input[type="submit"]').first().click()
]);
await page.waitForTimeout(800);
const probe=await context.request.get(BASE+'/auth/getuser');
if(!probe.ok()) throw new Error('Authentication not proven');
let userPayload={};
try{userPayload=await probe.json();}catch{}
if(!userPayload || !Object.keys(userPayload).length) throw new Error('Empty auth user');
logged=true;

const seasons=[];
const all=[];
for(let year=2012;year<=2026;year++){
  const url=`${BASE}/series/${SLUG}/seasons/official/${year}/edit`;
  await goto(url);
  const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map((input,index)=>{
    const internalId=(input.getAttribute('name')||'').match(/^episodes\[(\d+)\]$/)?.[1]||null;
    let c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
    const a=c?.querySelector('a[href*="/episodes/"]')||null;
    const href=a?.href||'';
    return {
      index,internalId,
      publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,
      number:Number(input.value),
      title:(a?.textContent||'').replace(/\s+/g,' ').trim(),
      rowText:(c?.textContent||'').replace(/\s+/g,' ').trim(),
      href
    };
  }));
  rows.sort((a,b)=>a.number-b.number||a.index-b.index);
  seasons.push({year,count:rows.length,rows});
  for(const r of rows) all.push({season:year,...r});
  console.log('season',year,'count',rows.length);
}


const unassignedUrl=`${BASE}/series/${SLUG}/seasons/official/unassigned/edit`;
await goto(unassignedUrl);
const unassignedRows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map((input,index)=>{
  const internalId=(input.getAttribute('name')||'').match(/^episodes\[(\d+)\]$/)?.[1]||null;
  let c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
  const a=c?.querySelector('a[href*="/episodes/"]')||null;
  const href=a?.href||'';
  return {
    index,internalId,
    publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,
    number:Number(input.value)||null,
    title:(a?.textContent||'').replace(/\s+/g,' ').trim(),
    rowText:(c?.textContent||'').replace(/\s+/g,' ').trim(),
    href
  };
}));

async function inspectOne(ep,idx){
  const p=await context.newPage();
  const out={...ep};
  try{
    const editUrl=`${BASE}/series/${SLUG}/episodes/${ep.publicId}/0/edit`;
    let resp=await p.goto(editUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(!resp || resp.status()>=400) throw new Error('edit GET '+(resp?.status()??'n/a'));
    const fields=await p.locator('input,textarea,select').evaluateAll(nodes=>nodes.map(n=>{
      const name=n.getAttribute('name'); if(!name) return null;
      let value='';
      if(n.tagName==='SELECT') value=[...n.selectedOptions].map(o=>o.value).join('|');
      else if(n.type==='checkbox'||n.type==='radio') value=n.checked?n.value:'';
      else value=n.value||'';
      return {name,type:n.type||n.tagName.toLowerCase(),value};
    }).filter(Boolean));
    const pick=(rx)=>fields.find(f=>rx.test(f.name)&&f.value)?.value||null;
    out.airdate=pick(/airdate/i);
    const runtime=pick(/runtime/i); out.runtimeRaw=runtime;
    out.runtimeMinutes=runtime && /^\d+$/.test(runtime)?Number(runtime):null;
    out.titleFields=fields.filter(f=>/(name|title)/i.test(f.name)&&f.value);

    resp=await p.goto(`${BASE}/series/${SLUG}/episodes/${ep.publicId}`,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(!resp || resp.status()>=400) throw new Error('public GET '+(resp?.status()??'n/a'));
    const text=(await p.locator('body').innerText().catch(()=>'' )).replace(/\r/g,'');
    out.isSeasonPremiere=/Is a season premiere/i.test(text);
    out.isSeasonFinale=/Is a season finale/i.test(text);
    const imgs=await p.locator('img').evaluateAll(nodes=>nodes.map(n=>n.src||'').filter(Boolean));
    out.artwork=imgs.find(u=>u.includes('artworks.thetvdb.com')&&/episode\//i.test(u))||null;
    const links=await p.locator('a').evaluateAll(nodes=>nodes.map(n=>n.href||'').filter(Boolean));
    out.replaceArtworkUrl=links.find(u=>u.includes('/artwork/upload?')&&u.includes('episode='+ep.publicId)&&u.includes('replace='))||null;
    out.officialYoutubeLinks=links.filter(u=>/youtube\.com\/watch|youtu\.be\//i.test(u));
  }catch(e){ out.error=e?.message||String(e); }
  finally{await p.close();}
  if((idx+1)%25===0) console.log('episode details',idx+1,'/',all.length);
  return out;
}

// Moderate concurrency to keep TheTVDB load low and avoid timeouts.
for(const r of unassignedRows) all.push({season:'unassigned',...r});
const details=new Array(all.length);
let cursor=0;
async function worker(){
  while(true){
    const i=cursor++; if(i>=all.length) return;
    details[i]=await inspectOne(all[i],i);
  }
}
await Promise.all(Array.from({length:6},()=>worker()));

const counts={};
for(const s of seasons) counts[String(s.year)]=s.count;
counts['unassigned']=unassignedRows.length;
const report={
  generatedAt:new Date().toISOString(),
  mode:'AMIXEM_AUTHENTICATED_CURRENT_STATE_READ_ONLY',
  authenticated:true,
  writeRequestsDetected:writeRequests,
  totalEpisodes:details.length,
  unassignedCount:unassignedRows.length,
  unassignedRows,
  seasonCounts:counts,
  seasons,
  episodes:details,
  artworkPresent:details.filter(x=>x.artwork).length,
  artworkMissing:details.filter(x=>!x.artwork).length,
  errors:details.filter(x=>x.error).map(x=>({publicId:x.publicId,season:x.season,number:x.number,error:x.error}))
};
await fs.writeFile('reports/amixem-auth-snapshot/snapshot.json',JSON.stringify(report,null,2));
const lines=[
  `Mode: ${report.mode}`,
  `Authenticated: ${report.authenticated}`,
  `Write requests detected: ${writeRequests}`,
  `Total episodes: ${details.length}`,
  `Unassigned: ${unassignedRows.length}`,
  `Artwork present: ${report.artworkPresent}`,
  `Artwork missing: ${report.artworkMissing}`,
  `Errors: ${report.errors.length}`,
  ...Object.entries(counts).map(([y,c])=>`${y}: ${c}`)
];
await fs.writeFile('reports/amixem-auth-snapshot/summary.txt',lines.join('\n')+'\n');
console.log(lines.join('\n'));
await browser.close();
if(writeRequests!==0 || report.errors.length) process.exitCode=2;
