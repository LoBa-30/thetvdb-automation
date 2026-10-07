import requests,json,hashlib
from io import BytesIO
from PIL import Image
from pathlib import Path
from datetime import datetime,timezone

OUT=Path('reports/maxime-two-edge-artworks-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})

def probe(url):
 try:
  r=S.get(url,timeout=25)
  out={'url':url,'status':r.status_code,'bytes':len(r.content),'contentType':r.headers.get('content-type')}
  if r.status_code==200 and len(r.content)>5000:
   im=Image.open(BytesIO(r.content));out['size']=list(im.size);out['sha256']=hashlib.sha256(r.content).hexdigest()
  return out
 except Exception as e:return {'url':url,'error':str(e)}

ids={'S2025E01':'EqFLIsSB2hg','S2019E01':'3X0piITkOTE'}
variants=['maxresdefault.jpg','maxresdefault.webp','hq720.jpg','sddefault.jpg','hqdefault.jpg','mqdefault.jpg','0.jpg']
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_MAXIME_TWO_EDGE_ARTWORKS','probes':{},'s2019OldArtwork':probe('https://artworks.thetvdb.com/banners/v4/episode/11696580/screencap/6ac6494b1c107.jpg')}
for code,vid in ids.items():
 report['probes'][code]=[probe(f'https://i.ytimg.com/vi/{vid}/{v}') for v in variants]

(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
