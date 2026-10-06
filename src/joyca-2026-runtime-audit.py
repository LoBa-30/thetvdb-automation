import json,re,math,unicodedata
from difflib import SequenceMatcher
from datetime import datetime
import requests
from bs4 import BeautifulSoup

SERIES='335805-show'
YT='https://www.youtube.com/c/JOYCA-JORDAN/videos'
ROOT='reports/joyca-2026-runtime-audit'
HEAD={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36','Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'}

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=re.sub(r'@([a-z0-9_.-]+)',r'\1',s)
    s=re.sub(r'[^a-z0-9]+',' ',s)
    return re.sub(r'\s+',' ',s).strip()
def sim(a,b):
    A=norm(a);B=norm(b)
    if not A or not B:return 0
    seq=SequenceMatcher(None,A,B).ratio()
    sa=set(A.split());sb=set(B.split());inter=len(sa&sb)
    jac=inter/(len(sa|sb) or 1);cont=inter/(min(len(sa),len(sb)) or 1)
    return max(seq,0.55*jac+0.45*cont)
def expected(sec):
    return int(math.floor(float(sec)/60+0.5)) if sec is not None else None
def fmt(sec):
    if sec is None:return None
    sec=int(sec);h,r=divmod(sec,3600);m,s=divmod(r,60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'

cat=json.load(open(ROOT+'/catalogue.json',encoding='utf-8'))
yt=[]
for i,e in enumerate(cat.get('entries') or []):
    if e.get('id') and e.get('title'):
        yt.append({'position':i,'id':e['id'],'title':e['title'],'duration_seconds':e.get('duration')})

r=requests.get(f'https://thetvdb.com/series/{SERIES}/seasons/official/2026',headers=HEAD,timeout=30)
r.raise_for_status(); soup=BeautifulSoup(r.text,'html.parser')
date_re=re.compile(r'^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, 2026$')
tv=[];seen=set()
for a in soup.select(f'a[href*="/series/{SERIES}/episodes/"]'):
    mm=re.search(r'/episodes/(\d+)',a.get('href') or '')
    if not mm or mm.group(1) in seen:continue
    eid=mm.group(1);seen.add(eid)
    row=a.find_parent('tr') or a.find_parent(class_=re.compile('list-group-item|row')) or a.parent
    lines=[x.strip() for x in row.stripped_strings if x.strip()]
    code=next((x for x in lines if re.fullmatch(r'S2026E\d+',x)),None)
    if not code:continue
    ep=int(re.search(r'E(\d+)',code).group(1));ci=lines.index(code)
    j=ci+1;parts=[]
    while j<len(lines) and not date_re.match(lines[j]) and not re.match(r'^season (premiere|finale)$',lines[j],re.I):
        parts.append(lines[j]);j+=1
    flag=None
    if j<len(lines) and re.match(r'^season (premiere|finale)$',lines[j],re.I):flag=lines[j].lower();j+=1
    date=lines[j] if j<len(lines) and date_re.match(lines[j]) else None
    if date:j+=1
    if j<len(lines) and lines[j]=='YouTube':j+=1
    runtime=int(lines[j]) if j<len(lines) and re.fullmatch(r'\d+',lines[j]) else None
    tv.append({'code':f'S2026E{ep:02d}','episode':ep,'episode_id':eid,'title':' '.join(parts).strip(),'date':date,'runtime_minutes':runtime,'flag':flag})

rows=[]
used=set()
for e in sorted(tv,key=lambda x:x['episode']):
    candidates=[]
    for y in yt:
        if y['id'] in used:continue
        s=sim(e['title'],y['title'])
        if s>=0.72:candidates.append((s,y))
    candidates.sort(key=lambda z:z[0],reverse=True)
    if not candidates:
        rows.append({**e,'match':None,'status':'NO_CONFIDENT_YOUTUBE_MATCH'})
        continue
    s,y=candidates[0]
    # Require strong margin for repeated concepts.
    second=candidates[1][0] if len(candidates)>1 else 0
    status='MATCH' if s>=0.84 and (s-second>=0.06 or s>=0.97) else 'AMBIGUOUS'
    if status=='MATCH':used.add(y['id'])
    exp=expected(y.get('duration_seconds'))
    rows.append({**e,'youtube_id':y['id'],'youtube_title':y['title'],'youtube_duration':fmt(y.get('duration_seconds')),'youtube_duration_seconds':y.get('duration_seconds'),'similarity':round(s,3),'second_similarity':round(second,3),'expected_runtime_minutes':exp,'runtime_exact':(exp==e['runtime_minutes']) if exp is not None and e['runtime_minutes'] is not None else None,'status':status})

report={'generatedAt':datetime.utcnow().isoformat()+'Z','target':'Joyca','scope':'2026 runtime fresh read-only preflight','summary':{
    'tvdb_2026':len(tv),'matched':sum(x['status']=='MATCH' for x in rows),'ambiguous':sum(x['status']=='AMBIGUOUS' for x in rows),
    'runtime_mismatches':sum(x.get('runtime_exact') is False and x['status']=='MATCH' for x in rows),
    'runtime_unverified':sum(x.get('runtime_exact') is None and x['status']=='MATCH' for x in rows)
},'rows':rows}
json.dump(report,open(ROOT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
open(ROOT+'/summary.txt','w',encoding='utf-8').write('\n'.join(f'{k}={v}' for k,v in report['summary'].items())+'\n')
print(json.dumps(report['summary'],ensure_ascii=False,indent=2))
