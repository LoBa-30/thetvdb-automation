import json, re, csv, io, math, unicodedata, html as htmlmod, time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from bs4 import BeautifulSoup
from PIL import Image
import imagehash

SERIES='338282-show'
SERIES_ID='338282'
REF='2026-09-09'
YT_URL='https://www.youtube.com/c/LeFatShow/videos'
ROOT='reports/mcfly-final-v2'

HEADERS={
    'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
    'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'
}

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'@[\w.-]+',' ',s)
    s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()

def sim(a,b):
    A=norm(a); B=norm(b)
    seq=SequenceMatcher(None,A,B).ratio()
    sa=set(A.split()); sb=set(B.split())
    inter=len(sa&sb)
    jac=inter/(len(sa|sb) or 1)
    cont=inter/(min(len(sa) or 1,len(sb) or 1))
    return max(seq,0.55*jac+0.45*cont)

def canonical(s):
    return unicodedata.normalize('NFC',(s or '')).strip()

def strip_cosmetic(s):
    s=canonical(s)
    s=re.sub(r'[\u200b-\u200f\u2060\ufeff]','',s)
    s=re.sub(r'[\U0001F1E6-\U0001F1FF\U0001F300-\U0001FAFF\u2600-\u27BF]','',s)
    return re.sub(r'\s+',' ',s).strip()

def fmt_duration(sec):
    if sec is None: return ''
    sec=int(sec); h,r=divmod(sec,3600); m,s=divmod(r,60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'

def expected_minutes(sec):
    return int(math.floor(float(sec)/60.0 + 0.5)) if sec is not None else None

_http=requests.Session()
_http.headers.update(HEADERS)

def get(url, timeout=25, attempts=5):
    last=None
    for attempt in range(1,attempts+1):
        try:
            r=_http.get(url,timeout=timeout)
            if r.status_code in (429,500,502,503,504):
                last=RuntimeError(f'HTTP {r.status_code} for {url}')
                time.sleep(min(2*attempt,8))
                continue
            r.raise_for_status()
            return r
        except requests.RequestException as ex:
            last=ex
            if attempt<attempts:
                time.sleep(min(2*attempt,8))
    raise last

# ---------------- YouTube catalogue ----------------
cat=json.load(open(f'{ROOT}/catalogue.json',encoding='utf-8'))
yt=[]
for pos,e in enumerate(cat.get('entries') or []):
    if not e.get('id') or not e.get('title'): continue
    thumbs=[x.get('url') for x in (e.get('thumbnails') or []) if x.get('url')]
    yt.append({
        'position':pos,
        'id':e['id'],
        'title':e['title'],
        'duration_seconds':e.get('duration'),
        'duration':fmt_duration(e.get('duration')),
        'url':e.get('url') or f"https://www.youtube.com/watch?v={e['id']}",
        'thumbnail':thumbs[-1] if thumbs else f"https://i.ytimg.com/vi/{e['id']}/hqdefault.jpg"
    })
print('YouTube catalogue',len(yt))

# Exact publish dates via public YouTube player API.
home=get('https://www.youtube.com/?hl=fr&gl=FR').text
m=re.search(r'"INNERTUBE_API_KEY":"([^"]+)"',home)
key=m.group(1) if m else None
mv=re.search(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"',home) or re.search(r'"clientVersion":"([^"]+)"',home)
client_version=mv.group(1) if mv else '2.20261001.00.00'
if not key:
    raise RuntimeError('YouTube INNERTUBE_API_KEY unavailable')
api='https://www.youtube.com/youtubei/v1/player?key='+key

def player_meta(v):
    row={'id':v['id']}
    try:
        s=requests.Session(); s.headers.update({**HEADERS,'Content-Type':'application/json'})
        payload={'context':{'client':{'clientName':'WEB','clientVersion':client_version,'hl':'fr','gl':'FR'}},
                 'videoId':v['id'],'contentCheckOk':True,'racyCheckOk':True}
        rr=s.post(api,json=payload,timeout=15)
        row['status']=rr.status_code
        d=rr.json()
        micro=((d.get('microformat') or {}).get('playerMicroformatRenderer') or {})
        vd=d.get('videoDetails') or {}
        row.update({
            'publish_date':micro.get('publishDate'),
            'upload_date':micro.get('uploadDate'),
            'api_title':vd.get('title'),
            'api_duration_seconds':int(vd['lengthSeconds']) if str(vd.get('lengthSeconds','')).isdigit() else None,
            'playability':(d.get('playabilityStatus') or {}).get('status')
        })
    except Exception as ex:
        row['error']=str(ex)
    return row

by_yt={v['id']:v for v in yt}
with ThreadPoolExecutor(max_workers=24) as ex:
    futs=[ex.submit(player_meta,v) for v in yt]
    for i,f in enumerate(as_completed(futs),1):
        row=f.result(); by_yt[row['id']].update(row)
        if i%60==0: print('YouTube player metadata',i,'/',len(yt))
date_count=sum(1 for v in yt if v.get('publish_date'))
print('YouTube exact publish dates',date_count,'/',len(yt))

# ---------------- TheTVDB seasons ----------------
tv=[]
for year in range(2012,2027):
    url=f'https://www.thetvdb.com/series/{SERIES}/seasons/official/{year}'
    r=get(url,30); soup=BeautifulSoup(r.text,'html.parser'); seen=set()
    for a in soup.select(f'a[href*="/series/{SERIES}/episodes/"]'):
        href=a.get('href') or ''
        mm=re.search(r'/episodes/(\d+)',href)
        if not mm: continue
        eid=mm.group(1)
        if eid in seen: continue
        seen.add(eid)
        row=a.find_parent('tr') or a.find_parent(class_=re.compile('list-group-item|row'))
        text='\n'.join(x.strip() for x in (row.stripped_strings if row else a.parent.stripped_strings))
        mc=re.search(rf'S{year}E(\d+)',text)
        if not mc: continue
        ep=int(mc.group(1)); lines=[x.strip() for x in text.split('\n') if x.strip()]
        code=f'S{year}E{ep:02d}'
        try: ci=next(i for i,x in enumerate(lines) if re.fullmatch(rf'S{year}E0*{ep}',x))
        except StopIteration: ci=0
        j=ci+1; title_parts=[]; flag=None; date=None
        date_re=re.compile(r'^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$')
        while j<len(lines) and not date_re.match(lines[j]) and not re.fullmatch(r'(?:season (?:premiere|finale)|mid-season finale)',lines[j],re.I):
            title_parts.append(lines[j]); j+=1
        if j<len(lines) and re.fullmatch(r'(?:season (?:premiere|finale)|mid-season finale)',lines[j],re.I):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]): runtime=int(lines[j])
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,'flag':flag,
            'episode_url':f'https://www.thetvdb.com/series/{SERIES}/episodes/{eid}'
        })
    print('TVDB',year,len(seen))
