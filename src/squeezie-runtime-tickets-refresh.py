import json,re,math,unicodedata
from difflib import SequenceMatcher
from datetime import datetime
import requests
from bs4 import BeautifulSoup

SERIES='279758-show'
YEARS=[2016,2017,2019,2021]
ROOT='reports/squeezie-runtime-tickets-refresh'
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
def expected(sec): return int(math.floor(float(sec)/60+0.5)) if sec is not None else None
def fmt(sec):
    if sec is None:return None
    sec=int(sec);h,r=divmod(sec,3600);m,s=divmod(r,60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'

cat=json.load(open(ROOT+'/catalogue.json',encoding='utf-8'))
yt=[{'id':e['id'],'title':e['title'],'duration_seconds':e.get('duration')} for e in cat.get('entries') or [] if e.get('id') and e.get('title')]
tv=[]
date_re=re.compile(r'^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$')
for year in YEARS:
    r=requests.get(f'https://thetvdb.com/series/{SERIES}/seasons/official/{year}',headers=HEAD,timeout=30);r.raise_for_status()
    soup=BeautifulSoup(r.text,'html.parser');seen=set()
    for a in soup.select(f'a[href*="/series/{SERIES}/episodes/"]'):
        mm=re.search(r'/episodes/(\d+)',a.get('href') or '')
        if not mm or mm.group(1) in seen:continue
        eid=mm.group(1);seen.add(eid)
        row=a.find_parent('tr') or a.find_parent(class_=re.compile('list-group-item|row')) or a.parent
        lines=[x.strip() for x in row.stripped_strings if x.strip()]
        code=next((x for x in lines if re.fullmatch(rf'S{year}E\d+',x)),None)
        if not code:continue
        ep=int(re.search(r'E(\d+)',code).group(1));ci=lines.index(code);j=ci+1;parts=[]
        while j<len(lines) and not date_re.match(lines[j]) and not re.match(r'^season (premiere|finale)$',lines[j],re.I):
            parts.append(lines[j]);j+=1
        flag=None
        if j<len(lines) and re.match(r'^season (premiere|finale)$',lines[j],re.I):flag=lines[j].lower();j+=1
        date=lines[j] if j<len(lines) and date_re.match(lines[j]) else None
        if date:j+=1
        if j<len(lines) and lines[j]=='YouTube':j+=1
        runtime=int(lines[j]) if j<len(lines) and re.fullmatch(r'\d+',lines[j]) else None
        tv.append({'year':year,'episode':ep,'code':f'S{year}E{ep:03d}','episode_id':eid,'title':' '.join(parts).strip(),'date':date,'runtime_minutes':runtime,'flag':flag})

rows=[]
for e in tv:
    exact=[y for y in yt if norm(y['title'])==norm(e['title'])]
    if len(exact)==1:
        y=exact[0];score=1.0;status='EXACT_TITLE_MATCH'
    else:
        cand=sorted([(sim(e['title'],y['title']),y) for y in yt],key=lambda z:z[0],reverse=True)
        score,y=cand[0];second=cand[1][0] if len(cand)>1 else 0
        if score>=0.95 and score-second>=0.08:status='HIGH_CONFIDENCE_MATCH'
        else:continue
    exp=expected(y.get('duration_seconds'))
    if exp is None or e['runtime_minutes'] is None:continue
    diff=abs(exp-e['runtime_minutes'])
    if diff>1:
        rows.append({**e,'youtube_id':y['id'],'youtube_title':y['title'],'youtube_duration':fmt(y.get('duration_seconds')),'youtube_duration_seconds':y.get('duration_seconds'),'expected_runtime_minutes':exp,'runtime_diff_minutes':exp-e['runtime_minutes'],'match_status':status,'similarity':round(score,3)})

report={'generatedAt':datetime.utcnow().isoformat()+'Z','target':'Squeezie','scope':'Fresh runtime-ticket recheck for 2016/2017/2019/2021','summary':{'years':YEARS,'runtime_mismatches_gt1m':len(rows)},'rows':rows}
json.dump(report,open(ROOT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
open(ROOT+'/summary.txt','w',encoding='utf-8').write('runtime_mismatches_gt1m='+str(len(rows))+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
