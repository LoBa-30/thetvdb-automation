import json, re, csv, io, os, time, math, unicodedata, html as htmlmod
from datetime import datetime
from difflib import SequenceMatcher
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from bs4 import BeautifulSoup
from PIL import Image
import imagehash

SERIES='338282-show'
REF='2026-09-09'
YT_URL='https://www.youtube.com/@LeFatShow/videos'
S=requests.Session()
S.headers.update({
    'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
    'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'
})

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'@[\w.-]+',' ',s)
    s=re.sub(r'[^a-z0-9]+',' ',s)
    s=re.sub(r'\b(ft|feat|avec|youtube|officiel|official|le|la|les|un|une|des|de|du|et)\b',' ',s)
    return re.sub(r'\s+',' ',s).strip()

def sim(a,b):
    A=norm(a); B=norm(b)
    seq=SequenceMatcher(None,A,B).ratio()
    sa=set(A.split()); sb=set(B.split())
    inter=len(sa & sb)
    jac=inter/(len(sa|sb) or 1)
    cont=inter/(min(len(sa) or 1,len(sb) or 1))
    return max(seq,0.55*jac+0.45*cont)

def fmt_duration(sec):
    if sec is None: return ''
    sec=int(round(sec)); h,r=divmod(sec,3600); m,s=divmod(r,60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'

def expected_minutes(sec):
    return int(math.floor(sec/60.0 + 0.5)) if sec is not None else None

def canonical(s):
    return unicodedata.normalize('NFC',(s or '')).strip()

def strip_cosmetic(s):
    s=canonical(s)
    s=re.sub(r'[\u200b-\u200f\u2060\ufeff]','',s)
    s=re.sub(r'[\U0001F1E6-\U0001F1FF\U0001F300-\U0001FAFF\u2600-\u27BF]','',s)
    s=re.sub(r'\s+',' ',s).strip()
    return s

# YouTube flat catalogue: exact public Videos tab titles + durations.
cat=json.load(open('reports/mcfly-final/catalogue.json',encoding='utf-8'))
yt=[]
for e in cat.get('entries') or []:
    if not e.get('id') or not e.get('title'): continue
    yt.append({
        'id':e['id'],'title':e['title'],'duration_seconds':e.get('duration'),
        'duration':fmt_duration(e.get('duration')),
        'url':e.get('url') or f"https://www.youtube.com/watch?v={e['id']}",
        'thumbnail': next((x.get('url') for x in reversed(e.get('thumbnails') or []) if x.get('url')), None)
    })

# Independently retrieve exact publish date from public watch HTML, in parallel.
def fetch_watch(v):
    out={'id':v['id'],'youtube_date':None}
    try:
        s=requests.Session()
        s.headers.update({
            'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
            'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'
        })
        r=s.get(f"https://www.youtube.com/watch?v={v['id']}&hl=fr&gl=FR",timeout=8)
        txt=r.text
        dates=[]
        for pat in [
            r'"publishDate":"(\d{4}-\d{2}-\d{2})"',
            r'"uploadDate":"(\d{4}-\d{2}-\d{2})"',
            r'itemprop="datePublished" content="(\d{4}-\d{2}-\d{2})"'
        ]:
            m=re.search(pat,txt)
            if m: dates.append(m.group(1))
        out['youtube_date']=dates[0] if dates else None
        mt=re.search(r'<meta property="og:title" content="([^"]+)"',txt)
        if mt: out['watch_og_title']=htmlmod.unescape(mt.group(1))
    except Exception as ex:
        out['date_error']=str(ex)
    return out

by_id={v['id']:v for v in yt}
with ThreadPoolExecutor(max_workers=24) as ex:
    futures=[ex.submit(fetch_watch,v) for v in yt]
    for idx,fut in enumerate(as_completed(futures),1):
        out=fut.result()
        by_id[out['id']].update(out)
        if idx%50==0: print('YouTube watch pages',idx,'/',len(yt))

# Current TheTVDB aired-order catalogue.
tv=[]
for year in range(2012,2027):
    url=f'https://thetvdb.com/series/{SERIES}/seasons/official/{year}'
    r=S.get(url,timeout=30); r.raise_for_status()
    soup=BeautifulSoup(r.text,'html.parser')
    seen=set()
    # Locate episode links; derive row data from closest table row.
    for a in soup.select(f'a[href*="/series/{SERIES}/episodes/"]'):
        href=a.get('href') or ''
        mi=re.search(r'/episodes/(\d+)',href)
        if not mi: continue
        eid=mi.group(1)
        if eid in seen: continue
        seen.add(eid)
        row=a.find_parent('tr') or a.find_parent(class_=re.compile('list-group-item|row'))
        text='\n'.join(x.strip() for x in (row.stripped_strings if row else a.parent.stripped_strings))
        mc=re.search(rf'S{year}E(\d+)',text)
        if not mc: continue
        ep=int(mc.group(1))
        # Parse line-wise: code, title, optional season flag, date, source, runtime.
        lines=[x.strip() for x in text.split('\n') if x.strip()]
        code=f'S{year}E{ep:02d}'
        try: ci=next(i for i,x in enumerate(lines) if re.fullmatch(rf'S{year}E0*{ep}',x))
        except StopIteration: ci=0
        j=ci+1; title_parts=[]
        date=None; flag=None
        date_re=re.compile(r'^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$')
        while j<len(lines) and not date_re.match(lines[j]) and not re.match(r'^(?:season premiere|season finale|mid-season finale)
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            title_parts.append(lines[j]); j+=1
        if j<len(lines) and re.match(r'^(?:season premiere|season finale|mid-season finale):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            title_parts.append(lines[j]); j+=1
        if j<len(lines) and re.match(r'^(?:season premiere|season finale|mid-season finale)
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            title_parts.append(lines[j]); j+=1
        if j<len(lines) and re.match(r'^(?:season premiere|season finale|mid-season finale):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            title_parts.append(lines[j]); j+=1
        if j<len(lines) and re.match(r'^(?:season premiere|season finale|mid-season finale):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
,lines[j],re.I):
            flag=lines[j].lower(); j+=1
        if j<len(lines) and date_re.match(lines[j]):
            date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d'); j+=1
        if j<len(lines) and lines[j]=='YouTube': j+=1
        runtime=None
        if j<len(lines) and re.fullmatch(r'\d+',lines[j]):
            runtime=int(lines[j])
        img=None
        if row:
            for im in row.find_all('img'):
                val=im.get('src') or im.get('data-src') or im.get('data-lazy-src') or ''
                if 'artworks.thetvdb.com' in val and 'missing' not in val.lower():
                    img=val; break
        tv.append({
            'season':year,'episode':ep,'code':code,'episode_id':eid,
            'title':' '.join(title_parts).strip(),'date':date,'runtime_minutes':runtime,
            'flag':flag,'episode_url':('https://thetvdb.com'+href if href.startswith('/') else href),
            'artwork':img
        })
    print('TVDB',year,len(seen))

# Fallback artwork mapping from all-seasons page, where artwork URLs are exposed.
try:
    r=S.get(f'https://thetvdb.com/series/{SERIES}/allseasons/official',timeout=30); r.raise_for_status()
    for u in re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text):
        mm=re.search(rf'(?:episodes|episode)/\d+/(\d+)',u)
        if mm:
            eid=mm.group(1)
            for e in tv:
                if e['episode_id']==eid and not e['artwork']: e['artwork']=htmlmod.unescape(u)
except Exception:
    pass

# Sort newest -> oldest and align by chronology, permitting only TVDB historical gaps.
tv.sort(key=lambda e:(e['date'] or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tv)
NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)]
ptr=[[None]*(m+1) for _ in range(n+1)]
score[0][0]=0
for j in range(1,m+1): score[0][j]=score[0][j-1]-0.35; ptr[0][j]='skip_tv'
for i in range(1,n+1): score[i][0]=score[i-1][0]-2.0; ptr[i][0]='skip_yt'
for i in range(1,n+1):
    for j in range(1,m+1):
        s=sim(yt[i-1]['title'],tv[j-1]['title'])
        opts=[
            (score[i-1][j-1]+(2.2*s-0.65),'match'),
            (score[i][j-1]-0.35,'skip_tv'),
            (score[i-1][j]-2.0,'skip_yt')
        ]
        score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[]; skipped_tv=[]; skipped_yt=[]
i,j=n,m
while i or j:
    p=ptr[i][j]
    if p=='match':
        pairs.append((i-1,j-1,sim(yt[i-1]['title'],tv[j-1]['title']))); i-=1;j-=1
    elif p=='skip_tv': skipped_tv.append(j-1); j-=1
    elif p=='skip_yt': skipped_yt.append(i-1); i-=1
    else: break
pairs.reverse(); skipped_tv.reverse(); skipped_yt.reverse()

# Compare aligned rows.
rows=[]
for yi,ti,s in pairs:
    y=yt[yi]; e=tv[ti]
    title_exact=canonical(y['title'])==canonical(e['title'])
    expected=expected_minutes(y.get('duration_seconds'))
    date_verified=y.get('youtube_date') is not None
    date_exact=(y.get('youtube_date')==e.get('date')) if date_verified else None
    runtime_exact=(expected==e.get('runtime_minutes')) if expected is not None and e.get('runtime_minutes') is not None else None
    if title_exact: title_status='OK'
    elif strip_cosmetic(y['title'])==strip_cosmetic(e['title']): title_status='COSMETIC_EXACTNESS'
    elif norm(y['title'])==norm(e['title']): title_status='PUNCTUATION_EMOJI_EXACTNESS'
    else: title_status='SUBSTANTIVE_MISMATCH'
    rows.append({
        'code':e['code'],'season':e['season'],'episode':e['episode'],'episode_id':e['episode_id'],
        'reference_scope':'AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE',
        'tvdb_date':e.get('date'),'youtube_date':y.get('youtube_date'),'date_verified':date_verified,'date_exact':date_exact,
        'tvdb_title':e['title'],'youtube_title':y['title'],'title_exact':title_exact,'title_status':title_status,'title_similarity':round(s,3),
        'youtube_id':y['id'],'youtube_url':y['url'],
        'youtube_duration':y.get('duration'),'youtube_duration_seconds':y.get('duration_seconds'),
        'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':expected,'runtime_exact':runtime_exact,
        'season_flag':e.get('flag'),'tvdb_artwork':e.get('artwork'),'youtube_thumbnail':y.get('thumbnail'),
        'image_status':'MISSING_IMAGE' if not e.get('artwork') else 'PRESENT_ORIGIN_PENDING'
    })

# Compare existing TVDB artwork to official thumbnail (exact thumbnail provenance only).
for k,r in enumerate(rows):
    if not r.get('tvdb_artwork'): continue
    try:
        rb=S.get(r['tvdb_artwork'],timeout=25)
        if rb.status_code!=200 or len(rb.content)<1000: raise Exception('TVDB artwork fetch failed')
        tvim=Image.open(io.BytesIO(rb.content)).convert('RGB')
        ph=imagehash.phash(tvim)
        candidates=[]
        if r.get('youtube_thumbnail'): candidates.append(r['youtube_thumbnail'])
        candidates += [
            f"https://i.ytimg.com/vi/{r['youtube_id']}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{r['youtube_id']}/hqdefault.jpg"
        ]
        best=None
        for u in dict.fromkeys(candidates):
            try:
                rr=S.get(u,timeout=20)
                if rr.status_code!=200 or len(rr.content)<1000: continue
                im=Image.open(io.BytesIO(rr.content)).convert('RGB')
                d=ph-imagehash.phash(im)
                if best is None or d<best[0]: best=(d,u)
            except Exception: pass
        if best and best[0]<=4:
            r['image_status']='CONFIRMED_OFFICIAL_THUMBNAIL'
            r['thumbnail_phash_distance']=int(best[0])
        else:
            r['image_status']='PRESENT_ORIGIN_UNPROVEN'
            r['thumbnail_phash_distance']=int(best[0]) if best else None
    except Exception as ex:
        r['image_status']='PRESENT_COMPARE_ERROR'
        r['image_error']=str(ex)

# TVDB entries without current public video.
unmatched=[]
for ti in skipped_tv:
    e=tv[ti].copy()
    e['reference_scope']='AFTER_REFERENCE' if e.get('date') and e['date']>REF else 'IN_SCOPE'
    e['status']='TVDB_WITHOUT_CURRENT_PUBLIC_YOUTUBE_MATCH_DO_NOT_DELETE_WITHOUT_HISTORY'
    unmatched.append(e)

# Any YouTube extras (should be none).
youtube_extras=[yt[i] for i in skipped_yt]

in_scope=[r for r in rows if r['reference_scope']=='IN_SCOPE']
unmatched_in=[r for r in unmatched if r['reference_scope']=='IN_SCOPE']

# Season-level structural audit.
seasons=[]
for year in range(2016,2027):
    eps=sorted([e for e in tv if e['season']==year],key=lambda x:x['episode'])
    nums=[e['episode'] for e in eps]
    missing=[x for x in range(1,(max(nums) if nums else 0)+1) if x not in nums]
    dup=[x for x,c in Counter(nums).items() if c>1]
    seasons.append({
        'year':year,'episodes':len(eps),'first':eps[0]['code'] if eps else None,'last':eps[-1]['code'] if eps else None,
        'missing_numbers':missing,'duplicate_numbers':dup,
        'season_premieres':[e['code'] for e in eps if e.get('flag')=='season premiere'],
        'season_finales':[e['code'] for e in eps if e.get('flag')=='season finale'],
        'artworks_present':sum(1 for e in eps if e.get('artwork'))
    })

summary={
    'generated_at':datetime.utcnow().isoformat()+'Z',
    'reference_date':REF,
    'youtube_public_videos_current':len(yt),
    'tvdb_episodes_current':len(tv),
    'aligned_pairs_current':len(rows),
    'youtube_extras_current':len(youtube_extras),
    'tvdb_without_current_public_youtube':len(unmatched),
    'in_scope_aligned_pairs':len(in_scope),
    'in_scope_tvdb_historical_without_current_public_youtube':len(unmatched_in),
    'title_exact_mismatches_in_scope':sum(1 for r in in_scope if not r['title_exact']),
    'title_substantive_mismatches_in_scope':sum(1 for r in in_scope if r['title_status']=='SUBSTANTIVE_MISMATCH'),
    'runtime_mismatches_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is False),
    'runtime_unverifiable_in_scope':sum(1 for r in in_scope if r['runtime_exact'] is None),
    'youtube_dates_independently_retrieved_in_scope':sum(1 for r in in_scope if r['date_verified']),
    'date_mismatches_in_scope':sum(1 for r in in_scope if r['date_exact'] is False),
    'images_missing_in_scope':sum(1 for r in in_scope if r['image_status']=='MISSING_IMAGE'),
    'images_confirmed_official_thumbnail_in_scope':sum(1 for r in in_scope if r['image_status']=='CONFIRMED_OFFICIAL_THUMBNAIL'),
    'images_present_origin_unproven_in_scope':sum(1 for r in in_scope if r['image_status'] in ('PRESENT_ORIGIN_UNPROVEN','PRESENT_COMPARE_ERROR')),
}

report={'summary':summary,'seasons':seasons,'rows':rows,'tvdb_historical_without_current_public_youtube':unmatched,'youtube_extras':youtube_extras}
json.dump(report,open('reports/mcfly-final/audit.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)

# CSV exhaustive row-level audit.
fields=['code','reference_scope','tvdb_date','youtube_date','date_verified','date_exact','tvdb_title','youtube_title','title_exact','title_status','youtube_id','youtube_duration','tvdb_runtime_minutes','expected_runtime_minutes','runtime_exact','season_flag','image_status','tvdb_artwork','youtube_url']
with open('reports/mcfly-final/audit.csv','w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
    for r in rows: w.writerow({k:r.get(k) for k in fields})

# Copy/paste Markdown report.
def md_escape(s):
    return (s or '').replace('|','\\|').replace('\n',' ')

lines=[]
lines += ['# Audit exhaustif Mcfly & Carlito — TheTVDB vs YouTube officiel','',f'**Date de référence : {REF}**','']
lines += ['## Bilan chiffré','']
for k,v in summary.items(): lines.append(f'- **{k}** : {v}')
lines += ['','## Structure TheTVDB par saison','', '| Saison | Épisodes | Trous | Doublons | Finale | Artworks présents |','|---:|---:|---|---|---|---:|']
for s in seasons:
    lines.append(f"| {s['year']} | {s['episodes']} | {','.join(map(str,s['missing_numbers'])) or '—'} | {','.join(map(str,s['duplicate_numbers'])) or '—'} | {', '.join(s['season_finales']) or '—'} | {s['artworks_present']} |")

lines += ['','## Corrections de titre exactes dans le périmètre (YouTube actuel ≠ TheTVDB)','']
for r in in_scope:
    if not r['title_exact']:
        lines.append(f"- **{r['code']} — {r['tvdb_date']}** — TheTVDB : « {r['tvdb_title']} » → YouTube actuel : « {r['youtube_title']} » — {r['title_status']}")

lines += ['','## Corrections de runtime dans le périmètre','']
bad_run=[r for r in in_scope if r['runtime_exact'] is False]
if bad_run:
    for r in bad_run:
        lines.append(f"- **{r['code']} — {r['tvdb_date']} — {md_escape(r['youtube_title'])}** : YouTube {r['youtube_duration']} → TheTVDB {r['tvdb_runtime_minutes']} min ; valeur minute attendue {r['expected_runtime_minutes']} min.")
else:
    lines.append('- Aucune divergence de runtime détectée.')

lines += ['','## Entrées TheTVDB sans vidéo publique actuelle — ne pas supprimer automatiquement','']
for e in unmatched_in:
    lines.append(f"- **{e['code']} — {e['date']} — {e['title']}** — historique/privé/supprimé à rechercher avant toute décision.")

lines += ['','## Images d’épisode','',
         f"- Images manquantes dans le périmètre : **{summary['images_missing_in_scope']}**.",
         f"- Images confirmées identiques à la miniature YouTube officielle : **{summary['images_confirmed_official_thumbnail_in_scope']}**.",
         f"- Images présentes mais dont l’origine n’est pas prouvée par correspondance de miniature : **{summary['images_present_origin_unproven_in_scope']}**. Elles restent **douteuses** et ne sont pas validées par défaut.",
         '',
         '## Périmètre après la date de référence',
         '- S2026E16 (14/09/2026) et S2026E17 (27/09/2026) existent aujourd’hui mais sont hors périmètre du 09/09/2026 ; elles ne servent pas à renuméroter rétroactivement l’audit.',
         '',
         '## Annexe exhaustive',
         '- Le fichier CSV joint contient une ligne pour chaque vidéo publique actuelle alignée avec TheTVDB, avec titre, date, durée, runtime, image et statut.',
         '- Le JSON joint conserve toutes les données et les 21 entrées historiques TheTVDB sans vidéo publique actuelle.'
]
open('reports/mcfly-final/audit.md','w',encoding='utf-8').write('\n'.join(lines)+'\n')
open('reports/mcfly-final/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
