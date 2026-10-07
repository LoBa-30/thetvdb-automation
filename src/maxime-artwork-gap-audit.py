import json,re,unicodedata,subprocess,requests,hashlib
from bs4 import BeautifulSoup
from PIL import Image
from io import BytesIO
from pathlib import Path
from datetime import datetime,timezone

OUT=Path('reports/maxime-artwork-gap-audit-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
BASE='https://thetvdb.com';SLUG='maxime-biaggi';SEASONS=[2019,2021,2022,2023,2024,2025,2026]
YT='https://www.youtube.com/c/MaximeBiaggi/videos'
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})

def norm(s):
 s=unicodedata.normalize('NFKD',s or '')
 s=''.join(c for c in s if not unicodedata.combining(c)).lower()
 s=re.sub(r'@[\w.-]+',' ',s);s=re.sub(r'[^a-z0-9]+',' ',s)
 return re.sub(r'\s+',' ',s).strip()

def art_urls(html):
 return sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',html)))

def fetch_img(url):
 try:
  r=S.get(url,timeout=30)
  if r.status_code!=200 or len(r.content)<5000:return {'status':r.status_code,'bytes':len(r.content)}
  im=Image.open(BytesIO(r.content))
  return {'status':r.status_code,'bytes':len(r.content),'size':list(im.size),'sha256':hashlib.sha256(r.content).hexdigest()}
 except Exception as e:return {'error':str(e)}

# verified write history
written={}
for rp in Path('reports').glob('maxime-artwork*/report.json'):
 try:
  d=json.loads(rp.read_text(encoding='utf-8'))
  for row in d.get('results',[]) or []:
   if row.get('status')=='APPLIED_AND_VERIFIED' and row.get('code'):
    written[row['code']]={'report':str(rp),'youtubeId':row.get('youtubeId'),'artwork':(row.get('verification') or {}).get('artwork',[None])[0] if isinstance((row.get('verification') or {}).get('artwork'),list) else None}
 except Exception:pass

raw=subprocess.check_output(['yt-dlp','--flat-playlist','--dump-single-json','--no-warnings','--extractor-args','youtube:lang=fr',YT],text=True)
cat=json.loads(raw);vids=[{'id':e.get('id'),'title':e.get('title')} for e in (cat.get('entries') or []) if e.get('id') and e.get('title')]
by_norm={}
for v in vids:by_norm.setdefault(norm(v['title']),[]).append(v)

episodes=[]
for season in SEASONS:
 r=S.get(f'{BASE}/series/{SLUG}/seasons/official/{season}',timeout=40)
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
  episodes.append({'code':f'S{season}E{int(cm.group(1)):02d}','episodeId':m.group(1),'title':title,'url':BASE+href if href.startswith('/') else href})

report={'generatedAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_MAXIME_ARTWORK_GAP_AUDIT','neverWrittenMissing':[],'detachedPreviouslyVerified':[],'currentlyPresent':[],'blocked':[]}
for ep in episodes:
 try:
  rr=S.get(ep['url'],timeout=30)
  arts=art_urls(rr.text) if rr.status_code==200 else []
  if arts:
   report['currentlyPresent'].append({**ep,'artworks':arts})
   continue
  matches=by_norm.get(norm(ep['title']),[])
  hist=written.get(ep['code'])
  if hist:
   old=hist.get('artwork')
   report['detachedPreviouslyVerified'].append({**ep,'history':hist,'oldArtworkProbe':fetch_img(old) if old else None})
   continue
  if len(matches)!=1:
   report['blocked'].append({**ep,'reason':'NO_UNIQUE_YOUTUBE_MATCH','matchCount':len(matches)})
   continue
  v=matches[0]; img=f"https://i.ytimg.com/vi/{v['id']}/maxresdefault.jpg"; probe=fetch_img(img)
  sm=re.search(r'artwork/upload\?type=11&episode='+re.escape(ep['episodeId'])+r'&series=(\d+)',rr.text) if rr.status_code==200 else None
  row={**ep,'youtubeId':v['id'],'youtubeTitle':v['title'],'imageUrl':img,'imageProbe':probe,'series':sm.group(1) if sm else None}
  if probe.get('status')==200 and probe.get('size')==[1280,720] and row['series']:
   report['neverWrittenMissing'].append(row)
  else:
   report['blocked'].append({**row,'reason':'IMAGE_OR_SCOPE_NOT_CLEAN'})
 except Exception as e:report['blocked'].append({**ep,'reason':'ERROR','error':str(e)})

report['summary']={
 'tvdbEpisodes':len(episodes),'youtubeVideos':len(vids),'writtenHistory':len(written),
 'currentlyPresent':len(report['currentlyPresent']),
 'neverWrittenMissing':len(report['neverWrittenMissing']),
 'detachedPreviouslyVerified':len(report['detachedPreviouslyVerified']),
 'detachedOldArtworkStillHTTP200':sum((x.get('oldArtworkProbe') or {}).get('status')==200 for x in report['detachedPreviouslyVerified']),
 'blocked':len(report['blocked'])
}
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'summary.txt').write_text('\n'.join(f'{k}={v}' for k,v in report['summary'].items())+'\n',encoding='utf-8')
print((OUT/'summary.txt').read_text())

# rerun after gap-fill-1 and S2025E18 recovery

# final rerun after 14/14 Maxime gap fill 2
