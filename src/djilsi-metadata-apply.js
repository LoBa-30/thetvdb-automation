import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_DJILSI_METADATA_APPLY||'').toLowerCase()==='yes';
const BASE='https://thetvdb.com', SLUG='djilsi';
if(!armed) throw new Error('Not armed');
if(!username||!password) throw new Error('Missing TVDB credentials');

const P=[
{season:2018,episode:1,id:'9242990',title:'PARTIR EN TOUR DE FRANCE EN IMPRO TOTALE ! #DécouvreTonPays 1',dateFrom:'2018-08-10',dateTo:'2018-08-09',runtimeFrom:10,runtimeTo:null},
{season:2018,episode:3,id:'9242992',title:"SUR LA PLUS HAUTE DUNE D'EUROPE ! #DécouvreTonPays 3",runtimeFrom:6,runtimeTo:7},
{season:2018,episode:6,id:'9242995',title:'UN GENDARME ME MET UNE PRESSION PAR TELEPHONE ! #DécouvreTonPays 6',runtimeFrom:14,runtimeTo:15},
{season:2018,episode:15,id:'9243020',title:'COUP DE POKER #JournalDeBord EP3',runtimeFrom:13,runtimeTo:14},
{season:2019,episode:7,id:'9243034',title:'LE PIRE ÉLÈVE À LA FAC ! CACHE LA CAM #2',runtimeFrom:8,runtimeTo:9},
{season:2019,episode:8,id:'9243035',title:'LE MEC LE PLUS CHELOU DANS LA RUE ! CACHE LA CAM #3',runtimeFrom:5,runtimeTo:6},
{season:2019,episode:22,id:'9243049',title:"ON S'INCRUSTE CHEZ DES GENS ! #OnVaOù",runtimeFrom:22,runtimeTo:23},
{season:2019,episode:23,id:'9243050',title:'LE MOMENT LE PLUS GÊNANT DE NOTRE VIE ! #OnVaOù (final saison 1)',runtimeFrom:23,runtimeTo:24},
{season:2019,episode:24,id:'9243051',title:'1 AN SUR YOUTUBE : JE VOUS DIS TOUT !',runtimeFrom:31,runtimeTo:32},
{season:2019,episode:29,id:'9243057',title:'LES FRANCAIS SONT-ILS PERVERS ? INTERVIEW CHELOU #7',runtimeFrom:7,runtimeTo:8},
{season:2019,episode:36,id:'9243064',title:'LE PIRE VENDEUR DU MONDE ! CACHE LA CAM #11',runtimeFrom:7,runtimeTo:9},
{season:2020,episode:5,id:'9243084',title:'DES CONFLITS AU SEIN DU GROUPE !! #OnVaOù3',runtimeFrom:21,runtimeTo:22},
{season:2020,episode:27,id:'9243162',title:"J'AI ÉTÉ BLOQUÉ DANS UNE COURSE POURSUITE EN VOITURE ! (la voiture explose c'est faux)",runtimeFrom:20,runtimeTo:21},
{season:2021,episode:15,id:'9243181',title:'Des gros problèmes aux frontières... (notre niveau de chance est de 0/10) #OnVaOù5',runtimeFrom:32,runtimeTo:33},
{season:2021,episode:18,id:'9243184',title:'PARCOURIR 700km SANS ARGENT (on est des génies, objectivement) - Pékin Hesspress partie 2',runtimeFrom:51,runtimeTo:52},
{season:2022,episode:7,id:'9243195',title:'On joue à des jeux de société et ça finit forcément mal',runtimeFrom:49,runtimeTo:50},
{season:2022,episode:8,id:'9254620',title:'On contrôle le date de notre pote',runtimeFrom:45,runtimeTo:46},
{season:2022,episode:16,id:'9477724',title:'On traverse les États-Unis en camping car #OnVaOù6 ep3',runtimeFrom:65,runtimeTo:66},
{season:2022,episode:17,id:'9477725',title:'On traverse les États-Unis en camping car #OnVaOù6 ep4',runtimeFrom:94,runtimeTo:95},
{season:2022,episode:21,id:'9477730',title:'Je deviens pilote de F4 (Grand Prix Explorer) FINAL',runtimeFrom:64,runtimeTo:65},
{season:2023,episode:7,id:'9812414',title:'Je deviens cascadeur',runtimeFrom:40,runtimeTo:41},
{season:2023,episode:8,id:'9812432',title:'En route pour le GP Explorer 2',runtimeFrom:50,runtimeTo:51},
{season:2023,episode:15,id:'10740763',title:'Le grand final du GP Explorer 2',runtimeFrom:100,runtimeTo:101},
{season:2023,episode:16,id:'10740764',title:"4 jours à travers l'un des plus grands fleuves du Sénégal",runtimeFrom:91,runtimeTo:92},
{season:2024,episode:2,id:'10824277',title:'LE DÎNER DE C*NS (ft Théodort, Maxime Biaggi, Elian, Ben Haddad et Manas)',runtimeFrom:57,runtimeTo:58},
{season:2024,episode:8,id:'10824283',title:"J'anime une colonie de vacances de séniors",runtimeFrom:68,runtimeTo:69},
{season:2024,episode:14,id:'10824294',title:"3 jeux d'horreur dans les lieux réels ! (ft Billy et Maxime Biaggi)",dateFrom:'2024-09-26',dateTo:'2024-10-26',runtimeFrom:47,runtimeTo:46},
{season:2025,episode:1,id:'11684522',title:'Envoyé en mission dans un pays étranger ! MISSION INUTILE',runtimeFrom:52,runtimeTo:53},
{season:2025,episode:6,id:'11684527',title:"GP EXPLORER 3 : Et si c'était la bonne ?",runtimeFrom:54,runtimeTo:55},
{season:2026,episode:13,id:'11971086',title:'Les problèmes commencent… - ON VA OÙ 7 ep2 (ft Maxime Biaggi, Joyca & Théodort)',runtimeFrom:48,runtimeTo:49},
{season:2026,episode:14,id:'11976892',title:'Des accidents et une soirée chaotique... - ON VA OÙ 7 ep3 (ft Maxime Biaggi, Joyca & Théodort)',runtimeFrom:46,runtimeTo:45}
];

