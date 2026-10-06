import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const OUT='reports/amixem-s2017-instrument-preflight';
await fs.mkdir(OUT,{recursive:true});
const username=process.env.TVDB_USERNAME;
const password=process.env.TVDB_PASSWORD;
if(!username||!password) throw new Error('Missing TVDB credentials');
const VIDEO_ID='fu-nBHrmokA';
const TVDB='https://thetvdb.com';
const SERIES='328213-show';

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:'fr-FR',
  userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'
});
async function go(page,url){let r=null;for(let i=0;i<3;i++){r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);if(r&&r.status()<400){await page.waitForTimeout(700);return r;}await page.waitForTimeout(700*(i+1));}throw new Error('GET '+url+' '+(r?.status()??'n/a'));}

const report={generatedAt:new Date().toISOString(),mode:'AUTHENTICATED_TVDB_READ_ONLY_PLUS_PUBLIC_YOUTUBE_READ',youtube:{videoId:VIDEO_ID},tvdb:{},errors:[]};

// YouTube public read only.
{
  const p=await context.newPage();
  try{
    const resp=await go(p,'https://www.youtube.com/watch?v='+VIDEO_ID);
    await p.waitForTimeout(1800);
    const html=await p.content();
    const body=(await p.locator('body').innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
    const pick=(re)=>html.match(re)?.[1]??null;
    const meta=async(sel,attr='content')=>p.locator(sel).first().getAttribute(attr).catch(()=>null);
    const ogTitle=await meta('meta[property="og:title"]');
    const datePublished=await meta('meta[itemprop="datePublished"]');
    const uploadDate=await meta('meta[itemprop="uploadDate"]');
    const duration=await meta('meta[itemprop="duration"]');
    const channelId=await meta('meta[itemprop="channelId"]');
    report.youtube={
      videoId:VIDEO_ID,httpStatus:resp.status(),pageTitle:await p.title(),
      title:ogTitle||pick(/"title":"([^"]+)"/),
      publishDate:datePublished||pick(/"publishDate":"(\d{4}-\d{2}-\d{2})"/),
      uploadDate:uploadDate||pick(/"uploadDate":"(\d{4}-\d{2}-\d{2})"/),
      durationIso:duration,
      lengthSeconds:Number(pick(/"lengthSeconds":"(\d+)"/))||null,
      channelId:channelId||pick(/"channelId":"([^"]+)"/),
      loginRequired:/confirmer que vous n'êtes pas un robot|confirm you're not a bot|sign in/i.test(body),
      bodyPreview:body.slice(0,1200)
    };
  }catch(e){report.errors.push({scope:'youtube',error:String(e?.message||e)});}
  finally{await p.close();}
}

// Login, then strict read-only TVDB.
const page=await context.newPage();
let lock=false;
const blocked=[];
await context.route('**/*',async route=>{
  const req=route.request();const method=req.method().toUpperCase();const isTvdb=/thetvdb\.com/i.test(req.url());
  if(lock&&isTvdb&&!['GET','HEAD','OPTIONS'].includes(method)){blocked.push({method,url:req.url()});return route.abort('blockedbyclient');}
  return route.continue();
});
try{
  await go(page,TVDB+'/auth/login');
  const form=page.locator('form').filter({has:page.locator('input[name="password"]')}).first();
  await form.locator('input[name="email"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),form.locator('button[type="submit"],input[type="submit"]').first().click()]);
  await page.waitForTimeout(700);
  const probe=await context.request.get(TVDB+'/auth/getuser');
  report.tvdb.authenticated=probe.ok();
  if(!probe.ok()) throw new Error('TVDB authentication not proven');
  lock=true;
  await go(page,TVDB+'/series/'+SERIES+'/seasons/official/2017/edit');
  const rows=await page.locator('a[href*="/series/'+SERIES+'/episodes/"]').evaluateAll(as=>{
    const seen=new Set(),out=[];
    for(const a of as){
      const m=(a.href||'').match(/\/episodes\/(\d+)/);if(!m||seen.has(m[1]))continue;seen.add(m[1]);
      const c=a.closest('tr')||a.closest('.row')||a.parentElement?.parentElement||a.parentElement;
      const text=(c?.textContent||'').replace(/\s+/g,' ').trim();
      const n=Number(text.match(/^(\d+)\s/)?.[1]||0);
      if(n>=10&&n<=22)out.push({number:n,id:m[1],title:(a.textContent||'').replace(/\s+/g,' ').trim(),rowText:text});
    }
    return out;
  });
  report.tvdb.season2017Rows=rows;
  report.tvdb.focus=[];
  for(const id of ['6102810','6102812']){
    const p=await context.newPage();
    try{
      await go(p,TVDB+'/series/'+SERIES+'/episodes/'+id);
      const body=(await p.locator('body').innerText()).replace(/\s+/g,' ').trim();
      const heading=(await p.locator('h1,h2').allTextContents()).map(x=>x.trim()).find(Boolean)||null;
      report.tvdb.focus.push({
        id,heading,
        firstAired:body.match(/ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)/i)?.[1]||null,
        runtimeMinutes:Number(body.match(/RUNTIME\s+(\d+)\s+minutes?/i)?.[1])||null,
        createdText:body.match(/CREATED\s+(.+?)\s+by\s+/i)?.[1]||null
      });
    }catch(e){report.errors.push({scope:'tvdb_episode',id,error:String(e?.message||e)});}
    finally{await p.close();}
  }
}catch(e){report.errors.push({scope:'tvdb',error:String(e?.message||e)});}
report.tvdb.readOnlyLock=true;report.tvdb.blockedNonReadRequests=blocked;
await browser.close();
await fs.writeFile(OUT+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({youtube:report.youtube,tvdbRows:report.tvdb.season2017Rows?.length,errors:report.errors},null,2));
if(!report.tvdb.authenticated) process.exitCode=2;
