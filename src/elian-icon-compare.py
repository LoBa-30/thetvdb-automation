import requests,json,hashlib
from PIL import Image
from io import BytesIO
from pathlib import Path
from datetime import datetime,timezone
OUT=Path('reports/elian-icon-compare-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
tvdb='https://artworks.thetvdb.com/banners/v4/series/462729/icons/6a9dc58561428.png'
yt='https://yt3.googleusercontent.com/uOw2e6SJwIsvq2j8rVi3vaTzGXAsgaOcnN2ixb3Sb6TKSOU3LbGhEt_glNOQJE7XHrvIsdOdCb8=s800-c-k-c0x00ffffff-no-rj'
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
def dh(data):
 im=Image.open(BytesIO(data)).convert('L').resize((9,8));p=list(im.getdata());n=0
 for y in range(8):
  row=p[y*9:(y+1)*9]
  for x in range(8): n=(n<<1)|int(row[x]>row[x+1])
 return f'{n:016x}',list(Image.open(BytesIO(data)).size)
def f(url):
 r=S.get(url,timeout=30); h,size=dh(r.content) if r.status_code==200 else (None,None)
 return {'url':url,'status':r.status_code,'bytes':len(r.content),'sha256':hashlib.sha256(r.content).hexdigest() if r.status_code==200 else None,'dhash':h,'size':size}
a=f(tvdb);b=f(yt);dist=(int(a['dhash'],16)^int(b['dhash'],16)).bit_count() if a['dhash'] and b['dhash'] else None
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'tvdbIcon':a,'youtubeAvatar':b,'dhashDistance':dist,'sameExact':a['sha256']==b['sha256'],'needsUpdate':dist is None or dist>4}
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