const canon=s=>String(s||'').normalize('NFC').replace(/\s+/g,' ').trim();
const report={generatedAt:new Date().toISOString(),target:'Djilsi',mode:'GUARDED_METADATA_APPLY',armed,authenticated:false,plannedEpisodes:P.length,writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
await fs.mkdir('reports/djilsi-metadata-apply',{recursive:true});

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(url){
 let r=null;
 for(let i=1;i<=4;i++){
   r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
   if(r&&r.status()<400){await page.waitForTimeout(250);return r;}
   await page.waitForTimeout(600*i);
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
async function seasonMap(year){
 await go(`${BASE}/series/${SLUG}/seasons/official/${year}/edit`);
 const rows=await page.locator('input[name^="episodes["]').evaluateAll(inputs=>inputs.map(input=>{
   const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
   const a=c?.querySelector('a[href*="/episodes/"]')||null;
   return {number:Number(input.value)||null,id:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
 return rows;
}
async function meta(id){
 await go(`${BASE}/series/${SLUG}/episodes/${id}/0/edit`);
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();
 if(!(await f.count())) throw new Error('Metadata form missing '+id);
 const action=await f.getAttribute('action');
 if(!action||!action.includes(`/series/${SLUG}/season/official/episodes/${id}/update`)) throw new Error('Unexpected form action '+id+' '+action);
 return {
   f,
   actionPath:new URL(action,BASE).pathname,
   date:await f.locator('input[name="airdate"]').first().inputValue().catch(()=>null),
   runtime:Number(await f.locator('input[name="runtime"]').first().inputValue().catch(()=>''))||null
 };
}
async function submit(f,path){
 let bad=null;
 const h=async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;await route.abort();return;}
   if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;await route.abort();return;}
   await route.continue();
 };
 await context.route('**/*',h);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);
 await page.waitForTimeout(450);
 await context.unroute('**/*',h);
 return bad;
}

try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');

 const maps=new Map();
 for(const year of [...new Set(P.map(x=>x.season))]) maps.set(year,await seasonMap(year));

 for(const x of P){
   const row=(maps.get(x.season)||[]).find(r=>r.id===x.id);
   if(!row||row.number!==x.episode||canon(row.title)!==canon(x.title)){
     report.blocked.push({id:x.id,reason:'CURRENT_MAPPING_DRIFT',expected:{season:x.season,episode:x.episode,title:x.title},actual:row||null});
     continue;
   }
   const m=await meta(x.id);
   const wantsDate=Boolean(x.dateTo);
   const wantsRuntime=x.runtimeTo!=null;
   if(wantsDate && ![x.dateFrom,x.dateTo].includes(m.date)){
     report.blocked.push({id:x.id,reason:'DATE_DRIFT',expected:[x.dateFrom,x.dateTo],actual:m.date});continue;
   }
   if(wantsRuntime && ![x.runtimeFrom,x.runtimeTo].includes(m.runtime)){
     report.blocked.push({id:x.id,reason:'RUNTIME_DRIFT',expected:[x.runtimeFrom,x.runtimeTo],actual:m.runtime});continue;
   }
   const dateNeeded=wantsDate&&m.date!==x.dateTo;
   const runtimeNeeded=wantsRuntime&&m.runtime!==x.runtimeTo;
   if(!dateNeeded&&!runtimeNeeded){
     report.skips.push({id:x.id,season:x.season,episode:x.episode,reason:'ALREADY_CORRECT',date:m.date,runtime:m.runtime});
     report.verifications.push({id:x.id,ok:true,date:m.date,runtime:m.runtime});
     continue;
   }
   if(dateNeeded) await m.f.locator('input[name="airdate"]').first().fill(x.dateTo);
   if(runtimeNeeded) await m.f.locator('input[name="runtime"]').first().fill(String(x.runtimeTo));
   const bad=await submit(m.f,m.actionPath);
   if(bad){report.blocked.push({id:x.id,reason:bad});continue;}
   const v=await meta(x.id);
   const dateOk=!wantsDate||v.date===x.dateTo;
   const runtimeOk=!wantsRuntime||v.runtime===x.runtimeTo;
   if(!dateOk||!runtimeOk){
     report.blocked.push({id:x.id,reason:'POST_WRITE_VERIFY_FAILED',expected:{date:x.dateTo??m.date,runtime:x.runtimeTo??m.runtime},actual:{date:v.date,runtime:v.runtime}});
     continue;
   }
   report.writes.push({id:x.id,season:x.season,episode:x.episode,title:x.title,date:dateNeeded?{from:m.date,to:x.dateTo}:null,runtime:runtimeNeeded?{from:m.runtime,to:x.runtimeTo}:null});
   report.verifications.push({id:x.id,ok:true,date:v.date,runtime:v.runtime});
 }
 report.result=report.blocked.length?'APPLIED_WITH_BLOCKED_DRIFT':'APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:e?.stack||String(e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}

await fs.writeFile('reports/djilsi-metadata-apply/report.json',JSON.stringify(report,null,2));
await fs.writeFile('reports/djilsi-metadata-apply/summary.txt',[
 'authenticated='+report.authenticated,
 'plannedEpisodes='+report.plannedEpisodes,
 'writes='+report.writes.length,
 'skips='+report.skips.length,
 'blocked='+report.blocked.length,
 'verifications='+report.verifications.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile('reports/djilsi-metadata-apply/summary.txt','utf8'));
if(!['APPLIED_AND_VERIFIED','APPLIED_WITH_BLOCKED_DRIFT'].includes(report.result)) process.exitCode=2;
