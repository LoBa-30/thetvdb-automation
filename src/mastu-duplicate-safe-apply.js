import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');

const BASE='https://thetvdb.com';
const SLUG='346011-show';
const OUT='reports/mastu-unassigned-duplicate-apply';
const cases=[
  {source:'11467024',target:'6941556',sourceTitle:'FAITES MOI RIRE BORDEL',targetTitle:'FAITES MOI RIRE BORDEL',date:'October 28, 2018',youtubeId:'ySeuAx4Ho08'},
  {source:'11467025',target:'6941574',sourceTitle:"MA VIE AVANT D'ÊTRE CONNU....",targetTitle:"MA VIE AVANT D'ÊTRE CONNU...",date:'December 5, 2018',youtubeId:'RITZtm8aFuA'},
  {source:'11467026',target:'6941585',sourceTitle:"MAIS QU'EST-CE QUE VOUS AVEZ...",targetTitle:"MAIS QU'EST-CE QUE VOUS AVEZ...",date:'December 15, 2018',youtubeId:'GaCs2inZdjY'},
  {source:'11964033',target:'10372642',sourceTitle:"Y'A QUI DANS LA BOÎTE ? (Avec Maghla et Raska)",targetTitle:"Y'A QUI DANS LA BOÎTE ? (Avec Maghla et Raska)",date:'March 9, 2024',youtubeId:'0T-dpx4dYJs'}
];

await fs.mkdir(OUT,{recursive:true});
const result={
  generatedAt:new Date().toISOString(),
  target:'Mastu',
  mode:'EXACT_DUPLICATE_DELETE_WITH_MERGE',
  evidence:{auditRun:37491514915,preflightReport:'reports/mastu-unassigned-duplicate-preflight/report.json'},
  actions:[]
};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function goto(url){
  let last=null;
  for(let a=1;a<=3;a++){
    last=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    if(last && last.status()<400){await page.waitForTimeout(300);return last;}
    await page.waitForTimeout(600*a);
  }
  return last;
}

// Login. No challenge bypass.
await page.goto(BASE+'/auth/login',{waitUntil:'domcontentloaded',timeout:60000});
const login=page.locator('form').filter({has:page.locator('input[type=password]')}).first();
await login.locator('input[name=email]').fill(username);
await login.locator('input[name=password]').fill(password);
await login.locator('button[type=submit],input[type=submit]').first().click({noWaitAfter:true});
await page.waitForTimeout(1200);
const probe=await context.request.get(BASE+'/auth/getuser');
if(!probe.ok()) throw new Error('Authentication not proven; possible human verification');
let up={}; try{up=await probe.json();}catch{}
if(!up||!Object.keys(up).length) throw new Error('Empty authenticated user');

