
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const username=process.env.TVDB_USERNAME, password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');
const BASE='https://thetvdb.com', SLUG='djilsi', OUT='reports/djilsi-metadata-final-verification';
await fs.mkdir(OUT,{recursive:true});

const EXPECTED=[
['9242990',2018,1,null,'2018-08-09'],
['9242992',2018,3,7],['9242995',2018,6,15],['9243020',2018,15,14],
['9243034',2019,7,9],['9243035',2019,8,6],['9243049',2019,22,23],['9243050',2019,23,24],['9243051',2019,24,32],['9243057',2019,29,8],['9243064',2019,36,9],
['9243084',2020,5,22],['9243162',2020,27,21],
['9243181',2021,15,33],['9243184',2021,18,52],
['9243195',2022,7,50],['9254620',2022,8,46],['9477724',2022,16,66],['9477725',2022,17,95],['9477730',2022,21,65],
['9812414',2023,7,41],['9812432',2023,8,51],['10740763',2023,15,101],['10740764',2023,16,92],
['10824277',2024,2,58],['10824283',2024,8,69],['10824294',2024,14,46,'2024-10-26'],
['11684522',2025,1,53],['11684527',2025,6,55],
['11971086',2026,13,49],['11976892',2026,14,45]
].map(x=>({id:x[0],season:x[1],episode:x[2],runtime:x[3]??null,date:x[4]??null}));

const report={generatedAt:new Date().toISOString(),target:'Djilsi',mode:'AUTHENTICATED_STRICT_READ_ONLY_POST_APPLY',authenticated:false,checks:[],structure2026:null,seriesFirstAired:null,blockedNonReadRequests:[],errors:[],ok:false};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'fr-FR',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
async function go(url){let r=null;for(let i=0;i<3;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(250);return r;}await page.waitForTimeout(500*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}

try{
  await go(BASE+'/auth/login');
  const f=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await f.locator('input[name="email"]').fill(username);
  await f.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),f.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(650);
  const probe=await context.request.get(BASE+'/auth/getuser').catch(()=>null);
  report.authenticated=Boolean(probe?.ok());
  if(!report.authenticated) throw new Error('Authenticated session not proven');

  await context.route('**/*',async route=>{
    const req=route.request(),method=req.method().toUpperCase();
    if(/thetvdb\.com/i.test(req.url())&&!['GET','HEAD','OPTIONS'].includes(method)){
      report.blockedNonReadRequests.push({method,url:req.url()});
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  for(const x of EXPECTED){
    await go(BASE+'/series/'+SLUG+'/episodes/'+x.id+'/0/edit');
    const mf=page.locator('form').filter({has:page.locator('input[name="airdate"],input[name="runtime"]')}).first();
    if(!(await mf.count())){report.checks.push({...x,ok:false,error:'metadata form missing'});continue;}
    const actualDate=await mf.locator('input[name="airdate"]').first().inputValue().catch(()=>null);
    const actualRuntime=Number(await mf.locator('input[name="runtime"]').first().inputValue().catch(()=>''))||null;
    const runtimeOk=x.runtime==null||actualRuntime===x.runtime;
    const dateOk=x.date==null||actualDate===x.date;
    report.checks.push({...x,actualRuntime,actualDate,runtimeOk,dateOk,ok:runtimeOk&&dateOk});
  }

  await go(BASE+'/series/'+SLUG+'/seasons/official/2026/edit');
  const rows=await page.locator('input[name^="episodes["]').evaluateAll(ins=>ins.map(input=>{
    const c=input.closest('tr')||input.closest('.row')||input.parentElement?.parentElement||input.parentElement;
    const a=c?.querySelector('a[href*="/episodes/"]');
    return {number:Number(input.value)||null,id:(a?.href||'').match(/\/episodes\/(\d+)/)?.[1]||null,title:(a?.textContent||'').replace(/\s+/g,' ').trim()};
  }));
  const e11=rows.find(x=>x.number===11)||null,e13=rows.find(x=>x.number===13)||null,e14=rows.find(x=>x.number===14)||null;
  report.structure2026={
    count:rows.length,e11,e13,e14,
    announcementPreserved:Boolean(e11&&/RDV LE SAMEDI 5 SEPTEMBRE À 11H/i.test(e11.title)),
    e13Preserved:Boolean(e13&&e13.id==='11971086'),
    e14Preserved:Boolean(e14&&e14.id==='11976892')
  };

  await go(BASE+'/series/'+SLUG);
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
  report.seriesFirstAired=body.match(/First Aired\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1]||null;

  report.ok=report.checks.length===EXPECTED.length &&
    report.checks.every(x=>x.ok) &&
    report.structure2026.count===17 &&
    report.structure2026.announcementPreserved &&
    report.structure2026.e13Preserved &&
    report.structure2026.e14Preserved &&
    report.seriesFirstAired==='August 9, 2018';
}catch(e){report.errors.push(String(e?.stack||e));}
finally{await browser.close();}

await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
await fs.writeFile(OUT+'/summary.txt',[
  'authenticated='+report.authenticated,
  'checks='+report.checks.length,
  'passed='+report.checks.filter(x=>x.ok).length,
  'failed='+report.checks.filter(x=>!x.ok).length,
  'seriesFirstAired='+(report.seriesFirstAired||'null'),
  'announcementPreserved='+(report.structure2026?.announcementPreserved??false),
  'structure2026Count='+(report.structure2026?.count??0),
  'errors='+report.errors.length,
  'ok='+report.ok
].join('\n')+'\n');
console.log(await fs.readFile(OUT+'/summary.txt','utf8'));
if(!report.ok) process.exitCode=2;
