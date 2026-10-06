import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MCFLY_TITLE_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='338282-show',OUT='reports/mcfly-title-cleanup';
const PLAN=[
 {id:'11261488',code:'S2025E54',from:'MÉLI-MÉLO 4 (tout simplement) mid-season finale',to:'MÉLI-MÉLO 4 (tout simplement)'},
 {id:'10677656',code:'S2024E60',from:'Merci pour cette saison. mid-season finale',to:'Merci pour cette saison.'},
 {id:'9915826',code:'S2023E06',from:'La maison est incroyable ! Fin de l’aventure Bizeneuille mid-season finale',to:'La maison est incroyable ! Fin de l’aventure Bizeneuille'},
 {id:'9599423',code:'S2023E05',from:'Les pires anecdotes de nos abonnés (la dernière est la meilleure de tous les temps) mid-season finale',to:'Les pires anecdotes de nos abonnés (la dernière est la meilleure de tous les temps)'}
];
await fs.mkdir(OUT,{recursive:true});
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
const report={generatedAt:new Date().toISOString(),target:'Mcfly & Carlito substantive title cleanup',mode:'GUARDED_TITLE_REPAIR',authenticated:false,preflight:[],writes:[],skips:[],verifications:[],blocked:[],result:'NOT_STARTED'};
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
 const href=await page.locator(`a[href*="/episodes/${ep.id}/translate/"]`).first().getAttribute('href').catch(()=>null);
 return {heading,translateHref:href};
}
async function titleForm(ep,href){
 if(!href) throw new Error('Missing translation link '+ep.code);
 await go(new URL(href,BASE).href);
 let forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});
 let count=await forms.count();
 if(!count){
   const links=await page.locator('a').evaluateAll(as=>as.map(a=>({text:(a.textContent||'').replace(/\s+/g,' ').trim(),href:a.getAttribute('href')})).filter(x=>x.href&&x.href.includes('/translate/')));
   const fr=links.find(x=>/fran[cç]ais|french/i.test(x.text)||/\/fra(?:\/|$)/i.test(x.href)||/\/fr(?:\/|$)/i.test(x.href));
   if(fr){await go(new URL(fr.href,BASE).href);forms=page.locator('form').filter({has:page.locator('input[name="episode_name"],textarea[name="episode_name"]')});count=await forms.count();}
 }
 if(!count) throw new Error('Translation form missing '+ep.code);
 for(let i=0;i<count;i++){
   const form=forms.nth(i);
   const lang=(await form.locator('[name="language"]').first().inputValue().catch(()=>''))||'';
   const loc=form.locator('input[name="episode_name"],textarea[name="episode_name"]').first();
   const title=norm(await loc.inputValue().catch(async()=>await loc.textContent().catch(()=>'')));
   if(lang==='fra'||title===ep.from||title===ep.to){
     const actionRaw=await form.getAttribute('action');
     const action=new URL(actionRaw,BASE);
     if(action.origin!==BASE) throw new Error('Unexpected translation origin');
     return {form,loc,title,path:action.pathname};
   }
 }
 throw new Error('French translation form not identified '+ep.code);
}
async function guardedSubmit(form,path){
 let bad=null;
 const h=async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();}
   if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
   return route.continue();
 };
 await context.route('**/*',h);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(650);
 await context.unroute('**/*',h);
 if(bad) throw new Error(bad);
}
try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');
 for(const ep of PLAN){
   const p=await publicEpisode(ep);
   report.preflight.push({id:ep.id,code:ep.code,currentTitle:p.heading,allowed:[ep.from,ep.to]});
   if(![ep.from,ep.to].includes(p.heading)) throw new Error('TITLE_DRIFT '+ep.code+' '+p.heading);
 }
 for(const ep of PLAN){
   const p=await publicEpisode(ep);
   if(p.heading===ep.to){report.skips.push({id:ep.id,code:ep.code,reason:'ALREADY_CORRECT'});continue;}
   const tf=await titleForm(ep,p.translateHref);
   if(tf.title===ep.to){report.skips.push({id:ep.id,code:ep.code,reason:'TRANSLATION_ALREADY_CORRECT'});}
   else{
     if(tf.title!==ep.from) throw new Error('TRANSLATION_TITLE_DRIFT '+ep.code+' '+tf.title);
     await tf.loc.fill(ep.to);
     await guardedSubmit(tf.form,tf.path);
     report.writes.push({id:ep.id,code:ep.code,from:ep.from,to:ep.to});
   }
 }
 for(const ep of PLAN){
   const p=await publicEpisode(ep);
   const ok=p.heading===ep.to;
   report.verifications.push({id:ep.id,code:ep.code,title:p.heading,ok});
   if(!ok) throw new Error('POST_WRITE_VERIFY_FAILED '+ep.code+' '+p.heading);
 }
 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:String(e?.stack||e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,'planned='+PLAN.length,'writes='+report.writes.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'verifications='+report.verifications.length,'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