print('TVDB total',len(tv))

# Episode detail pages: artwork URL + authoritative flags/date/runtime visible on current page.
art_re=re.compile(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+/episode/\d+/screencap/[^"\'<>\s]+|https://artworks\.thetvdb\.com/banners/v4/episode/\d+/screencap/[^"\'<>\s]+')

def episode_detail(e):
    out={'episode_id':e['episode_id'],'artwork':None}
    try:
        rr=get(e['episode_url'],20); txt=rr.text
        urls=art_re.findall(txt)
        # Fallback more permissive pattern.
        if not urls:
            urls=re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]*episode[^"\'<>\s]*/screencap/[^"\'<>\s]+',txt)
        urls=[htmlmod.unescape(u) for u in urls]
        out['artwork']=urls[0] if urls else None
        out['detail_status']=rr.status_code
    except Exception as ex:
        out['detail_error']=str(ex)
    return out

by_ep={e['episode_id']:e for e in tv}
with ThreadPoolExecutor(max_workers=24) as ex:
    futs=[ex.submit(episode_detail,e) for e in tv]
    for i,f in enumerate(as_completed(futs),1):
        d=f.result(); by_ep[d['episode_id']].update(d)
        if i%60==0: print('TVDB episode details',i,'/',len(tv))
print('TVDB artworks present',sum(1 for e in tv if e.get('artwork')),'/',len(tv))

# ---------------- Chronological alignment ----------------
# YouTube is already newest -> oldest. TVDB sort newest -> oldest.
tv_sorted=sorted(tv,key=lambda e:(e.get('date') or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv_sorted); NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        y,e=yt[i-1],tv_sorted[j-1]
        s=sim(y['title'],e['title'])
        date_bonus=0
        if y.get('publish_date') and e.get('date'):
            if y['publish_date']==e['date']: date_bonus=0.8
            elif y['publish_date'][:4]==str(e['season']): date_bonus=0.1
            else: date_bonus=-1.0
        opts=[(score[i-1][j-1]+(2.2*s-0.65)+date_bonus,'match'),
              (score[i][j-1]-0.35,'skip_tv'),
              (score[i-1][j]-2.0,'skip_yt')]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]; i=n; j=m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv_sorted[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

rows=[]
for yi,ti,s in pairs:
    y,e=yt[yi],tv_sorted[ti]
    exact=canonical(y['title'])==canonical(e['title'])
    if exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    pub=y.get('publish_date')
    scope='IN_SCOPE' if pub and pub<=REF else ('AFTER_REFERENCE' if pub and pub>REF else ('IN_SCOPE' if (e.get('date') or '')<=REF else 'AFTER_REFERENCE'))
    dursec=y.get('api_duration_seconds') or y.get('duration_seconds')
    expmin=expected_minutes(dursec)
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':scope,'tvdb_date':e.get('date'),'youtube_date':pub,
        'date_exact':(pub==e.get('date')) if pub and e.get('date') else None,
        'tvdb_title':e['title'],'youtube_title':y['title'],'youtube_api_title':y.get('api_title'),
        'title_exact':exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration_seconds':dursec,'youtube_duration':fmt_duration(dursec),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expmin,
        'runtime_exact':(expmin==e.get('runtime_minutes')) if expmin is not None and e.get('runtime_minutes') is not None else None,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail')
    })

