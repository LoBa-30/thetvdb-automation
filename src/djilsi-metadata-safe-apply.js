
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME, password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_DJILSI_METADATA_APPLY||'').toLowerCase()==='yes';
if(!armed) throw new Error('Not armed');
if(!username||!password) throw new Error('Missing TVDB credentials');

const BASE='https://thetvdb.com', SLUG='djilsi', OUT='reports/djilsi-metadata-apply';
await fs.mkdir(OUT,{recursive:true});

const P=[
[2018,1,'9242990','PARTIR EN TOUR DE FRANCE EN IMPRO TOTALE ! #DécouvreTonPays 1',10,null,'2018-08-10','2018-08-09'],
[2018,3,'9242992',"SUR LA PLUS HAUTE DUNE D'EUROPE ! #DécouvreTonPays 3",6,7],
[2018,6,'9242995','UN GENDARME ME MET UNE PRESSION PAR TELEPHONE ! #DécouvreTonPays 6',14,15],
[2018,15,'9243020','COUP DE POKER #JournalDeBord EP3',13,14],
[2019,7,'9243034','LE PIRE ÉLÈVE À LA FAC ! CACHE LA CAM #2',8,9],
[2019,8,'9243035','LE MEC LE PLUS CHELOU DANS LA RUE ! CACHE LA CAM #3',5,6],
[2019,22,'9243049',"ON S'INCRUSTE CHEZ DES GENS ! #OnVaOù",22,23],
[2019,23,'9243050','LE MOMENT LE PLUS GÊNANT DE NOTRE VIE ! #OnVaOù (final saison 1)',23,24],
[2019,24,'9243051','1 AN SUR YOUTUBE : JE VOUS DIS TOUT !',31,32],
[2019,29,'9243057','LES FRANCAIS SONT-ILS PERVERS ? INTERVIEW CHELOU #7',7,8],
[2019,36,'9243064','LE PIRE VENDEUR DU MONDE ! CACHE LA CAM #11',7,9],
[2020,5,'9243084','DES CONFLITS AU SEIN DU GROUPE !! #OnVaOù3',21,22],
[2020,27,'9243162',"J'AI ÉTÉ BLOQUÉ DANS UNE COURSE POURSUITE EN VOITURE ! (la voiture explose c'est faux)",20,21],
[2021,15,'9243181','Des gros problèmes aux frontières... (notre niveau de chance est de 0/10) #OnVaOù5',32,33],
[2021,18,'9243184','PARCOURIR 700km SANS ARGENT (on est des génies, objectivement) - Pékin Hesspress partie 2',51,52],
[2022,7,'9243195','On joue à des jeux de société et ça finit forcément mal',49,50],
[2022,8,'9254620','On contrôle le date de notre pote',45,46],
[2022,16,'9477724','On traverse les États-Unis en camping car #OnVaOù6 ep3',65,66],
[2022,17,'9477725','On traverse les États-Unis en camping car #OnVaOù6 ep4',94,95],
[2022,21,'9477730','Je deviens pilote de F4 (Grand Prix Explorer) FINAL',64,65],
[2023,7,'9812414','Je deviens cascadeur',40,41],
[2023,8,'9812432','En route pour le GP Explorer 2',50,51],
[2023,15,'10740763','Le grand final du GP Explorer 2',100,101],
[2023,16,'10740764',"4 jours à travers l'un des plus grands fleuves du Sénégal",91,92],
[2024,2,'10824277','LE DÎNER DE C*NS (ft Théodort, Maxime Biaggi, Elian, Ben Haddad et Manas)',57,58],
[2024,8,'10824283',"J'anime une colonie de vacances de séniors",68,69],
[2024,14,'10824294',"3 jeux d'horreur dans les lieux réels ! (ft Billy et Maxime Biaggi)",47,46,'2024-09-26','2024-10-26'],
[2025,1,'11684522','Envoyé en mission dans un pays étranger ! MISSION INUTILE',52,53],
[2025,6,'11684527',"GP EXPLORER 3 : Et si c'était la bonne ?",54,55],
[2026,13,'11971086','Les problèmes commencent… - ON VA OÙ 7 ep2 (ft Maxime Biaggi, Joyca & Théodort)',48,49],
[2026,14,'11976892','Des accidents et une soirée chaotique... - ON VA OÙ 7 ep3 (ft Maxime Biaggi, Joyca & Théodort)',46,45]
].map(x=>({season:x[0],episode:x[1],id:x[2],title:x[3],runtimeFrom:x[4],runtimeTo:x[5]??null,dateFrom:x[6]??null,dateTo:x[7]??null}));

