import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

// Two verified 2026 title typos only. Never change artwork, numbering, dates,
// runtime, episode existence, other translations, or unrelated metadata.
const BASE='https://thetvdb.com';
const SLUG='338282-show';
const OUT='reports/mcfly-2026-e61-e62-title-repair';
const TARGETS=[
  {
    id:'12024665',code:'S2026E61',date:'2026-10-08',
    youtubeId:'ndo5rHMsBNk',
    from:'On découvre Wikimasters (faite monter Mcfly & Carlito en Légendaire svp)',
    to:'On découvre Wikimasters (faites monter Mcfly & Carlito en Légendaire svp)'
  },
  {
    id:'12031978',code:'S2026E62',date:'2026-10-12',
    youtubeId:'dcSfEaDVMOM',
    from:'LA BATTLE DES PAYS :on déguste les spécialitées béninoises avec Theodort SHEEEEESH',
    to:'LA BATTLE DES PAYS : on déguste les spécialités béninoises avec Theodort SHEEEEESH'
  }
];
await fs.mkdir(OUT,{recursive:true});
const report={
  generatedAt:new Date().toISOString(),
  mode:'GUARDED_TWO_FRENCH_TITLES_ONLY_NO_ARTWORK_OPERATIONS',
  evidence:'Live public TheTVDB episode pages and official YouTube watch titles verified 2026-10-15',
  targets:TARGETS,
  authenticated:false,
  preflight:[],attempts:[],verified:[],skipped:[],blocked:[],
  siteWritesAttempted:0,
  siteWritesVerified:0,
  artworkWrites:0,
  destructiveActions:0,
  result:'NOT_STARTED'
};
const norm=value=>String(value||'').normalize('NFC').replace(/\s+/g,' ').trim();
let browser=null;
let context=null;
let page=null;
let armedPath=null;
let refusedRequest=null;
async function stop(reason){throw new Error(reason);}
async function go(url){
  const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  if(!response||response.status()>=400)await stop('READ_HTTP_'+(response?.status()||'NONE'));
  if(/\/auth\/login/.test(page.url())&&!/\/auth\/login/.test(url))await stop('LOGIN_REDIRECT');
  const body=(await page.locator('body').innerText().catch(()=>'')).slice(0,1800);
  if(/captcha|verify you are human|access denied|too many requests|rate limit|temporary restricted|security challenge/i.test(body))
    await stop('SITE_RESTRICTION_OR_CHALLENGE');
}
async function login(){
  await go(BASE+'/auth/login');
  const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  if(await form.count()!==1)await stop('LOGIN_FORM_ABSENT');
  await form.locator('input[name="email"]').fill(process.env.TVDB_USERNAME);
  await form.locator('input[name="password"]').fill(process.env.TVDB_PASSWORD);
  await form.locator('button[type="submit"],input[type="submit"]').first().click();
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  const probe=await context.request.get(BASE+'/auth/getuser',{timeout:30000}).catch(()=>null);
  const user=await probe?.json().catch(()=>null);
  if(!probe?.ok()||!user||typeof user!=='object'||!Object.keys(user).length)await stop('LOGIN_NOT_VERIFIED');
  report.authenticated=true;
  // After login, block every non-read site action except the exact single
  // French translation form POST currently authorized inside submit().
  await context.route('**/*',async route=>{
    const request=route.request();
    const url=new URL(request.url());
    const method=request.method().toUpperCase();
    if(url.hostname==='thetvdb.com' && !['GET','HEAD','OPTIONS'].includes(method)){
      if(method!=='POST'||!armedPath||url.pathname!==armedPath){
        refusedRequest=method+' '+url.pathname;
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });
}
async function publicEpisode(target){
  await go(BASE+'/series/'+SLUG+'/episodes/'+target.id);
  const title=norm(await page.locator('h1').first().innerText().catch(()=>''));
  const text=norm(await page.locator('body').innerText().catch(()=>''));
  if(!text.includes('Season 2026')||!text.includes('Episode '+Number(target.code.slice(-2))))await stop('EPISODE_BREADCRUMB_DRIFT_'+target.id);
  if(![target.from,target.to].includes(title))await stop('PUBLIC_TITLE_DRIFT_'+target.id+' '+title);
  const episodeLink=page.locator('a[href*="/episodes/'+target.id+'/translate/"]').first();
  const href=await episodeLink.getAttribute('href').catch(()=>null);
  return {title,translationHref:href};
}
async function frenchForm(target,href){
  if(!href)await stop('TRANSLATION_LINK_MISSING_'+target.id);
  await go(new URL(href,BASE).href);
  let forms=page.locator('form').filter({has:page.locator('[name="episode_name"]')});
  if(await forms.count()===0){
    const links=await page.locator('a[href*="/translate/"]').evaluateAll(els=>els.map(a=>({
      text:(a.textContent||'').trim(),href:a.getAttribute('href')
    })).filter(x=>x.href));
    const fr=links.find(x=>/fran[cç]ais|french/i.test(x.text)||/\/fra(?:\/|$)/i.test(x.href)||/\/fr(?:\/|$)/i.test(x.href));
    if(!fr)await stop('FRENCH_FORM_LINK_MISSING_'+target.id);
    await go(new URL(fr.href,BASE).href);
    forms=page.locator('form').filter({has:page.locator('[name="episode_name"]')});
  }
  const candidates=[];
  for(let i=0;i<await forms.count();i++){
    const form=forms.nth(i);
    const language=await form.locator('[name="language"]').first().inputValue().catch(()=>'');
    const field=form.locator('input[name="episode_name"],textarea[name="episode_name"]').first();
    const title=norm(await field.inputValue().catch(()=>''));
    if(language==='fra'||title===target.from||title===target.to){
      const raw=await form.getAttribute('action');
      const action=new URL(raw||'',BASE);
      const method=(await form.getAttribute('method')||'GET').toUpperCase();
      // TheTVDB's authenticated French translation form uses one shared route.
      // Accept it ONLY from the exact immutable-ID French form page, never from
      // another language, another episode or an unknown POST destination.
      const expectedPage='/series/'+SLUG+'/episodes/'+target.id+'/translate/fra/0/single';
      const exactFrenchPage=new URL(page.url()).pathname===expectedPage;
      const exactStore=action.pathname==='/episodes/translatestore';
      if(action.origin!==BASE||method!=='POST'||language!=='fra'||!exactFrenchPage||!exactStore)
        await stop('TRANSLATION_FORM_ACTION_UNEXPECTED_'+target.id);
      if(await form.locator('input[name="_token"]').count()!==1)
        await stop('MISSING_UNIQUE_CSRF_TOKEN_'+target.id);
      candidates.push({form,field,title,action:action.pathname,language});
    }
  }
  if(candidates.length!==1)await stop('FRENCH_TRANSLATION_NON_UNIQUE_'+target.id+'_'+candidates.length);
  return candidates[0];
}
async function verifyPublic(target){
  const current=await publicEpisode(target);
  return {title:current.title,correct:current.title===target.to};
}
async function submitOne(target,form){
  if(form.title!==target.from)await stop('FORM_SOURCE_TITLE_DRIFT_'+target.id+'_'+form.title);
  if(!(await form.form.evaluate(f=>f.checkValidity())))await stop('INVALID_FORM_BEFORE_WRITE_'+target.id);
  await form.field.fill(target.to);
  if(!(await form.form.evaluate(f=>f.checkValidity())))await stop('INVALID_FORM_AFTER_FILL_'+target.id);
  // Exactly one POST for exactly this episode's translation. Never retry blindly.
  armedPath=form.action;
  report.siteWritesAttempted++;
  report.attempts.push({id:target.id,code:target.code,action:form.action,from:form.title,to:target.to});
  try{
    await form.form.evaluate(f=>f.requestSubmit());
    await page.waitForLoadState('domcontentloaded').catch(()=>{});
  }finally{
    armedPath=null;
  }
  if(refusedRequest)await stop('UNEXPECTED_NON_READ_REQUEST_'+refusedRequest);
  const after=await verifyPublic(target);
  report.verified.push({id:target.id,code:target.code,publicTitle:after.title,correct:after.correct});
  if(!after.correct)await stop('TITLE_POST_NOT_VERIFIED_'+target.id);
  report.siteWritesVerified++;
}
try{
  if(process.env.TVDB_MCFLY_2026_TITLE_FIX!=='yes')await stop('NOT_ARMED');
  if(!process.env.TVDB_USERNAME||!process.env.TVDB_PASSWORD)await stop('MISSING_CREDENTIALS');
  browser=await chromium.launch({headless:true});
  context=await browser.newContext({locale:'fr-FR'});
  page=await context.newPage();
  await login();
  // Fail closed before the first write if either public record changed.
  for(const target of TARGETS){
    const before=await publicEpisode(target);
    report.preflight.push({id:target.id,code:target.code,currentTitle:before.title,sourceYoutubeId:target.youtubeId,
      knownOriginalTitle:target.from,knownOfficialTitle:target.to});
  }
  for(const target of TARGETS){
    const current=await publicEpisode(target);
    if(current.title===target.to){
      report.skipped.push({id:target.id,reason:'ALREADY_CORRECT'});
      continue;
    }
    const form=await frenchForm(target,current.translationHref);
    await submitOne(target,form);
  }
  report.result=report.siteWritesVerified ? 'APPLIED_AND_VERIFIED' : 'ALREADY_CORRECT_NO_WRITE';
}catch(error){
  report.blocked.push({reason:String(error?.message||error)});
  report.result=report.siteWritesAttempted>report.siteWritesVerified?'ATTEMPT_UNCONFIRMED_STOP_NO_RETRY':'BLOCKED_NO_FURTHER_WRITES';
}finally{
  if(browser)await browser.close().catch(()=>{});
}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({result:report.result,authenticated:report.authenticated,siteWritesAttempted:report.siteWritesAttempted,
  siteWritesVerified:report.siteWritesVerified,skips:report.skipped.length,blocked:report.blocked,
  artworkWrites:0,destructiveActions:0}));
if(!['APPLIED_AND_VERIFIED','ALREADY_CORRECT_NO_WRITE'].includes(report.result))process.exitCode=2;
