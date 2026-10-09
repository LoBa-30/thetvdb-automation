import fs from 'node:fs/promises';
const targets = [
 ['Raska','sa2rwKmeUJw','2023-02-08'],['Raska','YCOZZz-mWYA','2022-08-06'],
 ['Raska','-K0btHmC6Sg','2022-05-08'],['Raska','S1ligBirCWo','2022-02-27'],
 ['Raska','jICa9OCCv1g','2021-09-27'],['Raska','RFHVbWGh6xQ','2021-07-05'],
 ['Mastu','Ks16HI-cLiw','2026-07-18'],['Mcfly & Carlito','ndo5rHMsBNk','2026-10-08'],
 ['Mastu','OUs0_f8wc_U','2026-10-03'],['Squeezie','mxuk-u8Cjuc','2012-12-19'],
 ['Squeezie','aN0c6v10PDo','2012-07-10']
];
const rows=[];
for (const [creator,id,expected] of targets) {
 const url='https://www.youtube.com/watch?v='+id;
 const row={creator,id,expected,source:url,status:'A_REVOIR',observed:null,reason:null};
 try {
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
  row.http=response.status;
  if (!response.ok) row.reason='HTTP_'+response.status;
  else {
   const html=await response.text();
   const identity=html.includes('videoId":"'+id+'"') || html.includes('watch?v='+id);
   const date=identity ? html.match(/"publishDate":"(20[0-9]{2}-[0-9]{2}-[0-9]{2})"/)?.[1] : null;
   row.observed=date||null;
   if (!identity) row.reason='IDENTITY_NOT_CONFIRMED';
   else if (!date) row.reason='NO_OFFICIAL_DATE_VISIBLE';
   else if (date!==expected) row.reason='DATE_MISMATCH';
   else {row.status='VERIFIE_DATE_PRIMAIRE';row.reason='MATCH_PRIMARY_DATE_ONLY';}
  }
 } catch(e) {row.reason='FETCH_ERROR_'+String(e.message).slice(0,100);}
 rows.push(row);
}
const report={version:'V22.2',generatedAt:new Date().toISOString(),mode:'OFFICIAL_YOUTUBE_READ_ONLY',rows,
 totals:{examined:rows.length,verified:rows.filter(r=>r.status==='VERIFIE_DATE_PRIMAIRE').length},
 safeguards:{tvdbWrites:0,tvdbDeletes:0,noDateInference:true}};
await fs.writeFile('reports/v22-2-primary-dates-2026-10-09.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.totals));