# ---------------- Artwork provenance ----------------
# Hash one official thumbnail per current public video, with robust YouTube URLs.
def yt_hash(v):
    candidates=[
        f"https://i.ytimg.com/vi/{v['id']}/maxresdefault.jpg",
        v.get('thumbnail'),
        f"https://i.ytimg.com/vi/{v['id']}/hqdefault.jpg"
    ]
    for u in dict.fromkeys(x for x in candidates if x):
        try:
            rr=get(u,15)
            if len(rr.content)<1000: continue
            im=Image.open(io.BytesIO(rr.content)).convert('RGB')
            return {'id':v['id'],'hash':str(imagehash.phash(im)),'thumbnail_url_used':u}
        except Exception:
            pass
    return {'id':v['id'],'hash':None,'thumbnail_url_used':None}

thumb_hash={}
with ThreadPoolExecutor(max_workers=24) as ex:
    futs=[ex.submit(yt_hash,v) for v in yt]
    for i,f in enumerate(as_completed(futs),1):
        d=f.result(); thumb_hash[d['id']]=d
        if i%60==0: print('YouTube thumbnail hashes',i,'/',len(yt))

def art_hash(r):
    if not r.get('tvdb_artwork'): return {'episode_id':r['episode_id'],'hash':None}
    try:
        rr=get(r['tvdb_artwork'],20)
        if len(rr.content)<1000: return {'episode_id':r['episode_id'],'hash':None,'error':'too small'}
        im=Image.open(io.BytesIO(rr.content)).convert('RGB')
        return {'episode_id':r['episode_id'],'hash':str(imagehash.phash(im))}
    except Exception as ex:
        return {'episode_id':r['episode_id'],'hash':None,'error':str(ex)}

art_hashes={}
with ThreadPoolExecutor(max_workers=24) as ex:
    futs=[ex.submit(art_hash,r) for r in rows]
    for i,f in enumerate(as_completed(futs),1):
        d=f.result(); art_hashes[d['episode_id']]=d
        if i%60==0: print('TVDB artwork hashes',i,'/',len(rows))

thumb_objs={vid:imagehash.hex_to_hash(d['hash']) for vid,d in thumb_hash.items() if d.get('hash')}
for r in rows:
    if not r.get('tvdb_artwork'):
        r['image_status']='MISSING_IMAGE'
        continue
    ah=art_hashes.get(r['episode_id'],{}).get('hash')
    if not ah:
        r['image_status']='PRESENT_COMPARE_ERROR'; continue
    ph=imagehash.hex_to_hash(ah)
    own=thumb_objs.get(r['youtube_id'])
    own_dist=int(ph-own) if own is not None else None
    near=[]
    for vid,h in thumb_objs.items():
        d=int(ph-h)
        if d<=4: near.append((d,vid))
    near.sort()
    r['own_thumbnail_phash_distance']=own_dist
    r['near_thumbnail_matches']=[{'distance':d,'youtube_id':vid} for d,vid in near[:10]]
    own_near=any(vid==r['youtube_id'] for d,vid in near)
    other_near=[(d,vid) for d,vid in near if vid!=r['youtube_id']]
    if own_near:
        r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
    elif other_near:
        r['image_status']='WRONG_MATCHES_OTHER_VIDEO_THUMBNAIL'
        r['wrong_match_youtube_id']=other_near[0][1]
        r['wrong_match_distance']=other_near[0][0]
    else:
        r['image_status']='PRESENT_ORIGIN_UNPROVEN_SCREENSHOT_OR_CUSTOM'

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched=[]
for ti in skipped_tv:
    e=tv_sorted[ti].copy()
    e['reference_scope']='IN_SCOPE' if (e.get('date') or '')<=REF else 'AFTER_REFERENCE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)
youtube_extras=[yt[i] for i in skipped_yt if (yt[i].get('publish_date') or '')<=REF]