const norm=s=>String(s||'').normalize('NFC').replace(/\s+/g,' ').trim();
const report={generatedAt:new Date().toISOString(),target:'Djilsi',mode:'GUARDED_METADATA_APPLY',armed,authenticated:false,announcementPolicy:'KEEP_USER_APPROVED_E11_NO_RENUMBER',preflight:[],writes:[],skips:[],blocked:[],verifications:[],seriesFirstAiredAfter:null,result:'NOT_STARTED'};

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(u){let r;for(let i=0;i<4;i++){r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(250);return r;}await page.waitForTimeout(600*(i+1));}throw new Error('GET '+u+' '+(r?.status()??'n/a'));}
async function login(){await go(BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(700);const p=await context.request.get(BASE+'/auth/getuser').catch(()=>null);return Boolean(p?.ok());}
async function seasonRows(y){await go(BASE+'/series/'+SLUG+'/seasons/official/'+y+'/edit');return await page.locator('input[name^="episodes["]').evaluateAll(ins=>ins.map(input=>{const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]');const h=a?.href||'';return {number:Number(input.value)||null,id:h.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};}));}
async function meta(x){await go(BASE+'/series/'+SLUG+'/episodes/'+x.id+'/0/edit');const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();if(!(await f.count()))throw new Error('Metadata form missing '+x.id);const action=await f.getAttribute('action');if(!action||!action.includes('/series/'+SLUG+'/season/official/episodes/'+x.id+'/update'))throw new Error('Unexpected action '+x.id+' '+action);return {f,path:new URL(action,BASE).pathname,date:await f.locator('input[name="airdate"]').first().inputValue(),runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())};}
async function submit(f,path){let bad=null;const h=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;await route.abort();return;}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;await route.abort();return;}await route.continue();};await context.route('**/*',h);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);await page.waitForTimeout(500);await context.unroute('**/*',h);return bad;}

try{
 report.authenticated=await login();if(!report.authenticated)throw new Error('Authenticated session not proven');
 const maps=new Map();for(const y of [...new Set(P.map(x=>x.season))])maps.set(y,await seasonRows(y));

 // Global no-write preflight: every mapping/value must still be exactly stale or already correct.
 for(const x of P){
   const row=(maps.get(x.season)||[]).find(r=>r.number===x.episode);
   const m=await meta(x);
   const chk={id:x.id,season:x.season,episode:x.episode,expectedTitle:x.title,row,currentDate:m.date,currentRuntime:m.runtime};
   if(!row||row.id!==x.id||norm(row.title)!==norm(x.title)) report.blocked.push({...chk,reason:'MAPPING_OR_TITLE_DRIFT'});
   if(x.runtimeTo!=null&&![x.runtimeFrom,x.runtimeTo].includes(m.runtime)) report.blocked.push({...chk,reason:'RUNTIME_DRIFT'});
   if(x.dateTo&&![x.dateFrom,x.dateTo].includes(m.date)) report.blocked.push({...chk,reason:'DATE_DRIFT'});
   report.preflight.push(chk);
 }
 if(report.blocked.length) throw new Error('STOP_AFTER_GLOBAL_PREFLIGHT');

 for(const x of P){
   let m=await meta(x);
   const changes=[];
   if(x.runtimeTo!=null){
     if(m.runtime===x.runtimeTo) report.skips.push({id:x.id,field:'runtime',reason:'ALREADY_CORRECT',value:m.runtime});
     else {await m.f.locator('input[name="runtime"]').fill(String(x.runtimeTo));changes.push({field:'runtime',from:m.runtime,to:x.runtimeTo});}
   }
   if(x.dateTo){
     if(m.date===x.dateTo) report.skips.push({id:x.id,field:'date',reason:'ALREADY_CORRECT',value:m.date});
     else {await m.f.locator('input[name="airdate"]').fill(x.dateTo);changes.push({field:'date',from:m.date,to:x.dateTo});}
   }
   if(!changes.length) continue;
   const bad=await submit(m.f,m.path);if(bad){report.blocked.push({id:x.id,reason:bad});continue;}
   report.writes.push({id:x.id,season:x.season,episode:x.episode,changes});
   const v=await meta(x);
   const okRuntime=x.runtimeTo==null||v.runtime===x.runtimeTo;
   const okDate=!x.dateTo||v.date===x.dateTo;
   if(!okRuntime||!okDate) throw new Error('VERIFY_FAILED '+x.id+' runtime='+v.runtime+' date='+v.date);
   report.verifications.push({id:x.id,ok:true,runtime:v.runtime,date:v.date});
 }
 await go(BASE+'/series/'+SLUG);
 const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
 report.seriesFirstAiredAfter=body.match(/First Aired\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1]||null;
 report.result=report.blocked.length?'APPLIED_WITH_BLOCKED':'APPLIED_AND_VERIFIED';
}catch(e){
 if(e?.message!=='STOP_AFTER_GLOBAL_PREFLIGHT')report.blocked.push({reason:e?.stack||String(e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,
 'plannedEpisodes='+P.length,
 'writes='+report.writes.length,
 'fieldChanges='+report.writes.reduce((n,x)=>n+x.changes.length,0),
 'skips='+report.skips.length,
 'blocked='+report.blocked.length,
 'verified='+report.verifications.length,
 'seriesFirstAiredAfter='+(report.seriesFirstAiredAfter||'null'),
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
