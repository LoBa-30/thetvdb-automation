
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const armed=String(process.env.TVDB_ELIAN_ARTWORK_PILOT||'').toLowerCase()==='yes';
if(!armed||!username||!password)throw new Error('Not armed or missing credentials');
const BASE='https://thetvdb.com',SLUG='elian-ventre-462729',SERIES='462729';
const X={id:'11092251',code:'S2023E04',title:'STRUCTURE ESPORT DE LUXE ?',youtubeId:'QboHB6hZ5dg',imageUrl:'https://i.ytimg.com/vi/QboHB6hZ5dg/maxresdefault.jpg'};
const OUT='reports/elian-artwork-pilot';
await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const report={generatedAt:new Date().toISOString(),target:'Elian '+X.code,mode:'GUARDED_OFFICIAL_YOUTUBE_ARTWORK_PILOT',authenticated:false,preflight:{},write:null,verification:null,blocked:[],result:'NOT_STARTED'};
async function go(u){const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(350);if(!r||r.status()>=400)throw new Error('GET '+u+' '+(r?.status()??'n/a'));return r;}
function artUrls(html){return [...html.matchAll(/https:\/\/artworks\.thetvdb\.com\/[^"'<>\s]+episode[^"'<>\s]+\/screencap\/[^"'<>\s]+/g)].map(x=>x[0].replace(/&amp;/g,'&'));}
try{
 await go(BASE+'/auth/login');const lf=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();await lf.locator('input[name="email"]').fill(username);await lf.locator('input[name="password"]').fill(password);await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),lf.locator('button[type="submit"],input[type="submit"]').first().click()]);await page.waitForTimeout(650);const probe=await context.request.get(BASE+'/auth/getuser');report.authenticated=probe.ok();if(!report.authenticated)throw new Error('Auth not proven');

 await go(BASE+'/series/'+SLUG+'/episodes/'+X.id);
 const beforeHtml=await page.content();
 const before=artUrls(beforeHtml);
 const heading=(await page.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
 report.preflight={heading,beforeArtwork:before,expectedTitle:X.title,youtubeId:X.youtubeId,imageUrl:X.imageUrl};
 if(heading!==X.title){report.blocked.push({reason:'TITLE_DRIFT',heading});throw new Error('TITLE_DRIFT');}
 if(before.length){report.blocked.push({reason:'ARTWORK_ALREADY_PRESENT',before});throw new Error('ARTWORK_ALREADY_PRESENT');}

 const upload=BASE+'/artwork/upload?type=11&episode='+X.id+'&series='+SERIES;
 await go(upload);
 const f=page.locator('form[action*="/artwork/upload_handler"]').first();if(!(await f.count()))throw new Error('Upload form missing');
 const ep=await f.locator('input[name="episode"]').inputValue(),series=await f.locator('input[name="series"]').inputValue(),type=await f.locator('input[name="type"]').inputValue();
 if(ep!==X.id||series!==SERIES||type!=='11'){report.blocked.push({reason:'FORM_SCOPE_DRIFT',ep,series,type});throw new Error('FORM_SCOPE_DRIFT');}
 await f.locator('input[name="url"]').fill(X.imageUrl);
 let bad=null;
 const h=async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='DELETE'||/\/entity\/delete/.test(u.pathname)){bad='DESTRUCTIVE';return route.abort();}if(u.origin===BASE&&req.method()==='POST'&&u.pathname!=='/artwork/upload_handler'){bad='UNEXPECTED_POST '+u.pathname;return route.abort();}return route.continue();};
 await context.route('**/*',h);
 await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.evaluate(form=>form.requestSubmit())]);
 await page.waitForTimeout(900);await context.unroute('**/*',h);
 if(bad)throw new Error(bad);
 report.write={episodeId:X.id,imageUrl:X.imageUrl,submitted:true};

 await go(BASE+'/series/'+SLUG+'/episodes/'+X.id);
 const after=artUrls(await page.content());
 report.verification={afterArtwork:after,artworkPresent:after.length>0};
 report.result=report.verification.artworkPresent?'APPLIED_AND_VERIFIED':'VERIFY_FAILED';
}catch(e){if(!report.blocked.length)report.blocked.push({reason:String(e?.message||e)});if(report.result==='NOT_STARTED')report.result='BLOCKED';}
finally{await browser.close();}
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.result!=='APPLIED_AND_VERIFIED')process.exitCode=2;
