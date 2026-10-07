import requests,json
from PIL import Image
from io import BytesIO
from datetime import datetime,timezone
from pathlib import Path

OUT=Path('reports/maxime-s2025e01-thumbnail-probe-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
vid='EqFLIsSB2hg'
variants=['maxresdefault.jpg','maxres1.jpg','maxres2.jpg','maxres3.jpg','hq720.jpg','sddefault.jpg','sd1.jpg','sd2.jpg','sd3.jpg','hqdefault.jpg','hq1.jpg','hq2.jpg','hq3.jpg','0.jpg','1.jpg','2.jpg','3.jpg','maxresdefault.webp','maxres1.webp','maxres2.webp','maxres3.webp','sddefault.webp','sd1.webp','sd2.webp','sd3.webp','hqdefault.webp','hq1.webp','hq2.webp','hq3.webp']
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
rows=[]
for name in variants:
 url=(f'https://i.ytimg.com/vi_webp/{vid}/{name}' if name.endswith('.webp') else f'https://i.ytimg.com/vi/{vid}/{name}')
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

# save candidate frame images for private visual inspection
for row in rows:
    if row.get('name') in ('maxres1.jpg','maxres2.jpg','maxres3.jpg') and row.get('status')==200 and row.get('size')==[1280,720]:
        rr=S.get(row['url'],timeout=20)
        if rr.status_code==200:
            (OUT/row['name']).write_bytes(rr.content)
