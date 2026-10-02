import json, subprocess, shlex, os, re
OUT='reports/mastu-historical'
os.makedirs(OUT,exist_ok=True)
CHANNEL='UCAhaFPP6v3WCfK5Tjao0B7A'
items=[
('S2023E17','LOUP-GAROU NOCTURNE (Avec Joyca, Michou, Maghla...)','2023-10-29','10115998'),
('S2021E54','QU’EST-CE QU’ELLE FAIT LÀ?! (Je suis choqué)','2021-12-18','9195502'),
('S2021E31','NOS PREMIERES CONVERSATIONS MESSENGER (Feat @THEODORT)','2021-09-11','8762550'),
('S2020E34',"JE VOUS FAIS VISITER MA MAISON (6 mois après, j'ai un nouveau chaton)",'2020-11-21','8070766'),
('S2019E32',"JE SUIS UN MAUVAIS CITOYEN (La clé de bras m'a fait mal)",'2019-11-02','11467845'),
('S2018E32','YouTube va mal...','2018-11-17','6941565'),
('S2018E29',"J'ai besoin de vous parler",'2018-10-13','6941542'),
('S2018E25','JE VAIS ÊTRE HONNÊTE AVEC VOUS...','2018-08-22','6837940'),
('S2018E12','QUI DE NOUS TROIS ? Ft Amixem & VodK','2018-04-01','6645830'),
('S2018E09',"J'AI RETROUVÉ DES VIDÉOS HONTEUSES SUR MON TÉLÉPHONE...",'2018-03-13','6953922'),
('S2018E08','QUAND 2 BEAUFS PRENNENT LA VOITURE','2018-03-03','6953923'),
('S2018E05',"JE N'ARRIVE PAS À JOUER À FORTNITE... (TOP 1 raté)",'2018-02-19','6953926'),
('S2017E40','DES YOUTUBERS ME CLASHENT SUR TWITTER !','2017-07-08','9195825'),
('S2017E36','MANGER BEAUCOUP ET NE PAS GROSSIR','2017-06-21','9195821'),
('S2017E31','PROVOQUER UNE ÉMEUTE DE VACHES EN VOITURE','2017-05-25','9195816'),
('S2016E09','JE RÉPONDS À VOS QUESTIONS ÉTRANGES...','2016-08-02','9195596'),
]
def norm(s):
    s=(s or '').lower()
    s=re.sub(r'[^a-z0-9àâäéèêëîïôöùûüç]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()
out=[]
for i,(code,title,tvdate,eid) in enumerate(items,1):
    q=f'ytsearch10:{title} Mastu'
    cmd=['yt-dlp','--dump-json','--skip-download','--ignore-errors','--no-warnings','--extractor-args','youtube:lang=fr',q]
    p=subprocess.run(cmd,capture_output=True,text=True,timeout=180)
    results=[]
    for line in p.stdout.splitlines():
        try:e=json.loads(line)
        except:continue
        results.append({
            'id':e.get('id'),'title':e.get('title'),'channel_id':e.get('channel_id'),
            'channel':e.get('channel'),'uploader':e.get('uploader'),'upload_date':e.get('upload_date'),
            'timestamp':e.get('timestamp'),'duration':e.get('duration'),'webpage_url':e.get('webpage_url'),
            'availability':e.get('availability')
        })
    official=[r for r in results if r.get('channel_id')==CHANNEL]
    exact=[r for r in official if norm(r.get('title'))==norm(title)]
    chosen=(exact or official or [None])[0]
    row={'code':code,'tvdb_title':title,'tvdb_date':tvdate,'episode_id':eid,
         'search_returncode':p.returncode,'official_results':official,'chosen':chosen}
    if chosen:
        row['proof']='OFFICIAL_YOUTUBE_SEARCH_RESULT'
        row['date_match']=chosen.get('upload_date')==tvdate.replace('-','') if chosen.get('upload_date') else None
    else:
        row['proof']='NO_OFFICIAL_SEARCH_RESULT_FOUND'
        row['date_match']=None
    out.append(row)
    print(i,code,row['proof'],chosen.get('id') if chosen else '-',chosen.get('upload_date') if chosen else '-')
json.dump(out,open(f'{OUT}/historical.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
summary={'total':len(out),'official_proven':sum(1 for x in out if x['proof']=='OFFICIAL_YOUTUBE_SEARCH_RESULT'),
         'unproven':sum(1 for x in out if x['proof']!='OFFICIAL_YOUTUBE_SEARCH_RESULT'),
         'date_mismatches':[{'code':x['code'],'tvdb_date':x['tvdb_date'],'youtube_upload_date':x['chosen'].get('upload_date'),'youtube_id':x['chosen'].get('id')} for x in out if x.get('date_match') is False]}
json.dump(summary,open(f'{OUT}/summary.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
