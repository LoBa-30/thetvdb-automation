import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');

const BASE='https://thetvdb.com';
const SLUG='346011-show';
const OUT='reports/mastu-unassigned-duplicate-preflight';
const cases=[
  {source:'11467024',sourceTitle:'FAITES MOI RIRE BORDEL',sourceDate:'October 28, 2018',targetSeason:2018,targetEpisode:31,targetTitle:'FAITES MOI RIRE BORDEL',targetDate:'October 28, 2018',youtubeId:'ySeuAx4Ho08'},
  {source:'11467025',sourceTitle:"MA VIE AVANT D'ÊTRE CONNU....",sourceDate:'December 5, 2018',targetSeason:2018,targetEpisode:35,targetTitle:"MA VIE AVANT D'ÊTRE CONNU...",targetDate:'December 5, 2018',youtubeId:'RITZtm8aFuA'},
  {source:'11467026',sourceTitle:"MAIS QU'EST-CE QUE VOUS AVEZ...",sourceDate:'December 15, 2018',targetSeason:2018,targetEpisode:36,targetTitle:"MAIS QU'EST-CE QUE VOUS AVEZ...",targetDate:'December 15, 2018',youtubeId:'GaCs2inZdjY'},
  {source:'11964033',sourceTitle:"Y'A QUI DANS LA BOÎTE ? (Avec Maghla et Raska)",sourceDate:'March 9, 2024',targetSeason:2024,targetEpisode:3,targetTitle:"Y'A QUI DANS LA BOÎTE ? (Avec Maghla et Raska)",targetDate:'March 9, 2024',youtubeId:'0T-dpx4dYJs'}
];

await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function goto(p,url){
  let last=null;
  for(let a=1;a<=3;a++){
    last=await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(last && last.status()<400){await p.waitForTimeout(250);return last;}
    await p.waitForTimeout(500*a);
  }
  throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
}

// Authenticate using existing project credentials.
await goto(page,BASE+'/auth/login');
const form=page.locator('form').filter({has:page.locator('input[type=password]')}).first();
await form.locator('input[name=email]').fill(username);
await form.locator('input[name=password]').fill(password);
await form.locator('button[type=submit],input[type=submit]').first().click({noWaitAfter:true});
await page.waitForTimeout(1200);
const probe=await context.request.get(BASE+'/auth/getuser');
if(!probe.ok()) throw new Error('Authentication not proven; possible human verification');
let up={}; try{up=await probe.json();}catch{}
if(!up||!Object.keys(up).length) throw new Error('Empty authenticated user');

// Enforce read-only after login.
const blocked=[];
await context.route('**/*',async route=>{
  const req=route.request(); const method=req.method().toUpperCase();
  if(/thetvdb\.com/i.test(req.url()) && !['GET','HEAD','OPTIONS'].includes(method)){
    blocked.push({method,url:req.url()}); return route.abort('blockedbyclient');
  }
  return route.continue();
});

const seasonMaps={};
for(const year of [...new Set(cases.map(c=>c.targetSeason))]){
  await goto(page,`${BASE}/series/${SLUG}/seasons/official/${year}/edit`);
  const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
    const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
    const a=c?.querySelector('a[href*="/episodes/"]');
    return {
      number:Number(input.value),
      publicId:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,
      title:(a?.textContent||'').replace(/\s+/g,' ').trim(),
      rowText:(c?.textContent||'').replace(/\s+/g,' ').trim()
    };
  }));
  seasonMaps[String(year)]=rows;
}

const result={generatedAt:new Date().toISOString(),target:'Mastu',mode:'AUTHENTICATED_READ_ONLY_DUPLICATE_PREFLIGHT',cases:[],blockedNonReadRequests:blocked};
for(const c of cases){
  const action={...c,status:'pending',checks:{}};
  try{
    const targetRow=(seasonMaps[String(c.targetSeason)]||[]).find(r=>r.number===c.targetEpisode);
    action.targetId=targetRow?.publicId||null;
    action.checks.targetRow=targetRow||null;
    if(!action.targetId) throw new Error('Target public ID not found');

    await goto(page,`${BASE}/series/${SLUG}/episodes/${c.source}`);
    const sb=(await page.locator('body').innerText()).replace(/\s+/g,' ');
    action.checks.sourceTitleExact=sb.toLowerCase().includes(c.sourceTitle.toLowerCase());
    action.checks.sourceDateExact=sb.includes(c.sourceDate);
    const del=page.locator('form[action*="/entity/delete"]').first();
    action.checks.sourceDeleteFormPresent=(await del.count())>0;
    if(action.checks.sourceDeleteFormPresent){
      action.checks.sourceFormId=await del.locator('input[name=id]').inputValue().catch(()=>null);
      action.checks.sourceFormType=await del.locator('input[name=type]').inputValue().catch(()=>null);
    }

    await goto(page,`${BASE}/series/${SLUG}/episodes/${action.targetId}`);
    const tb=(await page.locator('body').innerText()).replace(/\s+/g,' ');
    action.checks.targetTitleExact=tb.toLowerCase().includes(c.targetTitle.toLowerCase());
    action.checks.targetDateExact=tb.includes(c.targetDate);
    action.status=(
      action.checks.sourceTitleExact &&
      action.checks.sourceDateExact &&
      action.checks.sourceDeleteFormPresent &&
      action.checks.sourceFormId===c.source &&
      action.checks.sourceFormType==='3' &&
      action.checks.targetTitleExact &&
      action.checks.targetDateExact
    )?'EXACT_DUPLICATE_PREFLIGHT_OK':'BLOCKED_MISMATCH';
  }catch(e){action.status='ERROR';action.error=String(e?.message||e);}
  result.cases.push(action);
}
result.success=result.cases.every(x=>x.status==='EXACT_DUPLICATE_PREFLIGHT_OK');
result.blockedNonReadRequests=blocked;
await browser.close();
await fs.writeFile(`${OUT}/report.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
if(!result.success) process.exitCode=2;
