import json,re
from datetime import datetime
import requests
from bs4 import BeautifulSoup

SLUG='maxime-biaggi'
ROOT='reports/maxime-season-boundary-audit'
HEAD={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36','Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'}
YEARS=list(range(2019,2027))
date_re=re.compile(r'^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$')
seasons=[]
for year in YEARS:
    url=f'https://thetvdb.com/series/{SLUG}/seasons/official/{year}'
    r=requests.get(url,headers=HEAD,timeout=30)
    if r.status_code!=200:
        seasons.append({'year':year,'http':r.status_code,'episodes':[]});continue
    soup=BeautifulSoup(r.text,'html.parser');rows=[];seen=set()
    for a in soup.select(f'a[href*="/series/{SLUG}/episodes/"]'):
        m=re.search(r'/episodes/(\d+)',a.get('href') or '')
        if not m or m.group(1) in seen:continue
        eid=m.group(1);seen.add(eid)
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
        rows.append({'episode':ep,'code':f'S{year}E{ep:02d}','episode_id':eid,'title':' '.join(parts).strip(),'date':date,'flag':flag})
    rows.sort(key=lambda x:x['episode'])
    seasons.append({'year':year,'http':200,'count':len(rows),'first':rows[0] if rows else None,'last':rows[-1] if rows else None,'flagged':[x for x in rows if x['flag']]})

report={'generatedAt':datetime.utcnow().isoformat()+'Z','target':'Maxime Biaggi','mode':'READ_ONLY_SEASON_BOUNDARY_AUDIT','seasons':seasons,
'summary':{'seasons_with_episodes':sum(bool(x.get('count')) for x in seasons),'premiere_flags':sum(any(f['flag']=='season premiere' for f in x.get('flagged',[])) for x in seasons),'finale_flags':sum(any(f['flag']=='season finale' for f in x.get('flagged',[])) for x in seasons)}}
json.dump(report,open(ROOT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(json.dumps(report,ensure_ascii=False,indent=2))