# Season summaries.
seasons=[]
for year in range(2012,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    sr=[r for r in in_scope if r['season']==year]
    seasons.append({
        'year':year,
        'tvdb_episodes_current':len(eps),
        'youtube_aligned_in_scope':len(sr),
        'historical_tvdb_only_in_scope':sum(1 for e in unmatched if e['season']==year and e['reference_scope']=='IN_SCOPE'),
        'missing_numbers':[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums],
        'duplicate_numbers':[x for x,c in Counter(nums).items() if c>1],
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'title_mismatches':sum(1 for r in sr if not r['title_exact']),
        'date_mismatches':sum(1 for r in sr if r['date_exact'] is False),
        'runtime_mismatches':sum(1 for r in sr if r['runtime_exact'] is False),
        'images_missing':sum(1 for r in sr if r['image_status']=='MISSING_IMAGE'),
        'images_confirmed_thumbnail':sum(1 for r in sr if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
        'images_wrong_other_thumbnail':sum(1 for r in sr if r['image_status']=='WRONG_MATCHES_OTHER_VIDEO_THUMBNAIL'),
        'images_origin_unproven':sum(1 for r in sr if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN_SCREENSHOT_OR_CUSTOM','PRESENT_COMPARE_ERROR'))
    })

summary={
    'generated_at':datetime.now(timezone.utc).isoformat(),
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'youtube_exact_dates_retrieved':date_count,
    'youtube_public_videos_in_scope':sum(1 for v in yt if v.get('publish_date') and v['publish_date']<=REF),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_in_scope':len(youtube_extras),
    'tvdb_without_current_public_youtube_in_scope':sum(1 for e in unmatched if e['reference_scope']=='IN_SCOPE'),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_wrong_other_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='WRONG_MATCHES_OTHER_VIDEO_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN_SCREENSHOT_OR_CUSTOM','PRESENT_COMPARE_ERROR')),
}
report={'summary':summary,'seasons':seasons,'rows':rows,
        'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open(f'{ROOT}/audit-v2.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

fields=['code','reference_scope','tvdb_date','youtube_date','tvdb_title','youtube_title','title_exact','title_status',
        'youtube_id','youtube_duration','youtube_duration_seconds','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact',
        'season_flag','image_status','tvdb_artwork','own_thumbnail_phash_distance','wrong_match_youtube_id','youtube_url']
with open(f'{ROOT}/audit-v2.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

lines=['# Audit Mcfly & Carlito V2 — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','',
       '## Bilan global','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Saisons','',
'| Saison | YT alignés | TVDB | Historiques TVDB seuls | Titres ≠ | Dates ≠ | Runtimes ≠ | Images absentes | Images miniature confirmée | Images autre vidéo | Images origine non prouvée | Finale |',
'|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['youtube_aligned_in_scope']} | {s['tvdb_episodes_current']} | {s['historical_tvdb_only_in_scope']} | {s['title_mismatches']} | {s['date_mismatches']} | {s['runtime_mismatches']} | {s['images_missing']} | {s['images_confirmed_thumbnail']} | {s['images_wrong_other_thumbnail']} | {s['images_origin_unproven']} | {', '.join(s['season_finales']) or '—'} |")
lines += ['','## Titres exacts à corriger','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['youtube_date']}** : « {r['tvdb_title']} » → « {r['youtube_title']} » ({r['title_status']})")
lines += ['','## Dates à corriger','']
for r in in_scope:
    if r['date_exact'] is False:
        lines.append(f"- **{r['code']} — {r['youtube_title']}** : TheTVDB {r['tvdb_date']} → YouTube {r['youtube_date']}")
lines += ['','## Runtimes à corriger','']
for r in in_scope:
    if r['runtime_exact'] is False:
        lines.append(f"- **{r['code']} — {r['youtube_title']}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; attendu {r['expected_runtime_minutes']} min")
lines += ['','## Images manifestement attribuées à une autre vidéo','']
wrong=[r for r in in_scope if r['image_status']=='WRONG_MATCHES_OTHER_VIDEO_THUMBNAIL']
if wrong:
    for r in wrong:
        other=by_yt.get(r.get('wrong_match_youtube_id'),{})
        lines.append(f"- **{r['code']} — {r['youtube_title']}** : artwork actuel correspond à la miniature de « {other.get('title','?')} » ({r.get('wrong_match_youtube_id')}).")
else:
    lines.append('- Aucune image actuelle n’a été prouvée comme miniature exacte d’une autre vidéo.')
lines += ['','## Entrées TVDB sans vidéo publique actuelle','']
for e in unmatched:
    if e['reference_scope']=='IN_SCOPE':
        lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — à rechercher historiquement avant toute suppression.")
open(f'{ROOT}/audit-v2.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open(f'{ROOT}/summary-v2.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
