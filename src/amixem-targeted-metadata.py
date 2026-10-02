
import json
from pathlib import Path
import yt_dlp

ids=['Tu0tDXPx_4k','Zja5z7C0c7g','fu-nBHrmokA','tB1RJcIyQqc','zusoj9QmlHc']
out=[]
opts={'quiet':True,'no_warnings':True,'skip_download':True,'retries':3,'socket_timeout':30}
for vid in ids:
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            x=y.extract_info('https://www.youtube.com/watch?v='+vid,download=False)
        out.append({k:x.get(k) for k in ['id','title','upload_date','timestamp','release_timestamp','duration','webpage_url','thumbnail','availability','live_status']})
    except Exception as e:
        out.append({'id':vid,'error':repr(e)})
Path('reports/amixem-targeted').mkdir(parents=True,exist_ok=True)
Path('reports/amixem-targeted/metadata.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
