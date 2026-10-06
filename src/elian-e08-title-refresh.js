import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_E08_TITLE_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',ID='12014528';
const FROM='Nos cabanes vont-elles résister au Loup ?! (ft. Maxime Biaggi)';
const TO="On s'affronte pour construire la meilleure cabane ! ft. Maxime Biaggi";
const OUT='reports/elian-e08-title-refresh';
await fs.mkdir(OUT,{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),target:'Elian S2026E08',youtubeId:'xkGjW_FR8vI',mode:'GUARDED_CURRENT_TITLE_REFRESH_V3_NORMAL_LANGUAGE_NAVIGATION',authenticated:false,writes:[],skips:[],blocked:[],checks:[],verification:null,result:'NOT_STARTED'};
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();

async function go(u){
 let r=null;
 for(let i=1;i<=4;i++){
  r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(r&&r.status()<400){await page.waitForTimeout(350);return r;}
  await page.waitForTimeout(i*700);
 }
 throw new Error('GET '+u+' '+(r?.status()??'n/a'));
}

async function publicEpisode(){
 await go(BASE+'/series/'+SLUG+'/episodes/'+ID);
 const heading=norm(await page.locator('h1').first().innerText().catch(()=>''));
 const body=norm(await page.locator('body').innerText().catch(()=>''));
 const href=await page.locator('a[href*="/episodes/'+ID+'/translate/"]').first().getAttribute('href').catch(()=>null);
 const date=body.match(/ORIGINALLY AIRED\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1]||null;
 const runtime=Number(body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1])||null;
 return {heading,body,translateHref:href,date,runtime};
}

async function translationForm(href){
 await go(new URL(href,BASE).href);
 let forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});
 let count=await forms.count();
 const links=await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.textContent||'').replace(/\\s+/g,' ').trim(),href:a.getAttribute('href')})).filter(x=>x.href&&x.href.includes('/translate/')));
 report.checks.push({translationUrl:page.url(),translationFormCount:count,translationLinks:links.slice(0,30)});
 if(!count){
   const french=links.find(x=>/fran[cç]ais|french/i.test(x.text)||/\/fra(?:\/|$)/i.test(x.href)||/\/fr(?:\/|$)/i.test(x.href));
   if(french){
     await go(new URL(french.href,BASE).href);
     forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});
     count=await forms.count();
     report.checks.push({frenchTranslationUrl:page.url(),translationFormCountAfterFrenchLink:count});
   }
 }
 if(!count){
   const body=norm(await page.locator('body').innerText().catch(()=>''));
   report.checks.push({translationBodyExcerpt:body.slice(0,1200)});
   throw new Error('Translation edit form missing after normal Edit Translations/French navigation');
 }
 let chosen=null;
 for(let i=0;i<count;i++){
  const form=forms.nth(i);
  const lang=(await form.locator('[name="language"]').first().inputValue().catch(()=>''))||'';
  const titleLoc=form.locator('input[name="episode_name"],textarea[name="episode_name"]').first();
  const title=norm(await titleLoc.inputValue().catch(async()=>await titleLoc.textContent().catch(()=>'')));
  report.checks.push({translationCandidate:i,language:lang,title});
  if(lang==='fra'||title===FROM||title===TO){chosen={form,titleLoc,title,lang};break;}
 }
 if(!chosen) throw new Error('French/current-title translation form not identified');
 const actionRaw=await chosen.form.getAttribute('action');
 if(!actionRaw) throw new Error('Translation form action missing');
 const actionUrl=new URL(actionRaw,BASE);
 if(actionUrl.origin!==BASE) throw new Error('Unexpected translation form origin');
 return {...chosen,actionPath:actionUrl.pathname};
}

async function guardedSubmit(form,allowedPath){
 let bad=null;
 const h=async route=>{
  const req=route.request(),u=new URL(req.url());
  if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){
   bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();
  }
  if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==allowedPath){
   bad='UNEXPECTED_POST '+u.pathname;return route.abort();
  }
  return route.continue();
 };
 await context.route('**/*',h);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(600);
 await context.unroute('**/*',h);
 if(bad) throw new Error(bad);
}

try{
 await go(BASE+'/auth/login');
 const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
 await lf.locator('input[name="email"]').fill(username);
 await lf.locator('input[name="password"]').fill(password);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);
 await page.waitForTimeout(700);
 const probe=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
 report.authenticated=Boolean(probe?.ok());
 if(!report.authenticated) throw new Error('Authenticated session not proven; no challenge bypass attempted');

 const before=await publicEpisode();
 report.checks.push({publicBefore:{heading:before.heading,date:before.date,runtime:before.runtime,translateHref:before.translateHref}});
 if(before.date!=='September 30, 2026') throw new Error('AIRDATE_DRIFT '+before.date);
 if(before.runtime!==34) throw new Error('RUNTIME_DRIFT '+before.runtime);
 if(!before.translateHref) throw new Error('Current Edit Translations link missing');

 if(before.heading===TO){
  report.skips.push({field:'title',reason:'ALREADY_CURRENT'});
 }else{
  if(before.heading!==FROM) throw new Error('PUBLIC_TITLE_DRIFT '+before.heading);
  const tr=await translationForm(before.translateHref);
  if(tr.title===TO){
   report.skips.push({field:'title',reason:'TRANSLATION_ALREADY_CURRENT'});
  }else{
   if(tr.title!==FROM) throw new Error('TRANSLATION_TITLE_DRIFT '+tr.title);
   await tr.titleLoc.fill(TO);
   await guardedSubmit(tr.form,tr.actionPath);
   report.writes.push({field:'title',from:FROM,to:TO,actionPath:tr.actionPath});
  }
 }

 const after=await publicEpisode();
 report.verification={
  title:after.heading,date:after.date,runtime:after.runtime,
  titleOk:after.heading===TO,dateOk:after.date==='September 30, 2026',runtimeOk:after.runtime===34
 };
 if(!report.verification.titleOk||!report.verification.dateOk||!report.verification.runtimeOk)
  throw new Error('POST_WRITE_VERIFY_FAILED '+JSON.stringify(report.verification));

 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:String(e?.message||e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED';
}finally{
 await browser.close();
}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,
 'writes='+report.writes.length,
 'skips='+report.skips.length,
 'blocked='+report.blocked.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
