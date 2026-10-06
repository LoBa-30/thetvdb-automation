import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_AMIXEM_S2016_E97_E98_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='328213-show';
const OUT='reports/amixem-s2016-e97-e98-repair';
const EPS=[
 {id:'6102789',code:'S2016E97',fromTitle:"J'AI CRASHÉ MON NOUVEAU DRONE ! (Oui, encore...)",toTitle:"JE JUGE LES YOUTUBERS !",fromDate:'2016-12-17',toDate:'2016-12-17'},
 {id:'6102787',code:'S2016E98',fromTitle:"JE JUGE LES YOUTUBERS !",toTitle:"J'AI CRASHÉ MON NOUVEAU DRONE ! (Oui, encore...)",fromDate:'2016-12-17',toDate:'2016-12-18'}
];
await fs.mkdir(OUT,{recursive:true});
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
const report={generatedAt:new Date().toISOString(),target:'Amixem S2016E97-E98',mode:'GUARDED_TITLE_DATE_REPAIR',authenticated:false,preflight:[],writes:[],verifications:[],blocked:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(u){
 let r=null;
 for(let i=1;i<=4;i++){
  r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(r&&r.status()<400){await page.waitForTimeout(350);return r;}
  await page.waitForTimeout(i*700);
 }
 throw new Error('GET failed '+u+' '+(r?.status()??'n/a'));
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
async function publicEpisode(ep){
 await go(`${BASE}/series/${SLUG}/episodes/${ep.id}`);
 const heading=norm(await page.locator('h1').first().innerText().catch(()=>''));
 const body=norm(await page.locator('body').innerText().catch(()=>''));
 const translateHref=await page.locator(`a[href*="/episodes/${ep.id}/translate/"]`).first().getAttribute('href').catch(()=>null);
 const dateText=body.match(/ORIGINALLY AIRED\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1]||null;
 return {heading,body,translateHref,dateText};
}
async function metaForm(ep){
 await go(`${BASE}/series/${SLUG}/episodes/${ep.id}/0/edit`);
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"]')}).first();
 if(!(await f.count())) throw new Error('Metadata form missing '+ep.code);
 const actionRaw=await f.getAttribute('action');
 const path=new URL(actionRaw,BASE).pathname;
 if(!path.includes(`/series/${SLUG}/season/official/episodes/${ep.id}/update`)) throw new Error('Unexpected metadata action '+path);
 return {f,path,date:await f.locator('input[name="airdate"]').inputValue()};
}
async function titleForm(ep,href){
 if(!href) throw new Error('Missing translation link '+ep.code);
 await go(new URL(href,BASE).href);
 let forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});
 let count=await forms.count();
 if(!count){
  const links=await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.textContent||'').replace(/\s+/g,' ').trim(),href:a.getAttribute('href')})).filter(x=>x.href&&x.href.includes('/translate/')));
  const french=links.find(x=>/fran[cç]ais|french/i.test(x.text)||/\/fra(?:\/|$)/i.test(x.href)||/\/fr(?:\/|$)/i.test(x.href));
  if(french){await go(new URL(french.href,BASE).href);forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});count=await forms.count();}
 }
 if(!count) throw new Error('Translation form missing '+ep.code);
 for(let i=0;i<count;i++){
  const form=forms.nth(i);
  const lang=(await form.locator('[name="language"]').first().inputValue().catch(()=>''))||'';
  const titleLoc=form.locator('input[name="episode_name"],textarea[name="episode_name"]').first();
  const title=norm(await titleLoc.inputValue().catch(async()=>await titleLoc.textContent().catch(()=>'')));
  if(lang==='fra'||title===ep.fromTitle||title===ep.toTitle){
   const actionRaw=await form.getAttribute('action');
   const actionUrl=new URL(actionRaw,BASE);
   if(actionUrl.origin!==BASE) throw new Error('Unexpected translation origin');
   return {form,titleLoc,title,actionPath:actionUrl.pathname,lang};
  }
 }
 throw new Error('French translation form not identified '+ep.code);
}
async function guardedSubmit(form,allowedPath){
 let bad=null;
 const h=async route=>{
  const req=route.request(),u=new URL(req.url());
  if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();}
  if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==allowedPath){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
  return route.continue();
 };
 await context.route('**/*',h);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(700);
 await context.unroute('**/*',h);
 if(bad) throw new Error(bad);
}

try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');

 for(const ep of EPS){
  const pub=await publicEpisode(ep);
  const meta=await metaForm(ep);
  report.preflight.push({id:ep.id,code:ep.code,publicTitle:pub.heading,airdate:meta.date});
  if(![ep.fromTitle,ep.toTitle].includes(pub.heading)) throw new Error('TITLE_DRIFT '+ep.code+' '+pub.heading);
  if(![ep.fromDate,ep.toDate].includes(meta.date)) throw new Error('DATE_DRIFT '+ep.code+' '+meta.date);
 }

 for(const ep of EPS){
  let pub=await publicEpisode(ep);
  if(pub.heading!==ep.toTitle){
   if(pub.heading!==ep.fromTitle) throw new Error('TITLE_CHANGED_DURING_RUN '+ep.code);
   const tr=await titleForm(ep,pub.translateHref);
   if(tr.title===ep.toTitle){
    report.verifications.push({type:'TITLE',code:ep.code,alreadyCorrectInTranslation:true});
   }else{
    if(tr.title!==ep.fromTitle) throw new Error('TRANSLATION_TITLE_DRIFT '+ep.code+' '+tr.title);
    await tr.titleLoc.fill(ep.toTitle);
    await guardedSubmit(tr.form,tr.actionPath);
    report.writes.push({type:'TITLE',code:ep.code,id:ep.id,from:ep.fromTitle,to:ep.toTitle});
   }
  }
  const mf=await metaForm(ep);
  if(mf.date!==ep.toDate){
   if(mf.date!==ep.fromDate) throw new Error('AIRDATE_CHANGED_DURING_RUN '+ep.code+' '+mf.date);
   await mf.f.locator('input[name="airdate"]').fill(ep.toDate);
   await guardedSubmit(mf.f,mf.path);
   report.writes.push({type:'AIRDATE',code:ep.code,id:ep.id,from:ep.fromDate,to:ep.toDate});
  }
 }

 for(const ep of EPS){
  const pub=await publicEpisode(ep);
  const mf=await metaForm(ep);
  const okTitle=pub.heading===ep.toTitle,okDate=mf.date===ep.toDate;
  report.verifications.push({type:'FINAL',code:ep.code,id:ep.id,title:pub.heading,airdate:mf.date,okTitle,okDate});
  if(!okTitle||!okDate) throw new Error('POST_WRITE_VERIFY_FAILED '+ep.code);
 }
 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:String(e?.stack||e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,
 'writes='+report.writes.length,
 'verifications='+report.verifications.length,
 'blocked='+report.blocked.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
