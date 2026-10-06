
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME, password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');
const BASE='https://thetvdb.com', SLUG='djilsi', OUT='reports/djilsi-metadata-preflight';
await fs.mkdir(OUT,{recursive:true});
const T=[
[2018,1,'PARTIR EN TOUR DE FRANCE EN IMPRO TOTALE ! #DécouvreTonPays 1',null,'2018-08-10','2018-08-09'],
[2018,3,"SUR LA PLUS HAUTE DUNE D'EUROPE ! #DécouvreTonPays 3",7],
[2018,6,'UN GENDARME ME MET UNE PRESSION PAR TELEPHONE ! #DécouvreTonPays 6',15],
[2018,15,'COUP DE POKER #JournalDeBord EP3',14],
[2019,7,'LE PIRE ÉLÈVE À LA FAC ! CACHE LA CAM #2',9],
[2019,8,'LE MEC LE PLUS CHELOU DANS LA RUE ! CACHE LA CAM #3',6],
[2019,22,"ON S'INCRUSTE CHEZ DES GENS ! #OnVaOù",23],
[2019,23,'LE MOMENT LE PLUS GÊNANT DE NOTRE VIE ! #OnVaOù (final saison 1)',24],
[2019,24,'1 AN SUR YOUTUBE : JE VOUS DIS TOUT !',32],
[2019,29,'LES FRANCAIS SONT-ILS PERVERS ? INTERVIEW CHELOU #7',8],
[2019,36,'LE PIRE VENDEUR DU MONDE ! CACHE LA CAM #11',9],
[2020,5,'DES CONFLITS AU SEIN DU GROUPE !! #OnVaOù3',22],
[2020,27,"J'AI ÉTÉ BLOQUÉ DANS UNE COURSE POURSUITE EN VOITURE ! (la voiture explose c'est faux)",21],
[2021,15,'Des gros problèmes aux frontières... (notre niveau de chance est de 0/10) #OnVaOù5',33],
[2021,18,'PARCOURIR 700km SANS ARGENT (on est des génies, objectivement) - Pékin Hesspress partie 2',52],
[2022,7,'On joue à des jeux de société et ça finit forcément mal',50],
[2022,8,'On contrôle le date de notre pote',46],
[2022,16,'On traverse les États-Unis en camping car #OnVaOù6 ep3',66],
[2022,17,'On traverse les États-Unis en camping car #OnVaOù6 ep4',95],
[2022,21,'Je deviens pilote de F4 (Grand Prix Explorer) FINAL',65],
[2023,7,'Je deviens cascadeur',41],
[2023,8,'En route pour le GP Explorer 2',51],
[2023,15,'Le grand final du GP Explorer 2',101],
[2023,16,"4 jours à travers l'un des plus grands fleuves du Sénégal",92],
[2024,2,'LE DÎNER DE C*NS (ft Théodort, Maxime Biaggi, Elian, Ben Haddad et Manas)',58],
[2024,8,"J'anime une colonie de vacances de séniors",69],
[2024,14,"3 jeux d'horreur dans les lieux réels ! (ft Billy et Maxime Biaggi)",46,'2024-09-26','2024-10-26'],
[2025,1,'Envoyé en mission dans un pays étranger ! MISSION INUTILE',53],
[2025,6,"GP EXPLORER 3 : Et si c'était la bonne ?",55],
[2026,13,'ON VA OÙ 7 ep2',49],
[2026,14,'ON VA OÙ 7 ep3',45]
].map(x=>({season:x[0],episode:x[1],title:x[2],runtimeTo:x[3]??null,dateFrom:x[4]??null,dateTo:x[5]??null}));
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/@[-\w.]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const dur=s=>{if(!s)return null;const p=s.split(':').map(Number);if(p.some(Number.isNaN))return null;return p.length===3?p[0]*3600+p[1]*60+p[2]:p.length===2?p[0]*60+p[1]:null};
const rounded=s=>s==null?null:Math.floor(s/60+0.5);
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const report={generatedAt:new Date().toISOString(),target:'Djilsi',mode:'READ_ONLY',announcementPolicy:'KEEP_USER_APPROVED_E11_NO_RENUMBER',authenticated:false,youtube:{},checks:[],blockedRequests:[],errors:[]};
async function go(p,u){let r;for(let i=0;i<3;i++){r=await p.goto(u,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await p.waitForTimeout(350);return r;}await p.waitForTimeout(600*(i+1));}throw new Error('GET '+u+' '+(r?.status()??'n/a'));}
// YouTube official tab.
{
 const p=await context.newPage();
 try{
  await go(p,'https://www.youtube.com/c/Djilsi/videos');
  for(const sel of ['button:has-text("Tout accepter")','button:has-text("Accept all")','button:has-text("Tout refuser")','button:has-text("Reject all")']){const b=p.locator(sel).first();if(await b.isVisible().catch(()=>false)){await b.click().catch(()=>{});await p.waitForTimeout(800);break;}}
  let prev=0,stable=0;
  for(let i=0;i<180&&stable<10;i++){const c=await p.locator('a[href*="/watch?v="]').count();stable=c===prev?stable+1:0;prev=c;await p.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await p.waitForTimeout(650);}
  const videos=await p.locator('ytd-rich-item-renderer,ytd-grid-video-renderer').evaluateAll(cards=>{const m=new Map();for(const card of cards){const titleNode=card.querySelector('a#video-title-link,a#video-title');const h=titleNode?.getAttribute('href')||'';if(!h.includes('/watch?v='))continue;const id=new URL('https://www.youtube.com'+h).searchParams.get('v');const title=(titleNode?.getAttribute('title')||titleNode?.textContent||'').replace(/\s+/g,' ').trim();if(!id||!title)continue;const text=(card?.innerText||'').replace(/\s+/g,' ').trim();const dm=text.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/);m.set(id,{id,title,durationText:dm?.[1]||null,cardText:text.slice(0,450)});}return [...m.values()];});
  report.youtube={count:videos.length,videos};
 }catch(e){report.errors.push({scope:'youtube',error:String(e?.message||e)});}finally{await p.close();}
}
const page=await context.newPage();let lock=false;
await context.route('**/*',async route=>{const q=route.request(),method=q.method().toUpperCase();if(lock&&/thetvdb\.com/i.test(q.url())&&!['GET','HEAD','OPTIONS'].includes(method)){report.blockedRequests.push({method,url:q.url()});return route.abort('blockedbyclient');}return route.continue();});
try{
 await go(page,BASE+'/auth/login');const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await f.locator('input[name="email"]').fill(username);await f.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(700);const probe=await context.request.get(BASE+'/auth/getuser');report.authenticated=probe.ok();if(!report.authenticated)throw new Error('TVDB auth not proven');lock=true;
 const maps=new Map();
 for(const y of [...new Set(T.map(x=>x.season))]){await go(page,BASE+'/series/'+SLUG+'/seasons/official/'+y+'/edit');const rows=await page.locator('input[name^="episodes["]').evaluateAll(ins=>ins.map(input=>{const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;const a=c?.querySelector('a[href*="/episodes/"]');const h=a?.href||'';return {number:Number(input.value)||null,id:h.match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};}));maps.set(y,rows);}
 const vids=report.youtube.videos||[];
 for(const t of T){
  const row=(maps.get(t.season)||[]).find(x=>x.number===t.episode)||null;const c={...t,tvdbRow:row,status:'PENDING'};if(!row?.id){c.status='BLOCKED_MAPPING';report.checks.push(c);continue;}
  await go(page,BASE+'/series/'+SLUG+'/episodes/'+row.id+'/0/edit');const mf=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();if(!(await mf.count())){c.status='BLOCKED_FORM';report.checks.push(c);continue;}c.currentDate=await mf.locator('input[name="airdate"]').first().inputValue().catch(()=>null);c.currentRuntime=Number(await mf.locator('input[name="runtime"]').first().inputValue().catch(()=>''))||null;
  const n=norm(t.title);let cand=vids.filter(v=>norm(v.title)===n);if(!cand.length&&t.season===2026)cand=vids.filter(v=>norm(v.title).includes(n)||n.includes(norm(v.title)));c.youtubeCandidates=cand.slice(0,3);const y=cand.length===1?cand[0]:null;
  if(t.runtimeTo!=null){c.youtubeDurationText=y?.durationText||null;c.youtubeRoundedMinutes=rounded(dur(c.youtubeDurationText));c.runtimeTargetConfirmed=c.youtubeRoundedMinutes===t.runtimeTo;}
  if(t.dateTo)c.dateTargetConfirmed=true;
  c.mappingTitleOk=norm(row.title)===norm(t.title)||(t.season===2026&&norm(row.title).includes(n));
  const runOK=t.runtimeTo==null||c.currentRuntime===t.runtimeTo||c.runtimeTargetConfirmed===true;
  const dateOK=!t.dateTo||c.currentDate===t.dateTo||(c.currentDate===t.dateFrom&&c.dateTargetConfirmed);
  c.status=c.mappingTitleOk&&runOK&&dateOK?'PREFLIGHT_OK':'BLOCKED_REVIEW';report.checks.push(c);
 }
}catch(e){report.errors.push({scope:'tvdb',error:String(e?.stack||e)});}finally{await browser.close();}
report.summary={total:report.checks.length,preflightOk:report.checks.filter(x=>x.status==='PREFLIGHT_OK').length,blocked:report.checks.filter(x=>x.status!=='PREFLIGHT_OK').length,runtimeAlreadyCorrect:report.checks.filter(x=>x.runtimeTo!=null&&x.currentRuntime===x.runtimeTo).length,runtimeNeedsChangeConfirmed:report.checks.filter(x=>x.runtimeTo!=null&&x.currentRuntime!==x.runtimeTo&&x.runtimeTargetConfirmed===true&&x.status==='PREFLIGHT_OK').length,dateAlreadyCorrect:report.checks.filter(x=>x.dateTo&&x.currentDate===x.dateTo).length,dateNeedsChangeConfirmed:report.checks.filter(x=>x.dateTo&&x.currentDate===x.dateFrom&&x.status==='PREFLIGHT_OK').length};
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));await fs.writeFile(OUT+'/summary.txt',Object.entries(report.summary).map(([k,v])=>k+'='+v).join('\n')+'\n');console.log(JSON.stringify(report.summary,null,2));if(!report.authenticated||report.errors.length)process.exitCode=2;
