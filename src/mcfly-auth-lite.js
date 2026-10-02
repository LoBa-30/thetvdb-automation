import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME, password=process.env.TVDB_PASSWORD;
const BASE='https://thetvdb.com', SLUG='338282-show';
if(!username||!password) throw new Error('Missing TVDB credentials');
await fs.mkdir('reports/mcfly-auth-lite',{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
let writeRequests=0,logged=false;
context.on('request',r=>{if(logged&&r.method()==='POST'&&/thetvdb\.com/i.test(r.url())) writeRequests++;});
async function go(p,u){const r=await p.goto(u,{waitUntil:'domcontentloaded',timeout:60000});if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));await p.waitForTimeout(300);}
await go(page,BASE+'/auth/login');
const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);
await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
await page.waitForTimeout(500);
const probe=await context.request.get(BASE+'/auth/getuser'); if(!probe.ok()) throw new Error('Authentication not proven'); logged=true;
const report={generatedAt:new Date().toISOString(),authenticated:true,writeRequestsDetected:0,unassigned:{rows:[],url:null,bodyPreview:null},translations:[],knownMetadata:[]};
for(const u of [
  `${BASE}/series/${SLUG}/seasons/official/unassigned/edit`,
  `${BASE}/series/${SLUG}/seasons/official/0/edit`
]){
 try{
  await go(page,u);
  const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
    const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
    const a=c?.querySelector('a[href*="/episodes/"]');
    return {internalId:(input.name||'').match(/^episodes\[(\d+)\]$/)?.[1]||null,number:Number(input.value)||null,publicId:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim(),href:a?.href||null};
  }));
  if(rows.length){report.unassigned={url:u,rows,bodyPreview:null};break;}
  report.unassigned.bodyPreview=((await page.locator('body').innerText()).replace(/\s+/g,' ').trim()).slice(0,600);
 }catch(e){report.unassigned.error=(report.unassigned.error?report.unassigned.error+' | ':'')+(e?.message||String(e));}
}
const ids=['9381309','10677628','10714431','11595720','11614913','11792871','11879094'];
for(const id of ids){
 const p=await context.newPage();const o={publicId:id};
 try{
  await go(p,`${BASE}/series/${SLUG}/episodes/${id}/translate/fra/0/single`);
  const tf=p.locator('form').filter({has:p.locator('input[name="episode_name"]')}).first();
  o.title=await tf.locator('input[name="episode_name"]').inputValue();o.translationAction=await tf.getAttribute('action');
  await go(p,`${BASE}/series/${SLUG}/episodes/${id}/0/edit`);
  const mf=p.locator('form').filter({has:p.locator('input[name="airdate"],input[name="runtime"]')}).first();
  o.airdate=await mf.locator('input[name="airdate"]').inputValue();o.runtime=Number(await mf.locator('input[name="runtime"]').inputValue());
  o.metaAction=await mf.getAttribute('action');
 }catch(e){o.error=e?.message||String(e);}finally{await p.close();}
 report.knownMetadata.push(o);
}
report.writeRequestsDetected=writeRequests;
await fs.writeFile('reports/mcfly-auth-lite/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/mcfly-auth-lite/summary.txt',[
 `authenticated=${report.authenticated}`,`writes=${writeRequests}`,`unassignedRows=${report.unassigned.rows.length}`,
 ...report.knownMetadata.map(x=>`${x.publicId} | ${x.airdate||''} | ${x.runtime??''} | ${x.title||x.error||''}`)
].join('\n')+'\n');
console.log(await fs.readFile('reports/mcfly-auth-lite/summary.txt','utf8'));
await browser.close(); if(writeRequests!==0) process.exitCode=2;