import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_AMIXEM_TITLE_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com',SLUG='328213-show';
const EDITS=[
 {season:2022,episode:47,id:'9407164',from:'ON MANGE 100 PLATS D’AFFILÉ (et on les juge)(On en peut plus)',to:'ON MANGE 100 PLATS D’AFFILÉE (et on les juge)(On en peut plus)'},
 {season:2021,episode:5,id:'8155934',from:'100 ABONNÉS VS 4 YOUTUBERS ! (Nerf Zombie) ft @Michou​, @LeBouseuh​, @CHRIS​',to:'100 ABONNÉS VS 4 YOUTUBERS ! (Nerf Zombie) ft @Michou, @LeBouseuh, @Chris_'},
 {season:2018,episode:58,id:'6791197',from:'ENORME BATAILLE NAVALE DANS LA VRAIE VIE ! (ft. ALL STAR REDBOX)',to:'ÉNORME BATAILLE NAVALE DANS LA VRAIE VIE ! (ft. ALL STAR REDBOX)'},
 {season:2018,episode:36,id:'6695248',from:'1000 KILOMÈTRES SANS CARTE NI GPS ! - RedBoxTrip #1',to:'1000 KILOMÈTRES SANS CARTE NI GPS ! - RedBox Trip #1'},
 {season:2017,episode:43,id:'6111940',from:"LE CADEAU D'ABONNÉ LE PLUS GÊNANT",to:"LE CADEAU D'ABONNÉ LE PLUS GÊNANT !"},
 {season:2017,episode:37,id:'6102865',from:'LE JOUR OÙ JE ME SUIS RÉVEILLÉ DANS UNE BAIGNOIRE ...',to:'LE JOUR OÙ JE ME SUIS RÉVEILLÉ DANS UNE BAIGNOIRE...'},
 {season:2016,episode:44,id:'6095581',from:'LES YOUTUBERS DESSINENT EN RÉALITÉ VIRTUELLE ! ft. Pierre Croce..',to:'LES YOUTUBERS DESSINENT EN RÉALITÉ VIRTUELLE ! ft. Pierre Croce, Terracid & LeMondeÀLenvers'}
];
if(!armed) throw new Error('Not armed'); if(!username||!password) throw new Error('Missing credentials');
await fs.mkdir('reports/amixem-title-apply',{recursive:true});
const report={authenticated:false,planned:EDITS.length,writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(url){let r=null;for(let i=1;i<=4;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(300);return;}await page.waitForTimeout(i*700);}throw new Error('GET failed '+url+' '+(r?.status()??'n/a'));}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(700);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function currentRow(x){await go(BASE+'/series/'+SLUG+'/seasons/official/'+x.season+'/edit');return await page.locator('input[name^="episodes["]').evaluateAll((ins,id)=>{for(const input of ins){const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]');if((a?.href||'').includes('/episodes/'+id))return {number:Number(input.value)||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};}return null;},x.id);}
async function translation(x){await go(BASE+'/series/'+SLUG+'/episodes/'+x.id+'/translate/fra/0/single');const f=page.locator('form').filter({has:page.locator('input[name="episode_name"]')}).first();if(!(await f.count()))throw new Error('Translation form missing '+x.id);const action=await f.getAttribute('action');const lang=await f.locator('[name="language"]').inputValue().catch(()=>'');if(action!=='/episodes/translatestore'||lang!=='fra')throw new Error('Unexpected translation form '+x.id+' '+action+' '+lang);return {f,title:await f.locator('input[name="episode_name"]').inputValue()};}
try{
 report.authenticated=await login(); if(!report.authenticated)throw new Error('Authenticated session not proven');
 for(const x of EDITS){
  const row=await currentRow(x);
  if(!row||row.number!==x.episode){report.blocked.push({id:x.id,reason:'MAPPING_DRIFT',row});continue;}
  const tr=await translation(x);
  if(tr.title===x.to){report.skips.push({id:x.id,reason:'ALREADY_CORRECT'});continue;}
  if(tr.title!==x.from){report.blocked.push({id:x.id,reason:'TITLE_DRIFT',expected:x.from,actual:tr.title});continue;}
  let unexpected=null;
  const handler=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){unexpected='DESTRUCTIVE '+u.pathname;await route.abort();return;}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!=='/episodes/translatestore'){unexpected='UNEXPECTED_POST '+u.pathname;await route.abort();return;}await route.continue();};
  await context.route('**/*',handler);
  await tr.f.locator('input[name="episode_name"]').fill(x.to);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),tr.f.evaluate(form=>form.requestSubmit())]);
  await page.waitForTimeout(500); await context.unroute('**/*',handler);
  if(unexpected){report.blocked.push({id:x.id,reason:unexpected});continue;}
  const v=await translation(x); if(v.title!==x.to)throw new Error('Title verify failed '+x.id+' got '+v.title);
  report.writes.push({id:x.id,season:x.season,episode:x.episode,from:x.from,to:x.to}); report.verifications.push({id:x.id,ok:true});
 }
 report.result=report.blocked.length?'APPLIED_WITH_BLOCKED_DRIFT':'APPLIED_AND_VERIFIED';
}catch(e){report.blocked.push({reason:e?.stack||String(e)});report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';}
finally{await browser.close();}
await fs.writeFile('reports/amixem-title-apply/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/amixem-title-apply/summary.txt',['authenticated='+report.authenticated,'planned='+report.planned,'writes='+report.writes.length,'skips='+report.skips.length,'blocked='+report.blocked.length,'verifications='+report.verifications.length,'result='+report.result].join('\n')+'\n');
console.log(await fs.readFile('reports/amixem-title-apply/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','APPLIED_WITH_BLOCKED_DRIFT'].includes(report.result))process.exitCode=2;