for(const c of cases){
  const action={...c,status:'pending',checks:{}};
  try{
    // Fresh canonical target verification.
    const tr=await goto(`${BASE}/series/${SLUG}/episodes/${c.target}`);
    if(!tr||tr.status()>=400) throw new Error('Target unavailable');
    const targetBody=(await page.locator('body').innerText()).replace(/\s+/g,' ');
    action.checks.targetHttp=tr.status();
    action.checks.targetTitleExact=targetBody.toLowerCase().includes(c.targetTitle.toLowerCase());
    action.checks.targetDateExact=targetBody.includes(c.date);
    if(!action.checks.targetTitleExact||!action.checks.targetDateExact) throw new Error('Canonical target mismatch');

    // Fresh source verification immediately before delete.
    const sr=await goto(`${BASE}/series/${SLUG}/episodes/${c.source}`);
    if(!sr||sr.status()>=400){ action.status='already-absent'; result.actions.push(action); continue; }
    const sourceBody=(await page.locator('body').innerText()).replace(/\s+/g,' ');
    action.checks.sourceHttpBefore=sr.status();
    action.checks.sourceTitleExact=sourceBody.toLowerCase().includes(c.sourceTitle.toLowerCase());
    action.checks.sourceDateExact=sourceBody.includes(c.date);
    if(!action.checks.sourceTitleExact||!action.checks.sourceDateExact) throw new Error('Source changed since preflight');

    const del=page.locator('form[action*="/entity/delete"]').first();
    if(!(await del.count())){ action.status='already-absent'; result.actions.push(action); continue; }
    const hiddenId=await del.locator('input[name=id]').inputValue();
    const hiddenType=await del.locator('input[name=type]').inputValue();
    action.checks.formSourceId=hiddenId;
    action.checks.formType=hiddenType;
    if(hiddenId!==c.source||hiddenType!=='3') throw new Error('Delete form identity mismatch');

    const values=await del.evaluate((form,target)=>{
      const reason=form.querySelector('select[name="delete-reason"]');
      const mergeType=form.querySelector('select[name="mergeto_entitytype"]');
      const mergeId=form.querySelector('input[name="mergeto_id"]');
      if(!reason||!mergeType||!mergeId) return null;
      reason.value='50';
      mergeType.value='3';
      mergeId.value=target;
      return Object.fromEntries([...new FormData(form).entries()]);
    },c.target);
    if(!values) throw new Error('Delete form fields missing');
    action.checks.formValues={deleteReason:values['delete-reason'],mergeType:values['mergeto_entitytype'],mergeId:values['mergeto_id']};
    if(values['delete-reason']!=='50'||values['mergeto_entitytype']!=='3'||values['mergeto_id']!==c.target) throw new Error('Delete payload mismatch');

    const actionUrl=await del.evaluate(form=>form.action);
    const submit=await page.evaluate(async ({actionUrl,values})=>{
      const body=new URLSearchParams();
      for(const [k,v] of Object.entries(values)) body.append(k,String(v));
      const r=await fetch(actionUrl,{
        method:'POST',body,credentials:'include',redirect:'follow',
        headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'}
      });
      return {status:r.status,url:r.url,text:(await r.text()).slice(0,900)};
    },{actionUrl,values});
    action.checks.submitHttp=submit.status;
    action.checks.submitUrl=submit.url;
    action.checks.submitBodyPreview=(submit.text||'').replace(/\s+/g,' ').slice(0,400);
    if(submit.status>=400) throw new Error('Delete POST failed with HTTP '+submit.status);

    await page.waitForTimeout(900);

    // Verify source removed.
    const vr=await page.goto(`${BASE}/series/${SLUG}/episodes/${c.source}`,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
    await page.waitForTimeout(250);
    const stillDelete=await page.locator(`form[action*="/entity/delete"] input[name=id][value="${c.source}"]`).count().catch(()=>0);
    action.checks.sourceHttpAfter=vr?.status()??null;
    action.checks.sourceStillEditable=stillDelete>0;
    if(stillDelete>0) throw new Error('Source still editable after delete');

    // Verify target remains.
    const tv=await goto(`${BASE}/series/${SLUG}/episodes/${c.target}`);
    if(!tv||tv.status()>=400) throw new Error('Target missing after merge');
    const tb=(await page.locator('body').innerText()).replace(/\s+/g,' ');
    action.checks.targetStillMatches=tb.toLowerCase().includes(c.targetTitle.toLowerCase())&&tb.includes(c.date);
    if(!action.checks.targetStillMatches) throw new Error('Target verification failed after merge');

    action.status='DELETED_AND_VERIFIED';
  }catch(e){
    action.status='ERROR';
    action.error=String(e?.message||e);
  }
  result.actions.push(action);
  if(action.status==='ERROR') break;
}

// Final Unassigned listing verification for processed sources only.
try{
  await goto(`${BASE}/series/${SLUG}/seasons/official/unassigned/edit`);
  const ids=await page.locator(`a[href*="/series/${SLUG}/episodes/"]`).evaluateAll(as=>as.map(a=>(a.href.match(/\/episodes\/(\d+)/)||[])[1]).filter(Boolean));
  result.finalUnassignedIds=ids;
  result.processedSourcesStillUnassigned=cases.filter(c=>ids.includes(c.source)).map(c=>c.source);
}catch(e){ result.finalListingError=String(e?.message||e); }

await browser.close();
result.success=result.actions.length===cases.length && result.actions.every(a=>['DELETED_AND_VERIFIED','already-absent'].includes(a.status)) && (result.processedSourcesStillUnassigned||[]).length===0;
await fs.writeFile(`${OUT}/report.json`,JSON.stringify(result,null,2));
await fs.writeFile(`${OUT}/summary.txt`,
  [
    'Mastu exact duplicate apply',
    'Success: '+result.success,
    ...result.actions.map(a=>a.source+' -> '+a.target+': '+a.status+(a.error?' | '+a.error:''))
  ].join('\n')+'\n'
);
console.log(JSON.stringify(result,null,2));
if(!result.success) process.exitCode=2;
