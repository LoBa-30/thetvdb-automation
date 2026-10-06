import json, subprocess, os, re, unicodedata
OUT='reports/joyca-historical'
os.makedirs(OUT,exist_ok=True)
CHANNEL_URL='https://www.youtube.com/c/JOYCA-JORDAN/videos'

items=[
('S2016E37','LE PEN CHANTE NOEL ! (REMIX)','2016-12-24'),
('S2017E04','LA NOUVELLE REVOLUTION APPLE !','2017-01-17'),
('S2017E10',"J'AI UN PROJET FOU...",'2017-02-08'),
('S2017E19','FAIRE UN BEAT AVEC... (SPÉCIAL 1er AVRIL)','2017-04-01'),
('S2017E25','MA PLAYLIST DU MOIS !','2017-05-15'),
('S2017E26','5 MUSIQUES INSOLITES !','2017-05-23'),
('S2017E28','MA PLAYLIST DU MOIS #2','2017-05-31'),
('S2017E34','MA PLAYLIST DU MOIS #3','2017-06-30'),
('S2017E39','MA PLAYLIST DU MOIS #4','2017-07-31'),
('S2017E40',"QU'EST-CE QUE JE FAIS LÀ ?",'2017-08-10'),
('S2017E43','MA PLAYLIST DU MOIS #5','2017-08-30'),
('S2017E46','BLIND TEST EXTREME ! (Ft. Vodk, Mahdi Ba, Mastu)','2017-09-22'),
('S2017E48','MA PLAYLIST DU MOIS #6','2017-10-03'),
('S2017E56','MA PLAYLIST DU MOIS #7 !','2017-11-30'),
('S2018E04','MA PLAYLIST DU MOIS #8','2018-01-31'),
('S2018E12','MA PLAYLIST DU MOIS #9 !','2018-03-31'),
('S2018E17','MA PLAYLIST DU MOIS #10 !','2018-04-30'),
('S2018E23','MA PLAYLIST DU MOIS ! #11','2018-06-01'),
('S2018E43','Je vous dis tout...','2018-10-19'),
('S2023E34','150 000€ SONT EN JEU !','2023-12-11'),
('S2025E05','ON ESSAIE 10 THÉRAPIES INSOLITES (2 sont fausses)','2025-03-16')
]

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()

# Resolve official channel identity from the official Videos tab itself.
p=subprocess.run([
  'yt-dlp','--flat-playlist','--playlist-end','1','--dump-single-json',
  '--no-warnings','--extractor-args','youtube:lang=fr',CHANNEL_URL
],capture_output=True,text=True,timeout=120)
if p.returncode!=0 or not p.stdout.strip():
    raise RuntimeError('Could not resolve official Joyca channel: '+p.stderr[-1000:])
cat=json.loads(p.stdout)
channel_id=cat.get('channel_id') or cat.get('uploader_id')
channel=cat.get('channel') or cat.get('uploader')
if not channel_id:
    # Some flat channel extractors expose identity on first entry.
    es=cat.get('entries') or []
    if es:
        channel_id=es[0].get('channel_id') or es[0].get('uploader_id')
        channel=channel or es[0].get('channel') or es[0].get('uploader')
if not channel_id:
    raise RuntimeError('Official channel_id unavailable from channel catalogue')

out={
 'generatedAt':__import__('datetime').datetime.utcnow().isoformat()+'Z',
 'target':'Joyca',
 'mode':'READ_ONLY_HISTORICAL_SEARCH',
 'officialChannel':{'url':CHANNEL_URL,'channel_id':channel_id,'channel':channel},
 'items':[]
}

for idx,(code,title,tvdate) in enumerate(items,1):
    q=f'ytsearch15:{title} Joyca'
    sp=subprocess.run([
      'yt-dlp','--dump-json','--skip-download','--ignore-errors','--no-warnings',
      '--extractor-args','youtube:lang=fr',q
    ],capture_output=True,text=True,timeout=180)
    results=[]
    for line in sp.stdout.splitlines():
        try:e=json.loads(line)
        except:continue
        results.append({
          'id':e.get('id'),'title':e.get('title'),'channel_id':e.get('channel_id'),
          'channel':e.get('channel'),'uploader':e.get('uploader'),
          'upload_date':e.get('upload_date'),'timestamp':e.get('timestamp'),
          'duration':e.get('duration'),'webpage_url':e.get('webpage_url'),
          'availability':e.get('availability'),'live_status':e.get('live_status')
        })
    official=[r for r in results if r.get('channel_id')==channel_id]
    exact=[r for r in official if norm(r.get('title'))==norm(title)]
    chosen=(exact or official or [None])[0]
    row={
      'code':code,'tvdb_title':title,'tvdb_date':tvdate,
      'search_returncode':sp.returncode,
      'official_results':official,
      'chosen':chosen
    }
    if chosen:
      row['proof']='OFFICIAL_YOUTUBE_SEARCH_RESULT'
      row['title_exact_normalized']=norm(chosen.get('title'))==norm(title)
      row['date_match']=chosen.get('upload_date')==tvdate.replace('-','') if chosen.get('upload_date') else None
    else:
      row['proof']='NO_OFFICIAL_SEARCH_RESULT_FOUND'
      row['title_exact_normalized']=None
      row['date_match']=None
    out['items'].append(row)
    print(idx,code,row['proof'],chosen.get('id') if chosen else '-',chosen.get('upload_date') if chosen else '-')

summary={
 'total':len(out['items']),
 'officialProven':sum(1 for x in out['items'] if x['proof']=='OFFICIAL_YOUTUBE_SEARCH_RESULT'),
 'exactNormalized':sum(1 for x in out['items'] if x.get('title_exact_normalized') is True),
 'unproven':sum(1 for x in out['items'] if x['proof']!='OFFICIAL_YOUTUBE_SEARCH_RESULT'),
 'dateMatches':sum(1 for x in out['items'] if x.get('date_match') is True),
 'dateMismatches':[
   {'code':x['code'],'tvdb_date':x['tvdb_date'],'youtube_upload_date':x['chosen'].get('upload_date'),'youtube_id':x['chosen'].get('id')}
   for x in out['items'] if x.get('date_match') is False
 ]
}
out['summary']=summary
json.dump(out,open(f'{OUT}/historical.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
json.dump(summary,open(f'{OUT}/summary.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
