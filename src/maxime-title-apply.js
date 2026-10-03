import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MAXIME_TITLE_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='maxime-biaggi';

const EDITS=[
 {season:2019,episode:3,from:'Je rencontre mes abonnés ça tourne mal (vidéo spéciale 300 abonnés)',to:'Je rencontre mes abonnés ça tourne mal 😪 (vidéo spéciale 300 abonnés)'},
 {season:2021,episode:1,from:'Je passe 24H avec un journaliste ca TOURNE MAL....',to:'Je passe 24H avec un journaliste ca TOURNE MAL.... 😳'},
 {season:2022,episode:2,from:'UNE SEMAINE POUR FAIRE UNE CHORÉE KPOP EN LIVE (très dur)',to:'UNE SEMAINE POUR FAIRE UNE CHORÉE KPOP EN LIVE (très dur 👍)'},
 {season:2022,episode:5,from:"J'ai stream 1 an sur Twitch : résultat",to:"J'ai stream 1 an sur Twitch : résultat 👍"},
 {season:2024,episode:3,from:'Je découvre les Etats-Unis en exclusivité mondiale',to:'Je découvre les Etats-Unis en exclusivité mondiale 👍'},
 {season:2024,episode:6,from:'Diner de Noël avec des gros gourmands !! (Secret Santa et rigolade)',to:'Diner de Noël avec des gros gourmands !! (Secret Santa et rigolade) 👍'},
 {season:2025,episode:2,from:'J’ai date la mère de mon meilleur ami et il a tout organisé sans le savoir',to:'J’ai date la mère de mon meilleur ami et il a tout organisé sans le savoir 👍'},
 {season:2025,episode:5,from:'De retour pour vous jouer un mauvais tour - GP Explorer 3',to:'De retour pour vous jouer un mauvais tour - GP Explorer 3 😎'},
 {season:2025,episode:17,from:'A FOND OU AU FOND (Le dernier vlog GP Explorer)',to:'A FOND OU AU FOND 😎 (Le dernier vlog GP Explorer)'},
 {season:2026,episode:2,from:'Je veux tenter la piste noire la plus dangereuse (et je sais pas skier)',to:'Je veux tenter la piste noire la plus dangereuse (et je sais pas skier 👍)'}
];

if(!armed) throw new Error('Not armed');
if(!username||!password) throw new Error('Missing credentials');
await fs.mkdir('reports/maxime-title-apply',{recursive:true});
const report={generatedAt:new Date().toISOString(),authenticated:false,planned:EDITS.length,writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();

async function go(url){
 let r=null;
 for(let i=1;i<=4;i++){
  r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(r&&r.status()<400){await page.waitForTimeout(300);return;}
  await page.waitForTimeout(i*700);
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
async function rowFor(x){
 await go(BASE+'/series/'+SLUG+'/seasons/official/'+x.season+'/edit');
 return await page.locator('input[name^="episodes["]').evaluateAll((ins,ep)=>{
  for(const input of ins){
   if(Number(input.value)!==ep) continue;
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]');
   if(!a) continue;
   const m=(a.href||'').match(/\/episodes\/(\d+)/);
   return {number:Number(input.value)||null,title:(a.textContent||'').replace(/\s+/g,' ').trim(),id:m?m[1]:null};
  }
  return null;
 },x.episode);
}
async function translation(id){
 await go(BASE+'/series/'+SLUG+'/episodes/'+id+'/translate/fra/0/single');
 const f=page.locator('form').filter({has:page.locator('input[name="episode_name"]')}).first();
 if(!(await f.count())) throw new Error('Translation form missing '+id);
 const action=await f.getAttribute('action');
 const lang=await f.locator('[name="language"]').inputValue().catch(()=>'');
 if(action!=='/episodes/translatestore'||lang!=='fra') throw new Error('Unexpected translation form '+id+' '+action+' '+lang);
 return {f,title:await f.locator('input[name="episode_name"]').inputValue()};
}

try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');
 for(const x of EDITS){
  const row=await rowFor(x);
  if(!row?.id){report.blocked.push({...x,reason:'ROW_OR_ID_MISSING',row});continue;}
  const tr=await translation(row.id);
  if(norm(tr.title)===norm(x.to)){
   report.skips.push({...x,id:row.id,reason:'ALREADY_CORRECT',actual:tr.title});
   report.verifications.push({id:row.id,season:x.season,episode:x.episode,title:tr.title,ok:true});
   continue;
  }
  if(norm(tr.title)!==norm(x.from)){
   report.blocked.push({...x,id:row.id,reason:'TITLE_DRIFT',actual:tr.title});
   continue;
  }
  let unexpected=null;
  const handler=async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){unexpected='DESTRUCTIVE '+u.pathname;await route.abort();return;}
   if(u.origin===BASE&&req.method()==='POST'&&u.pathname!=='/episodes/translatestore'){unexpected='UNEXPECTED_POST '+u.pathname;await route.abort();return;}
   await route.continue();
  };
  await context.route('**/*',handler);
  await tr.f.locator('input[name="episode_name"]').fill(x.to);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),tr.f.evaluate(form=>form.requestSubmit())]);
  await page.waitForTimeout(500);
  await context.unroute('**/*',handler);
  if(unexpected){report.blocked.push({...x,id:row.id,reason:unexpected});continue;}
  const v=await translation(row.id);
  if(norm(v.title)!==norm(x.to)){report.blocked.push({...x,id:row.id,reason:'VERIFY_FAILED',actual:v.title});continue;}
  report.writes.push({...x,id:row.id});
  report.verifications.push({id:row.id,season:x.season,episode:x.episode,title:v.title,ok:true});
 }
 report.result=report.blocked.length?'APPLIED_WITH_BLOCKED_DRIFT':'APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:e?.stack||String(e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}

await fs.writeFile('reports/maxime-title-apply/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/maxime-title-apply/summary.txt',[
 'authenticated='+report.authenticated,
 'planned='+report.planned,
 'writes='+report.writes.length,
 'skips='+report.skips.length,
 'blocked='+report.blocked.length,
 'verifications='+report.verifications.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile('reports/maxime-title-apply/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','APPLIED_WITH_BLOCKED_DRIFT'].includes(report.result)) process.exitCode=2;
