import json,re,unicodedata,subprocess,requests,sys
from bs4 import BeautifulSoup
from PIL import Image
from io import BytesIO
from pathlib import Path

OUT=Path('reports/djilsi-artwork-preflight-post40-2026-10-07')
OUT.mkdir(parents=True,exist_ok=True)
BASE='https://thetvdb.com'
SLUG='djilsi'
SEASONS=list(range(2018,2027))
YT='https://www.youtube.com/c/Djilsi/videos'

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'@[\w.-]+',' ',s)
    s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()

def art_urls(html):
    return sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',html)))

report={
    'generatedAt':None,
    'mode':'READ_ONLY_DJILSI_MISSING_ARTWORK_PREFLIGHT_POST40',
    'tvdb':[],
    'youtube':[],
    'planned':[],
    'checked':[],
    'counters':{
        'noExactTitle':0,'multipleExactTitle':0,'artworkPresent':0,
        'imageUnavailable':0,'imageWrongSize':0,'uploadFormScopeDrift':0,'passed':0
    },
    'blocked':[],
    'result':'NOT_STARTED'
}

try:
    raw=subprocess.check_output(['yt-dlp','--flat-playlist','--dump-single-json','--no-warnings','--extractor-args','youtube:lang=fr',YT],text=True)
    cat=json.loads(raw)
    vids=[{'id':e.get('id'),'title':e.get('title')} for e in (cat.get('entries') or []) if e.get('id') and e.get('title')]
    report['youtube']=vids
except Exception as e:
    report['blocked'].append({'reason':'YTDLP_FAILED','error':str(e)})
    vids=[]

S=requests.Session()
S.headers.update({'User-Agent':'Mozilla/5.0'})
episodes=[]
for season in SEASONS:
    try:
        r=S.get(f'{BASE}/series/{SLUG}/seasons/official/{season}',timeout=40)
        if r.status_code!=200:
            report['blocked'].append({'season':season,'reason':'TVDB_SEASON_HTTP','status':r.status_code})
            continue
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
            ep={
                'season':season,'episode':int(cm.group(1)),
                'code':f'S{season}E{int(cm.group(1)):02d}',
                'episodeId':m.group(1),'title':title,
                'url':BASE+href if href.startswith('/') else href
            }
            if not any(x['episodeId']==ep['episodeId'] for x in episodes):
                episodes.append(ep)
    except Exception as e:
        report['blocked'].append({'season':season,'reason':'TVDB_SEASON_ERROR','error':str(e)})
report['tvdb']=episodes

by_norm={}
for v in vids:
    by_norm.setdefault(norm(v['title']),[]).append(v)

seen=set()
done=set()
for rp in Path('reports').glob('djilsi-artwork*/report.json'):
    try:
        hist=json.loads(rp.read_text(encoding='utf-8'))
        for row in hist.get('results',[]) or []:
            if row.get('status') in ('APPLIED_AND_VERIFIED','ALREADY_PRESENT_SKIP') and row.get('code'):
                done.add(row['code'])
    except Exception:
        pass
report['historicalDone']=len(done)

for ep in sorted(episodes,key=lambda x:(x['season'],x['episode'])):
    if ep['code'] in done:
        report['checked'].append({**ep,'status':'HISTORY_ALREADY_VERIFIED'})
        continue
    if len(report['planned'])>=20: break
    matches=by_norm.get(norm(ep['title']),[])
    if len(matches)==0:
        report['counters']['noExactTitle']+=1
        report['checked'].append({**ep,'status':'NO_EXACT_TITLE'})
        continue
    if len(matches)>1:
        report['counters']['multipleExactTitle']+=1
        report['checked'].append({**ep,'status':'MULTIPLE_EXACT_TITLE','matchCount':len(matches)})
        continue
    v=matches[0]
    try:
        d=S.get(ep['url'],timeout=30)
        if d.status_code!=200:
            report['blocked'].append({'code':ep['code'],'reason':'EPISODE_HTTP','status':d.status_code})
            continue
        arts=art_urls(d.text)
        sm=re.search(r'artwork/upload\?type=11&episode='+re.escape(ep['episodeId'])+r'&series=(\d+)',d.text)
        derived_series=sm.group(1) if sm else None
        if arts:
            report['counters']['artworkPresent']+=1
            report['checked'].append({**ep,'youtubeId':v['id'],'status':'ARTWORK_PRESENT','artwork':arts[:3]})
            continue
        img=f"https://i.ytimg.com/vi/{v['id']}/maxresdefault.jpg"
        rr=S.get(img,timeout=30)
        if rr.status_code!=200 or len(rr.content)<10000:
            report['counters']['imageUnavailable']+=1
            report['checked'].append({**ep,'youtubeId':v['id'],'status':'IMAGE_UNAVAILABLE','imageStatus':rr.status_code,'bytes':len(rr.content)})
            continue
        im=Image.open(BytesIO(rr.content))
        if im.size!=(1280,720):
            report['counters']['imageWrongSize']+=1
            report['checked'].append({**ep,'youtubeId':v['id'],'status':'IMAGE_WRONG_SIZE','size':list(im.size)})
            continue
        if not derived_series:
            report['counters']['uploadFormScopeDrift']+=1
            report['checked'].append({**ep,'youtubeId':v['id'],'status':'NO_SERIES_ID_ON_EPISODE_PAGE'})
            continue
        row={**ep,'youtubeId':v['id'],'youtubeTitle':v['title'],'imageUrl':img,'width':1280,'height':720,'series':derived_series}
        if ep['code'] not in seen:
            seen.add(ep['code'])
            report['planned'].append(row)
            report['checked'].append({**row,'status':'PREFLIGHT_PASSED'})
            report['counters']['passed']+=1
    except Exception as e:
        report['blocked'].append({'code':ep['code'],'reason':'PREFLIGHT_ERROR','error':str(e)})

report['result']='PREFLIGHT_READY' if len(report['planned'])>=10 else 'PREFLIGHT_INSUFFICIENT_CANDIDATES'
Path(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
Path(OUT/'summary.txt').write_text(
    f"tvdb={len(episodes)}\nyoutube={len(vids)}\nplanned={len(report['planned'])}\n"
    f"artworkPresent={report['counters']['artworkPresent']}\n"
    f"imageUnavailable={report['counters']['imageUnavailable']}\n"
    f"result={report['result']}\n",encoding='utf-8')
print((OUT/'summary.txt').read_text())
if report['result']!='PREFLIGHT_READY': sys.exit(2)
