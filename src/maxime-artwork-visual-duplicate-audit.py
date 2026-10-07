import json,re,unicodedata,subprocess,requests,hashlib,sys
from bs4 import BeautifulSoup
from PIL import Image
from io import BytesIO
from pathlib import Path
from datetime import datetime,timezone

OUT=Path('reports/maxime-artwork-visual-duplicate-audit-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
BASE='https://thetvdb.com';SLUG='maxime-biaggi';SEASONS=[2019,2021,2022,2023,2024,2025,2026]
YT='https://www.youtube.com/c/MaximeBiaggi/videos'
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})

def norm(s):
 s=unicodedata.normalize('NFKD',s or '')
 s=''.join(c for c in s if not unicodedata.combining(c)).lower()
 s=re.sub(r'@[\w.-]+',' ',s);s=re.sub(r'[^a-z0-9]+',' ',s)
 return re.sub(r'\s+',' ',s).strip()

def dhash(data):
 im=Image.open(BytesIO(data)).convert('L').resize((9,8))
 px=list(im.getdata());bits=[]
 for y in range(8):
  row=px[y*9:(y+1)*9]
  bits.extend(row[x]>row[x+1] for x in range(8))
 n=0
 for b in bits:n=(n<<1)|int(b)
 return f'{n:016x}'

def dist(a,b):
 return (int(a,16)^int(b,16)).bit_count()

def fetch_img(url):
 try:
  r=S.get(url,timeout=30)
  if r.status_code!=200 or len(r.content)<5000:return None
  im=Image.open(BytesIO(r.content)); im.verify()
  return {'url':url,'bytes':len(r.content),'sha256':hashlib.sha256(r.content).hexdigest(),'dhash':dhash(r.content)}
 except Exception:return None

report={'generatedAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_MAXIME_VISUAL_ARTWORK_DUPLICATE_AUDIT','episodes':[],'exactDuplicateGroups':[],'nearDuplicatePairs':[],'wrongEpisodeCandidates':[],'summary':{},'blocked':[]}

try:
 raw=subprocess.check_output(['yt-dlp','--flat-playlist','--dump-single-json','--no-warnings','--extractor-args','youtube:lang=fr',YT],text=True)
 cat=json.loads(raw); vids=[{'id':e.get('id'),'title':e.get('title')} for e in (cat.get('entries') or []) if e.get('id') and e.get('title')]
except Exception as e:
 report['blocked'].append({'reason':'YTDLP_FAILED','error':str(e)});vids=[]
by_norm={}
for v in vids:by_norm.setdefault(norm(v['title']),[]).append(v)

episodes=[]
for season in SEASONS:
 try:
  r=S.get(f'{BASE}/series/{SLUG}/seasons/official/{season}',timeout=40)
  if r.status_code!=200:
   report['blocked'].append({'season':season,'reason':'TVDB_SEASON_HTTP','status':r.status_code});continue
  soup=BeautifulSoup(r.text,'html.parser')
  seen=set()
  for a in soup.select('a[href*="/episodes/"]'):
   href=a.get('href') or '';m=re.search(r'/episodes/(\d+)',href)
   title=' '.join(a.get_text(' ',strip=True).split())
   if not m or not title or m.group(1) in seen:continue
   tr=a.find_parent('tr');txt=' '.join(tr.get_text(' ',strip=True).split()) if tr else ''
   cm=re.search(rf'S{season}E(\d+)',txt,re.I)
   if not cm:continue
   seen.add(m.group(1))
   episodes.append({'season':season,'episode':int(cm.group(1)),'code':f'S{season}E{int(cm.group(1)):02d}','episodeId':m.group(1),'title':title,'url':BASE+href if href.startswith('/') else href})
 except Exception as e:report['blocked'].append({'season':season,'reason':'TVDB_SEASON_ERROR','error':str(e)})

# Pull YouTube IDs from prior verified Maxime reports as authoritative fallback.
history={}
for rp in Path('reports').glob('maxime-artwork*/report.json'):
 try:
  h=json.loads(rp.read_text(encoding='utf-8'))
  for row in h.get('results',[]) or []:
   if row.get('code') and row.get('youtubeId'):history[row['code']]={'id':row['youtubeId'],'title':row.get('title') or row.get('youtubeTitle')}
 except Exception:pass
for rp in [Path('reports/maxime-artwork-preflight-2026-10-07/report.json')]:
 if rp.exists():
  try:
   h=json.loads(rp.read_text(encoding='utf-8'))
   for row in (h.get('planned') or [])+(h.get('checked') or []):
    if row.get('code') and row.get('youtubeId'):history.setdefault(row['code'],{'id':row['youtubeId'],'title':row.get('youtubeTitle') or row.get('title')})
  except Exception:pass

# Download all official thumbnails once.
ytimgs={}
for v in vids:
 img=fetch_img(f"https://i.ytimg.com/vi/{v['id']}/maxresdefault.jpg")
 if img:ytimgs[v['id']]={**img,'title':v['title'],'id':v['id']}

