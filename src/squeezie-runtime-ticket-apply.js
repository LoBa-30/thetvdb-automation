import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_SQUEEZIE_RUNTIME_APPLY||'').toLowerCase()==='yes';
if(!armed||!username||!password) throw new Error('Not armed or missing credentials');

const BASE='https://thetvdb.com',SLUG='279758-show';
const OUT='reports/squeezie-runtime-ticket-apply';
const PLAN=[
 {id:'5731695',year:2016,episode:144,title:"Le jeu comme Dark Souls mais c'est pas Dark Souls",date:'2016-08-30',from:10,to:8,youtubeId:'VOQrmgoelIU',duration:'8:03'},
 {id:'5888975',year:2016,episode:216,title:"S'IL VOUS PLAÎT, NE TOUCHEZ À RIEN !",date:'2016-12-20',from:1,to:9,youtubeId:'vc-NfMJU6nY',duration:'8:56'},
 {id:'5952779',year:2017,episode:17,title:'VRAI OU FAUX ?',date:'2017-02-01',from:10,to:7,youtubeId:'rQQ5p3uaOe8',duration:'6:31'},
 {id:'6015449',year:2017,episode:44,title:'LE BAIN JAPONAIS QUI TE BRÛLE (Vlog Japon #2)',date:'2017-03-22',from:10,to:8,youtubeId:'JVi8lCQQtGo',duration:'8:27'},
 {id:'7500993',year:2019,episode:22,title:"L'ACADÉMIE DES CANCRES #2 (ft Laink, Terracid, Maghla)",date:'2019-03-29',from:20,to:23,youtubeId:'T_4lXthmpj0',duration:'23:09'},
 {id:'7501014',year:2019,episode:34,title:"Qui fera le meilleur hit de l'été ? (en 3 jours)",date:'2019-06-05',from:70,to:68,youtubeId:'ZQjCh7oDRLo',duration:'1:08:24'},
 {id:'8436440',year:2021,episode:28,title:'méfiez-vous de ses messages privés',date:'2021-05-18',from:13,to:19,youtubeId:'NgBdZbtHDlA',duration:'19:02'},
 {id:'9098538',year:2021,episode:56,title:'il sait où vous trouver...',date:'2021-10-28',from:28,to:24,youtubeId:'XjObjgPJ0u4',duration:'23:57'}
];

await fs.mkdir(OUT,{recursive:true});
const report={generatedAt:new Date().toISOString(),target:'Squeezie runtime tickets',mode:'GUARDED_RUNTIME_APPLY',authenticated:false,preflight:[],writes:[],skips:[],blocked:[],verifications:[],result:'NOT_STARTED'};
const canon=s=>String(s||'').normalize('NFC').replace(/\s+/g,' ').trim();
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();

async function go(url){
 let last=null;
 for(let i=1;i<=4;i++){
  last=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
  if(last&&last.status()<400){await page.waitForTimeout(300);return;}
  await page.waitForTimeout(i*700);
 }
 throw new Error('GET failed '+url+' '+(last?.status()??'n/a'));
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
   const href=a?.href||'';
   return {number:Number(input.value)||null,publicId:href.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
 }));
 return new Map(rows.filter(x=>x.publicId).map(x=>[x.publicId,x]));
}
async function meta(id){
 await go(`${BASE}/series/${SLUG}/episodes/${id}/0/edit`);
 const f=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();
 if(!(await f.count())) throw new Error('Metadata form missing '+id);
 const action=await f.getAttribute('action');
 if(!action||!action.includes(`/series/${SLUG}/season/official/episodes/${id}/update`)) throw new Error('Unexpected form action '+id+' '+action);
 return {f,path:new URL(action,BASE).pathname,airdate:await f.locator('input[name="airdate"]').first().inputValue(),runtime:Number(await f.locator('input[name="runtime"]').first().inputValue())};
}
async function guardedSubmit(form,path){
 let bad=null;
 const handler=async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='DELETE'||/\/entity\/delete(?:\/|$)/i.test(u.pathname)){bad='DESTRUCTIVE '+req.method()+' '+u.pathname;return route.abort();}
   if(u.origin===BASE&&req.method()==='POST'&&u.pathname!==path){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}
   return route.continue();
 };
 await context.route('**/*',handler);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.evaluate(f=>f.requestSubmit())]);
 await page.waitForTimeout(600);
 await context.unroute('**/*',handler);
 if(bad) throw new Error(bad);
}
try{
 report.authenticated=await login();
 if(!report.authenticated) throw new Error('Authenticated session not proven');
 const seasonMaps=new Map();
 for(const y of [...new Set(PLAN.map(x=>x.year))]) seasonMaps.set(y,await seasonMap(y));

 for(const x of PLAN){
   const row=seasonMaps.get(x.year)?.get(x.id);
   const m=await meta(x.id);
   report.preflight.push({id:x.id,year:x.year,episode:x.episode,currentRow:row||null,airdate:m.airdate,runtime:m.runtime,expectedFrom:x.from,desired:x.to,youtubeId:x.youtubeId,duration:x.duration});
   if(!row||row.number!==x.episode||canon(row.title)!==canon(x.title)) throw new Error('CURRENT_MAPPING_DRIFT '+x.id+' '+JSON.stringify(row));
   if(m.airdate!==x.date) throw new Error('AIRDATE_DRIFT '+x.id+' '+m.airdate);
   if(![x.from,x.to].includes(m.runtime)) throw new Error('RUNTIME_DRIFT '+x.id+' '+m.runtime);
 }
 for(const x of PLAN){
   const m=await meta(x.id);
   if(m.runtime===x.to){
     report.skips.push({id:x.id,reason:'ALREADY_CORRECT',runtime:m.runtime});
   }else{
     await m.f.locator('input[name="runtime"]').fill(String(x.to));
     await guardedSubmit(m.f,m.path);
     report.writes.push({id:x.id,year:x.year,episode:x.episode,from:x.from,to:x.to,youtubeId:x.youtubeId,duration:x.duration});
   }
   const v=await meta(x.id);
   const ok=v.runtime===x.to&&v.airdate===x.date;
   report.verifications.push({id:x.id,year:x.year,episode:x.episode,runtime:v.runtime,airdate:v.airdate,ok});
   if(!ok) throw new Error('POST_WRITE_VERIFY_FAILED '+x.id+' '+JSON.stringify(v));
 }
 report.result='APPLIED_AND_VERIFIED';
}catch(e){
 report.blocked.push({reason:String(e?.stack||e)});
 report.result=report.writes.length?'PARTIAL_REVIEW_REQUIRED':'BLOCKED_BEFORE_WRITES';
}finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
 'authenticated='+report.authenticated,
 'planned='+PLAN.length,
 'writes='+report.writes.length,
 'skips='+report.skips.length,
 'blocked='+report.blocked.length,
 'verifications='+report.verifications.length,
 'result='+report.result
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
