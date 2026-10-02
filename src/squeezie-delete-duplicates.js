import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const username=process.env.TVDB_USERNAME,password=process.env.TVDB_PASSWORD;
const cases=[
 {source:'6975388',target:'6952099',expectedTarget:'JE VIDE MON SAC !'},
 {source:'10779950',target:'10779957',expectedTarget:'72h enfermés dans les catacombes'},
 {source:'10779951',target:'10779957',expectedTarget:'72h enfermés dans les catacombes'},
 {source:'10940462',target:'10940465',expectedTarget:'Des inconnus nous jugent #2'},
 {source:'10940463',target:'10940465',expectedTarget:'Des inconnus nous jugent #2'}
];
await fs.mkdir('reports/squeezie-deep',{recursive:true});
const result={generatedAt:new Date().toISOString(),mode:'EXACT_DUPLICATE_DELETE',actions:[]};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
await page.goto('https://thetvdb.com/auth/login',{waitUntil:'domcontentloaded',timeout:60000});
const login=page.locator('form').filter({has:page.locator('input[type=password]')}).first();
await login.locator('input[name=email]').fill(username);await login.locator('input[name=password]').fill(password);
await Promise.all([page.waitForLoadState('domcontentloaded').catch(()=>{}),login.locator('button[type=submit],input[type=submit]').first().click()]);
await page.waitForTimeout(1500);
if(/\/auth\/login/.test(page.url())) throw new Error('Authentication failed');

for(const c of cases){
 const action={...c,status:'pending',checks:{}};
 try{
   // Verify canonical target first.
   const tr=await page.goto('https://thetvdb.com/series/279758-show/episodes/'+c.target,{waitUntil:'domcontentloaded',timeout:60000});
   await page.waitForTimeout(300);
   const targetBody=(await page.locator('body').innerText()).replace(/\s+/g,' ');
   action.checks.targetHttp=tr?.status();
   action.checks.targetMatches=targetBody.toLowerCase().includes(c.expectedTarget.toLowerCase());
   if(!action.checks.targetMatches) throw new Error('Canonical target mismatch; blocked');

   // Re-open current source immediately before deletion.
   const sr=await page.goto('https://thetvdb.com/series/279758-show/episodes/'+c.source,{waitUntil:'domcontentloaded',timeout:60000});
   await page.waitForTimeout(300);
   action.checks.sourceHttpBefore=sr?.status();
   const del=page.locator('form[action*="/entity/delete"]').first();
   if(!(await del.count())){ action.status='already-absent'; result.actions.push(action); continue; }
   const hiddenId=await del.locator('input[name=id]').inputValue();
   const hiddenType=await del.locator('input[name=type]').inputValue();
   action.checks.formSourceId=hiddenId; action.checks.formType=hiddenType;
   if(hiddenId!==c.source||hiddenType!=='3') throw new Error('Delete form identity mismatch');

   const values=await del.evaluate((form,target)=>{
     form.querySelector('select[name="delete-reason"]').value='50';
     form.querySelector('select[name="mergeto_entitytype"]').value='3';
     form.querySelector('input[name="mergeto_id"]').value=target;
     return Object.fromEntries([...new FormData(form).entries()]);
   },c.target);
   action.checks.formValues={deleteReason:values['delete-reason'],mergeType:values['mergeto_entitytype'],mergeId:values['mergeto_id']};
   if(values['delete-reason']!=='50'||values['mergeto_entitytype']!=='3'||values['mergeto_id']!==c.target) throw new Error('Delete payload pre-submit mismatch');

   await Promise.all([
     page.waitForLoadState('domcontentloaded').catch(()=>{}),
     del.evaluate(form=>form.submit())
   ]);
   await page.waitForTimeout(900);

   // Verify source no longer resolves as editable episode.
   const vr=await page.goto('https://thetvdb.com/series/279758-show/episodes/'+c.source,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
   await page.waitForTimeout(200);
   const body=((await page.locator('body').innerText().catch(()=>''))||'').replace(/\s+/g,' ');
   const stillDelete=await page.locator('form[action*="/entity/delete"] input[name=id][value="'+c.source+'"]').count();
   action.checks.sourceHttpAfter=vr?.status()??null;
   action.checks.sourceStillEditable=stillDelete>0;
   action.checks.afterUrl=page.url();
   action.status=stillDelete===0?'deleted':'verification-failed';
 }catch(e){action.status='error';action.error=String(e?.message||e);}
 result.actions.push(action);
 if(action.status==='verification-failed'||action.status==='error') break;
}
await browser.close();
result.success=result.actions.length===cases.length&&result.actions.every(a=>['deleted','already-absent'].includes(a.status));
await fs.writeFile('reports/squeezie-deep/delete-apply.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
if(!result.success) process.exitCode=2;
