import requests,json
from PIL import Image
from io import BytesIO
from datetime import datetime,timezone
from pathlib import Path

OUT=Path('reports/maxime-s2025e01-thumbnail-probe-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
vid='EqFLIsSB2hg'
variants=['maxresdefault.jpg','hq720.jpg','sddefault.jpg','hqdefault.jpg','0.jpg']
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
rows=[]
for name in variants:
 url=f'https://i.ytimg.com/vi/{vid}/{name}'
 try:
  r=S.get(url,timeout=20)
  row={'name':name,'url':url,'status':r.status_code,'bytes':len(r.content),'contentType':r.headers.get('content-type')}
  if r.status_code==200 and r.headers.get('content-type','').startswith('image/'):
   im=Image.open(BytesIO(r.content));row['size']=list(im.size)
  rows.append(row)
 except Exception as e:rows.append({'name':name,'url':url,'error':str(e)})
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'youtubeId':vid,'variants':rows}
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
