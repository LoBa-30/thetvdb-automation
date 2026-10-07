import json,re,requests,unicodedata,sys
from pathlib import Path
from io import BytesIO
from PIL import Image
from datetime import datetime, timezone

OUT=Path('reports/squeezie-artwork-preflight-post120-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
BASE='https://thetvdb.com'
audit=json.loads(Path('reports/squeezie-final/FINAL_METADATA_AUDIT.json').read_text(encoding='utf-8'))
presence=json.loads(Path('reports/squeezie-artwork/artwork-presence.json').read_text(encoding='utf-8'))
missing={x['code']:x for x in presence.get('episodes',[]) if x.get('hasImage') is False}

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'@[\w.-]+',' ',s);s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()

pairs=[];seen=set()
for season in audit.get('bySeason',{}).values():
    for row in season.get('dateDiffRows',[]):
        if row.get('kind')!='exact-title': continue
        yt=row.get('youtube') or {};tv=row.get('tvdb') or {}
        code=tv.get('code');link=tv.get('link');title=tv.get('title')
        if not code or code not in missing or not yt.get('id') or not link or not title: continue
        m=re.search(r'/episodes/(\d+)',link)
        if not m or code in seen: continue
        seen.add(code)
        pairs.append({'code':code,'episodeId':m.group(1),'title':title,'youtubeId':yt['id'],'youtubeTitle':yt.get('title'),'url':link,'imageUrl':f"https://i.ytimg.com/vi/{yt['id']}/maxresdefault.jpg"})
pairs.sort(key=lambda x:[int(n) if n.isdigit() else n for n in re.split(r'(\d+)',x['code'])])

S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_SQUEEZIE_ARTWORK_PREFLIGHT_POST120','sourcePairs':len(pairs),'checked':[],'planned':[],'counters':{'artworkPresent':0,'titleDrift':0,'imageUnavailable':0,'imageWrongSize':0,'noSeriesId':0,'passed':0,'httpBlocked':0},'blocked':[],'result':'NOT_STARTED'}
done=set()
for rp in Path('reports').glob('squeezie-artwork*/report.json'):
    try:
        hist=json.loads(rp.read_text(encoding='utf-8'))
        for row in hist.get('results',[]) or []:
            if row.get('status') in ('APPLIED_AND_VERIFIED','ALREADY_PRESENT_SKIP') and row.get('code'):
                done.add(row['code'])
    except Exception:
        pass
report['historicalDone']=len(done)

for p in pairs:
    if p['code'] in done:
        report['checked'].append({**p,'status':'HISTORY_ALREADY_VERIFIED'})
        continue
    if len(report['planned'])>=20: break
    try:
        r=S.get(p['url'],timeout=20)
        if r.status_code!=200:
            report['counters']['httpBlocked']+=1;report['checked'].append({**p,'status':'TVDB_HTTP','http':r.status_code});continue
        h=re.search(r'<h[12][^>]*>(.*?)</h[12]>',r.text,re.I|re.S)
        heading=re.sub('<[^<]+?>',' ',h.group(1)) if h else ''
        heading=' '.join(heading.split())
        if norm(heading)!=norm(p['title']):
            report['counters']['titleDrift']+=1;report['checked'].append({**p,'status':'TITLE_DRIFT','heading':heading});continue
        arts=sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',r.text)))
        if arts:
            report['counters']['artworkPresent']+=1;report['checked'].append({**p,'status':'ARTWORK_PRESENT','artwork':arts[:2]});continue
        sm=re.search(r'artwork/upload\?type=11&episode='+re.escape(p['episodeId'])+r'&series=(\d+)',r.text)
        if not sm:
            report['counters']['noSeriesId']+=1;report['checked'].append({**p,'status':'NO_SERIES_ID'});continue
        rr=S.get(p['imageUrl'],timeout=20)
        if rr.status_code!=200 or len(rr.content)<10000:
            report['counters']['imageUnavailable']+=1;report['checked'].append({**p,'status':'IMAGE_UNAVAILABLE','http':rr.status_code,'bytes':len(rr.content)});continue
        im=Image.open(BytesIO(rr.content))
        if im.size!=(1280,720):
            report['counters']['imageWrongSize']+=1;report['checked'].append({**p,'status':'IMAGE_WRONG_SIZE','size':list(im.size)});continue
        row={**p,'series':sm.group(1),'width':1280,'height':720}
        report['planned'].append(row);report['checked'].append({**row,'status':'PREFLIGHT_PASSED'});report['counters']['passed']+=1
    except Exception as e:
        report['blocked'].append({'code':p['code'],'reason':str(e)})

report['result']='PREFLIGHT_READY' if len(report['planned'])>=10 else 'PREFLIGHT_INSUFFICIENT_CANDIDATES'
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'summary.txt').write_text(f"sourcePairs={report['sourcePairs']}\nchecked={len(report['checked'])}\nalreadyPresent={report['counters']['artworkPresent']}\nplanned={len(report['planned'])}\nresult={report['result']}\n",encoding='utf-8')
print((OUT/'summary.txt').read_text())
if report['result']!='PREFLIGHT_READY': sys.exit(2)
