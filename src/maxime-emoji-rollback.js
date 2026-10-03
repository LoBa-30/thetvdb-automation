import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_MAXIME_EMOJI_ROLLBACK||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='maxime-biaggi';
const FIXES=[
 {id:'11696582',season:2019,episode:3,bad:'Je rencontre mes abonnés ça tourne mal ???? (vidéo spéciale 300 abonnés)',good:'Je rencontre mes abonnés ça tourne mal (vidéo spéciale 300 abonnés)'},
 {id:'11696587',season:2021,episode:1,bad:'Je passe 24H avec un journaliste ca TOURNE MAL.... ????',good:'Je passe 24H avec un journaliste ca TOURNE MAL....'},
 {id:'11696590',season:2022,episode:2,bad:'UNE SEMAINE POUR FAIRE UNE CHORÉE KPOP EN LIVE (très dur ????)',good:'UNE SEMAINE POUR FAIRE UNE CHORÉE KPOP EN LIVE (très dur)'},
 {id:'11696593',season:2022,episode:5,bad:"J'ai stream 1 an sur Twitch : résultat ????",good:"J'ai stream 1 an sur Twitch : résultat"},
 {id:'11696622',season:2024,episode:3,bad:'Je découvre les Etats-Unis en exclusivité mondiale ????',good:'Je découvre les Etats-Unis en exclusivité mondiale'},
 {id:'11696625',season:2024,episode:6,bad:'Diner de Noël avec des gros gourmands !! (Secret Santa et rigolade) ????',good:'Diner de Noël avec des gros gourmands !! (Secret Santa et rigolade)'},
 {id:'11696638',season:2025,episode:2,bad:'J’ai date la mère de mon meilleur ami et il a tout organisé sans le savoir ????',good:'J’ai date la mère de mon meilleur ami et il a tout organisé sans le savoir'},
 {id:'11696641',season:2025,episode:5,bad:'De retour pour vous jouer un mauvais tour - GP Explorer 3 ????',good:'De retour pour vous jouer un mauvais tour - GP Explorer 3'},
 {id:'11696653',season:2025,episode:17,bad:'A FOND OU AU FOND ???? (Le dernier vlog GP Explorer)',good:'A FOND OU AU FOND (Le dernier vlog GP Explorer)'},
 {id:'11696662',season:2026,episode:2,bad:'Je veux tenter la piste noire la plus dangereuse (et je sais pas skier ????)',good:'Je veux tenter la piste noire la plus dangereuse (et je sais pas skier)'}
];
if(!armed) throw new Error('Not armed');
if(!username||!password) throw new Error('Missing credentials');
await fs.mkdir('reports/maxime-emoji-rollback',{recursive:true});
const report={generatedAt:new Date().toISOString(),authenticated:false,planned:FIXES.length,writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
async function go(url){let r=null;for(let i=1;i<=4;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return;}await page.waitForTimeout(i*700);}throw new Error('GET failed '+url+' '+(r?.status()??'n/a'));}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(700);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function translation(id){await go(BASE+'/series/'+SLUG+'/episodes/'+id+'/translate/fra/0/single');const f=page.locator('form').filter({has:page.locator('input[name="episode_name"]')}).first();if(!(await f.count()))throw new Error('Translation form missing '+id);return {f,title:await f.locator('input[name="episode_name"]').inputValue()};}
try{
 report.authenticated=await login(); if(!report.authenticated)throw new Error('Authenticated session not proven');
 for(const x of FIXES){
  const tr=await translation(x.id);
  if(norm(tr.title)===norm(x.good)){report.skips.push({...x,reason:'ALREADY_RESTORED'});report.verifications.push({id:x.id,ok:true,title:tr.title});continue;}
  if(norm(tr.title)!==norm(x.bad)){report.blocked.push({...x,reason:'STATE_DRIFT',actual:tr.title});continue;}
  let unexpected=null;
  const handler=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){unexpected='DESTRUCTIVE '+u.pathname;await route.abort();return;}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!=='/episodes/translatestore'){unexpected='UNEXPECTED_POST '+u.pathname;await route.abort();return;}await route.continue();};
  await context.route('**/*',handler);
  await tr.f.locator('input[name="episode_name"]').fill(x.good);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),tr.f.evaluate(form=>form.requestSubmit())]);
  await page.waitForTimeout(450); await context.unroute('**/*',handler);
  if(unexpected){report.blocked.push({...x,reason:unexpected});continue;}
  const v=await translation(x.id);
  if(norm(v.title)!==norm(x.good)){report.blocked.push({...x,reason:'VERIFY_FAILED',actual:v.title});continue;}
  report.writes.push({...x});report.verifications.push({id:x.id,ok:true,title:v.title});
 }
 report.result=report.blocked.length?'RESTORED_WITH_BLOCKED':'RESTORED_AND_VERIFIED';
}catch(e){report.blocked.push({reason:e?.stack||String(e)});report.result=report.writes.length?'PARTIAL_RESTORE':'BLOCKED_BEFORE_RESTORE';}
finally{await browser.close();}
await fs.writeFile('reports/maxime-emoji-rollback/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/maxime-emoji-rollback/summary.txt',['authenticated='+report.authenticated,'planned='+report.planned,'writes='+report.writes.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'verifications='+report.verifications.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile('reports/maxime-emoji-rollback/summary.txt','utf8'));
if(!['RESTORED_AND_VERIFIED','RESTORED_WITH_BLOCKED'].includes(report.result))process.exitCode=2;
