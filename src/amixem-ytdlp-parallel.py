
import json, os, concurrent.futures, time
from pathlib import Path
import yt_dlp

SRC=Path('reports/amixem-final/catalogue.json')
OUT=Path('reports/amixem-ytdlp-parallel')
OUT.mkdir(parents=True, exist_ok=True)
cat=json.loads(SRC.read_text(encoding='utf-8'))
entries=[e for e in (cat.get('entries') or []) if e.get('id')]
opts={
 'quiet':True,'no_warnings':True,'skip_download':True,
 'extractor_args':{'youtube':{'player_client':['web']}},
 'retries':2,'socket_timeout':30
}
def one(e):
    url='https://www.youtube.com/watch?v='+e['id']
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            x=y.extract_info(url,download=False)
        return {'ok':True,'id':x.get('id'),'title':x.get('title'),'upload_date':x.get('upload_date'),
                'timestamp':x.get('timestamp'),'release_timestamp':x.get('release_timestamp'),
                'duration':x.get('duration'),'thumbnail':x.get('thumbnail'),
                'availability':x.get('availability'),'live_status':x.get('live_status'),'webpage_url':x.get('webpage_url')}
    except Exception as ex:
        return {'ok':False,'id':e['id'],'title':e.get('title'),'error':repr(ex)}

results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    futs=[ex.submit(one,e) for e in entries]
    for i,f in enumerate(concurrent.futures.as_completed(futs),1):
        results.append(f.result())
        if i%50==0: print(f'completed {i}/{len(futs)}',flush=True)

good=[x for x in results if x.get('ok')]
bad=[x for x in results if not x.get('ok')]
good.sort(key=lambda x:x['id'])
(OUT/'full.json').write_text(json.dumps(good,ensure_ascii=False,indent=2),encoding='utf-8')
(OUT/'errors.json').write_text(json.dumps(bad,ensure_ascii=False,indent=2),encoding='utf-8')
summary={'requested':len(entries),'good':len(good),'errors':len(bad),
         'with_upload_date':sum(bool(x.get('upload_date')) for x in good),
         'with_duration':sum(x.get('duration') is not None for x in good)}
(OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False))
