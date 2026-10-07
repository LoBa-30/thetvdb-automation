import json,re,unicodedata,requests,hashlib,concurrent.futures
from PIL import Image
from io import BytesIO
from pathlib import Path
from datetime import datetime,timezone

OUT=Path('reports/djilsi-visual-artwork-audit-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
SRC=json.loads(Path('reports/djilsi-artwork-preflight-post140-2026-10-07/report.json').read_text(encoding='utf-8'))
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})

def norm(s):
 s=unicodedata.normalize('NFKD',s or '')
 s=''.join(c for c in s if not unicodedata.combining(c)).lower()
 s=re.sub(r'@[\w.-]+',' ',s);s=re.sub(r'[^a-z0-9]+',' ',s)
 return re.sub(r'\s+',' ',s).strip()

def dhash_bytes(data):
 im=Image.open(BytesIO(data)).convert('L').resize((9,8))
 px=list(im.getdata());n=0
 for y in range(8):
  row=px[y*9:(y+1)*9]
  for x in range(8):n=(n<<1)|int(row[x]>row[x+1])
 return f'{n:016x}'

def dist(a,b):return (int(a,16)^int(b,16)).bit_count()

def fetch_img(url):
 try:
  r=S.get(url,timeout=20)
  if r.status_code!=200 or len(r.content)<5000:return None
  im=Image.open(BytesIO(r.content)); size=list(im.size)
  return {'url':url,'status':r.status_code,'bytes':len(r.content),'size':size,'sha256':hashlib.sha256(r.content).hexdigest(),'dhash':dhash_bytes(r.content)}
 except Exception:return None

ymap={}
for y in SRC.get('youtube',[]):
 ymap.setdefault(norm(y.get('title')),[]).append(y)

def inspect(ep):
 row={**ep,'youtube':None,'artworks':[],'status':[]}
 m=ymap.get(norm(ep.get('title')),[])
 if len(m)==1:
  y=m[0]; row['youtube']={'id':y['id'],'title':y['title']}
  for v in ['maxresdefault','sddefault','hqdefault']:
   im=fetch_img(f"https://i.ytimg.com/vi/{y['id']}/{v}.jpg")
   if im and im['status']==200 and im['bytes']>5000:
    row['youtube']['image']=im;row['youtube']['variant']=v;break
 else: row['status'].append('NO_UNIQUE_YOUTUBE_MATCH')
 try:
  rr=S.get(ep['url'],timeout=20)
  urls=sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',rr.text))) if rr.status_code==200 else []
  for u in urls:
   im=fetch_img(u)
   if im:row['artworks'].append(im)
 except Exception:row['status'].append('DETAIL_FETCH_ERROR')
 if not row['artworks']:row['status'].append('NO_ARTWORK')
 if row['artworks'] and row['youtube'] and row['youtube'].get('image'):
  d=min(dist(a['dhash'],row['youtube']['image']['dhash']) for a in row['artworks'])
  row['ownYoutubeDhashDistance']=d
  if d<=4:row['status'].append('MATCHES_OWN_YOUTUBE')
  elif d<=10:row['status'].append('SIMILAR_TO_OWN_YOUTUBE')
  else:row['status'].append('VISUAL_MISMATCH_OWN_YOUTUBE')
 return row

eps=SRC.get('tvdb',[])
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
 rows=list(ex.map(inspect,eps))

exact={}
arts=[]
for e in rows:
 for a in e['artworks']:
  exact.setdefault(a['sha256'],[]).append({'code':e['code'],'episodeId':e['episodeId'],'url':a['url']})
  arts.append({'code':e['code'],'episodeId':e['episodeId'],**a})
exact_groups=[{'sha256':sha,'codes':sorted(set(x['code'] for x in xs)),'items':xs} for sha,xs in exact.items() if len(set(x['code'] for x in xs))>1]
near=[]
for i in range(len(arts)):
 for j in range(i+1,len(arts)):
  if arts[i]['code']==arts[j]['code']:continue
  dd=dist(arts[i]['dhash'],arts[j]['dhash'])
  if dd<=3:near.append({'a':arts[i]['code'],'b':arts[j]['code'],'distance':dd,'aUrl':arts[i]['url'],'bUrl':arts[j]['url']})
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_DJILSI_VISUAL_ARTWORK_AUDIT','episodes':rows,'exactDuplicateGroups':exact_groups,'nearDuplicatePairs':near,'summary':{
 'episodes':len(rows),'withArtwork':sum(bool(x['artworks']) for x in rows),'withoutArtwork':sum(not x['artworks'] for x in rows),
 'withYoutubeMatch':sum(bool(x['youtube']) for x in rows),
 'matchesOwn':sum('MATCHES_OWN_YOUTUBE' in x['status'] for x in rows),
 'similarOwn':sum('SIMILAR_TO_OWN_YOUTUBE' in x['status'] for x in rows),
 'visualMismatchOwn':sum('VISUAL_MISMATCH_OWN_YOUTUBE' in x['status'] for x in rows),
 'exactDuplicateGroups':len(exact_groups),'nearDuplicatePairs':len(near)
}}
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'summary.txt').write_text('\n'.join(f'{k}={v}' for k,v in report['summary'].items())+'\n',encoding='utf-8')
print((OUT/'summary.txt').read_text())

# live rerun after moderator removals 2026-10-07
