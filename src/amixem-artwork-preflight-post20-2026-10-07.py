import json,re,requests,unicodedata,sys
from pathlib import Path
from io import BytesIO
from PIL import Image
from datetime import datetime, timezone

OUT=Path('reports/amixem-artwork-preflight-post20-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
BASE='https://thetvdb.com';SLUG='328213-show';SERIES='328213'
audit=json.loads(Path('reports/amixem-final/audit.json').read_text(encoding='utf-8'))

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'@[\w.-]+',' ',s);s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()

rows=[]
for r in audit.get('rows',[]):
    if not r.get('episode_id') or not r.get('youtube_id') or r.get('tvdb_artwork'): continue
    if not r.get('tvdb_title') or not r.get('youtube_title'): continue
    rows.append({'code':r.get('code'),'episodeId':str(r.get('episode_id')),'title':r.get('tvdb_title'),'youtubeId':r.get('youtube_id'),'youtubeTitle':r.get('youtube_title'),'url':f"{BASE}/series/{SLUG}/episodes/{r.get('episode_id')}",'imageUrl':f"https://i.ytimg.com/vi/{r.get('youtube_id')}/maxresdefault.jpg",'series':SERIES})
rows.sort(key=lambda x:[int(n) if n.isdigit() else n for n in re.split(r'(\d+)',x['code'] or '')])

S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_AMIXEM_ARTWORK_PREFLIGHT_POST20','sourceRows':len(rows),'checked':[],'planned':[],'counters':{'artworkPresent':0,'titleDrift':0,'imageUnavailable':0,'imageWrongSize':0,'uploadFormScopeDrift':0,'passed':0},'blocked':[],'result':'NOT_STARTED'}
done=set()
for rp in Path('reports').glob('amixem-artwork*/report.json'):
    try:
        hist=json.loads(rp.read_text(encoding='utf-8'))
        for row in hist.get('results',[]) or []:
            if row.get('status') in ('APPLIED_AND_VERIFIED','ALREADY_PRESENT_SKIP') and row.get('code'):
                done.add(row['code'])
    except Exception:
        pass
report['historicalDone']=len(done)

for p in rows:
    if p['code'] in done:
        report['checked'].append({**p,'status':'HISTORY_ALREADY_VERIFIED'})
        continue
    if len(report['planned'])>=20: break
    try:
        r=S.get(p['url'],timeout=20)
        if r.status_code!=200:
            report['checked'].append({**p,'status':'TVDB_HTTP','http':r.status_code});continue
        h=re.search(r'<h[12][^>]*>(.*?)</h[12]>',r.text,re.I|re.S)
        heading=re.sub('<[^<]+?>',' ',h.group(1)) if h else ''
        heading=' '.join(heading.split())
        if norm(heading)!=norm(p['title']):
            report['counters']['titleDrift']+=1;report['checked'].append({**p,'status':'TITLE_DRIFT','heading':heading});continue
        arts=sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',r.text)))
        if arts:
            report['counters']['artworkPresent']+=1;report['checked'].append({**p,'status':'ARTWORK_PRESENT','artwork':arts[:2]});continue
        sm=re.search(r'artwork/upload\?type=11&episode='+re.escape(p['episodeId'])+r'&series=(\d+)',r.text)
        if not sm or sm.group(1)!=SERIES:
            report['counters']['uploadFormScopeDrift']+=1;report['checked'].append({**p,'status':'UPLOAD_FORM_SCOPE_DRIFT','series':sm.group(1) if sm else None});continue
        rr=S.get(p['imageUrl'],timeout=20)
        if rr.status_code!=200 or len(rr.content)<10000:
            report['counters']['imageUnavailable']+=1;report['checked'].append({**p,'status':'IMAGE_UNAVAILABLE','http':rr.status_code,'bytes':len(rr.content)});continue
        im=Image.open(BytesIO(rr.content))
        if im.size!=(1280,720):
            report['counters']['imageWrongSize']+=1;report['checked'].append({**p,'status':'IMAGE_WRONG_SIZE','size':list(im.size)});continue
        row={**p,'width':1280,'height':720}
        report['planned'].append(row);report['checked'].append({**row,'status':'PREFLIGHT_PASSED'});report['counters']['passed']+=1
    except Exception as e:
        report['blocked'].append({'code':p.get('code'),'reason':str(e)})

report['result']='PREFLIGHT_READY' if len(report['planned'])>=10 else 'PREFLIGHT_INSUFFICIENT_CANDIDATES'
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'summary.txt').write_text(f"sourceRows={report['sourceRows']}\nchecked={len(report['checked'])}\nplanned={len(report['planned'])}\nresult={report['result']}\n",encoding='utf-8')
print((OUT/'summary.txt').read_text())
if report['result']!='PREFLIGHT_READY':sys.exit(2)
