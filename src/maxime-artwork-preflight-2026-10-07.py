import json,re,unicodedata,subprocess,requests,sys
from bs4 import BeautifulSoup
from PIL import Image
from io import BytesIO
from pathlib import Path

OUT=Path('reports/maxime-artwork-preflight-2026-10-07')
OUT.mkdir(parents=True,exist_ok=True)
BASE='https://thetvdb.com'
SLUG='maxime-biaggi'
SERIES='432072'
SEASONS=[2019,2021,2022,2023,2024,2025,2026]
YT='https://www.youtube.com/c/MaximeBiaggi/videos'

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'@[\w.-]+',' ',s)
    s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()

def art_urls(html):
    return sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',html)))

report={'generatedAt':None,'mode':'READ_ONLY_MAXIME_MISSING_ARTWORK_PREFLIGHT','tvdb':[],'youtube':[],'planned':[],'blocked':[],'result':'NOT_STARTED'}
try:
    raw=subprocess.check_output(['yt-dlp','--flat-playlist','--dump-single-json','--no-warnings','--extractor-args','youtube:lang=fr',YT],text=True)
    cat=json.loads(raw)
    vids=[{'id':e.get('id'),'title':e.get('title')} for e in (cat.get('entries') or []) if e.get('id') and e.get('title')]
    report['youtube']=vids
except Exception as e:
    report['blocked'].append({'reason':'YTDLP_FAILED','error':str(e)})
    vids=[]

S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
episodes=[]
for season in SEASONS:
    try:
        r=S.get(f'{BASE}/series/{SLUG}/seasons/official/{season}',timeout=40)
        if r.status_code!=200:
            report['blocked'].append({'season':season,'reason':'TVDB_SEASON_HTTP','status':r.status_code});continue
        soup=BeautifulSoup(r.text,'html.parser')
        for a in soup.select('a[href*="/episodes/"]'):
            href=a.get('href') or ''
            m=re.search(r'/episodes/(\d+)',href)
            title=' '.join(a.get_text(' ',strip=True).split())
            if not m or not title: continue
            tr=a.find_parent('tr')
            text=' '.join(tr.get_text(' ',strip=True).split()) if tr else ''
            cm=re.search(rf'S{season}E(\d+)',text,re.I)
            if not cm: continue
            ep={'season':season,'episode':int(cm.group(1)),'code':f'S{season}E{int(cm.group(1)):02d}','episodeId':m.group(1),'title':title,'url':BASE+href if href.startswith('/') else href}
            episodes.append(ep)
    except Exception as e:
        report['blocked'].append({'season':season,'reason':'TVDB_SEASON_ERROR','error':str(e)})
report['tvdb']=episodes

by_norm={}
for v in vids:
    by_norm.setdefault(norm(v['title']),[]).append(v)

seen=set()
for ep in episodes:
    if len(report['planned'])>=20: break
    key=norm(ep['title'])
    matches=by_norm.get(key,[])
    if len(matches)!=1: continue
    v=matches[0]
    try:
        d=S.get(ep['url'],timeout=30)
        if d.status_code!=200: continue
        if art_urls(d.text): continue
        img=f"https://i.ytimg.com/vi/{v['id']}/maxresdefault.jpg"
        rr=S.get(img,timeout=30)
        if rr.status_code!=200 or len(rr.content)<10000: continue
        im=Image.open(BytesIO(rr.content))
        if im.size!=(1280,720): continue
        up=S.get(f'{BASE}/artwork/upload?type=11&episode={ep["episodeId"]}&series={SERIES}',timeout=30)
        if up.status_code!=200: continue
        if f'name="episode" value="{ep["episodeId"]}"' not in up.text: continue
        if f'name="series" value="{SERIES}"' not in up.text: continue
        if 'name="type" value="11"' not in up.text: continue
        row={**ep,'youtubeId':v['id'],'youtubeTitle':v['title'],'imageUrl':img,'width':1280,'height':720,'series':SERIES}
        if ep['code'] not in seen:
            seen.add(ep['code']);report['planned'].append(row)
    except Exception as e:
        report['blocked'].append({'code':ep['code'],'reason':'PREFLIGHT_ERROR','error':str(e)})

report['result']='PREFLIGHT_READY' if len(report['planned'])>=10 else 'PREFLIGHT_INSUFFICIENT_CANDIDATES'
Path(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
Path(OUT/'summary.txt').write_text(f"tvdb={len(episodes)}\nyoutube={len(vids)}\nplanned={len(report['planned'])}\nresult={report['result']}\n",encoding='utf-8')
print((OUT/'summary.txt').read_text())
if report['result']!='PREFLIGHT_READY': sys.exit(2)