for ep in episodes:
 row={**ep,'youtube':None,'artworks':[],'status':[]}
 matches=by_norm.get(norm(ep['title']),[])
 v=matches[0] if len(matches)==1 else history.get(ep['code'])
 if v:
  row['youtube']={'id':v['id'],'title':v.get('title'),'image':ytimgs.get(v['id']) or fetch_img(f"https://i.ytimg.com/vi/{v['id']}/maxresdefault.jpg")}
 try:
  rr=S.get(ep['url'],timeout=30)
  urls=sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',rr.text))) if rr.status_code==200 else []
  for u in urls:
   im=fetch_img(u)
   if im:row['artworks'].append(im)
 except Exception as e:row['status'].append('DETAIL_ERROR:'+str(e))
 if not row['artworks']:row['status'].append('NO_ARTWORK')
 if not row['youtube']:row['status'].append('NO_UNIQUE_YOUTUBE_MATCH')
 if row['artworks'] and row['youtube'] and row['youtube'].get('image'):
  own=min(dist(a['dhash'],row['youtube']['image']['dhash']) for a in row['artworks'])
  row['ownYoutubeDhashDistance']=own
  if own<=4:row['status'].append('MATCHES_OWN_YOUTUBE')
  elif own<=10:row['status'].append('SIMILAR_TO_OWN_YOUTUBE')
  else:row['status'].append('VISUAL_MISMATCH_OWN_YOUTUBE')
 report['episodes'].append(row)

# Exact duplicate TVDB image bytes across distinct episode codes.
by_sha={}
for e in report['episodes']:
 for a in e['artworks']:by_sha.setdefault(a['sha256'],[]).append({'code':e['code'],'episodeId':e['episodeId'],'url':a['url']})
for sha,items in by_sha.items():
 codes=sorted(set(x['code'] for x in items))
 if len(codes)>1:report['exactDuplicateGroups'].append({'sha256':sha,'codes':codes,'items':items})

# Near duplicate current artworks across different episodes, conservative dHash <= 3.
arts=[]
for e in report['episodes']:
 for a in e['artworks']:arts.append({'code':e['code'],'episodeId':e['episodeId'],**a})
for i in range(len(arts)):
 for j in range(i+1,len(arts)):
  if arts[i]['code']==arts[j]['code']:continue
  dd=dist(arts[i]['dhash'],arts[j]['dhash'])
  if dd<=3:report['nearDuplicatePairs'].append({'a':arts[i]['code'],'b':arts[j]['code'],'distance':dd,'aUrl':arts[i]['url'],'bUrl':arts[j]['url']})

# For visual mismatches, see if artwork is much closer to another official YouTube thumb.
for e in report['episodes']:
 if not e['artworks'] or not e['youtube'] or not e['youtube'].get('image'):continue
 own=e.get('ownYoutubeDhashDistance',99)
 if own<=10:continue
 best=None
 for a in e['artworks']:
  for vid,yi in ytimgs.items():
   dd=dist(a['dhash'],yi['dhash'])
   if best is None or dd<best['distance']:best={'youtubeId':vid,'title':yi['title'],'distance':dd,'artworkUrl':a['url']}
 if best and best['distance']<=6:
  report['wrongEpisodeCandidates'].append({'code':e['code'],'title':e['title'],'ownYoutubeId':e['youtube']['id'],'ownDistance':own,'bestOther':best})

report['summary']={
 'tvdbEpisodes':len(episodes),'youtubeVideos':len(vids),
 'episodesWithArtwork':sum(bool(e['artworks']) for e in report['episodes']),
 'episodesWithYoutubeMatch':sum(bool(e['youtube']) for e in report['episodes']),
 'ownMatchesStrong':sum('MATCHES_OWN_YOUTUBE' in e['status'] for e in report['episodes']),
 'ownMatchesSimilar':sum('SIMILAR_TO_OWN_YOUTUBE' in e['status'] for e in report['episodes']),
 'ownVisualMismatch':sum('VISUAL_MISMATCH_OWN_YOUTUBE' in e['status'] for e in report['episodes']),
 'exactDuplicateGroups':len(report['exactDuplicateGroups']),
 'nearDuplicatePairs':len(report['nearDuplicatePairs']),
 'wrongEpisodeCandidates':len(report['wrongEpisodeCandidates'])
}
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'summary.txt').write_text('\n'.join(f'{k}={v}' for k,v in report['summary'].items())+'\n',encoding='utf-8')
print((OUT/'summary.txt').read_text())

# final rerun after Maxime gap repair

# rerun after 62/64 live coverage 2026-10-07T19:24+02:00

# final rerun after S2019E01 reattached 2026-10-07T19:31+02:00

# rerun after Maxime artwork gap repairs 2026-10-07T20:17Z
