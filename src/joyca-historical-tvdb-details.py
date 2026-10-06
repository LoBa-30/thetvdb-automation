import json,re,os,requests
from bs4 import BeautifulSoup
from datetime import datetime
OUT='reports/joyca-historical-tvdb-details'
os.makedirs(OUT,exist_ok=True)
SERIES='335805-show'
targets={
 'S2016E37',
 'S2017E04','S2017E10','S2017E19','S2017E25','S2017E26','S2017E28','S2017E34','S2017E39','S2017E40','S2017E43','S2017E46','S2017E48','S2017E56',
 'S2018E04','S2018E12','S2018E17','S2018E23','S2018E43',
 'S2023E34','S2025E05'
}
years=sorted({int(x[1:5]) for x in targets})
S=requests.Session()
S.headers.update({'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36','Accept-Language':'en-US,en;q=0.9'})
rows=[]
errors=[]
date_re=re.compile(r'^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$')
for year in years:
    url=f'https://thetvdb.com/series/{SERIES}/seasons/official/{year}'
    try:
        r=S.get(url,timeout=30); r.raise_for_status()
        soup=BeautifulSoup(r.text,'html.parser')
        seen=set()
        for a in soup.select(f'a[href*="/series/{SERIES}/episodes/"]'):
            href=a.get('href') or ''
            m=re.search(r'/episodes/(\d+)',href)
            if not m or m.group(1) in seen: continue
            seen.add(m.group(1))
            eid=m.group(1)
            row=a.find_parent('tr') or a.find_parent(class_=re.compile('list-group-item|row'))
            txt='\n'.join(x.strip() for x in (row.stripped_strings if row else a.parent.stripped_strings))
            cm=re.search(rf'S{year}E(\d+)',txt)
            if not cm: continue
            code=f'S{year}E{int(cm.group(1)):02d}'
            if code not in targets: continue
            lines=[x.strip() for x in txt.split('\n') if x.strip()]
            try: ci=next(i for i,x in enumerate(lines) if re.fullmatch(rf'S{year}E0*{int(cm.group(1))}',x))
            except: ci=0
            j=ci+1; title_parts=[]
            while j<len(lines) and not date_re.match(lines[j]) and not re.match(r'^season (premiere|finale)$',lines[j],re.I):
                title_parts.append(lines[j]); j+=1
            if j<len(lines) and re.match(r'^season (premiere|finale)$',lines[j],re.I): j+=1
            aired=lines[j] if j<len(lines) and date_re.match(lines[j]) else None
            detail_url='https://thetvdb.com'+href if href.startswith('/') else href
            dr=S.get(detail_url,timeout=30); dr.raise_for_status()
            ds=BeautifulSoup(dr.text,'html.parser')
            body=' '.join(ds.stripped_strings)
            heading=next((' '.join(h.stripped_strings).strip() for h in ds.find_all(['h1','h2']) if ' '.join(h.stripped_strings).strip()),None)
            rt=re.search(r'RUNTIME\s+(\d+)\s+minutes?',body,re.I)
            created=re.search(r'CREATED\s+(.+?)\s+by\s+',body,re.I)
            modified=re.search(r'MODIFIED\s+(.+?)\s+by\s+',body,re.I)
            rows.append({
              'code':code,'episode_id':eid,'title':' '.join(title_parts).strip() or heading,
              'heading':heading,'firstAired':aired,'runtimeMinutes':int(rt.group(1)) if rt else None,
              'createdText':created.group(1).strip() if created else None,
              'modifiedText':modified.group(1).strip() if modified else None,
              'detailUrl':detail_url,
              'bodyPreview':body[:2200]
            })
    except Exception as e:
        errors.append({'year':year,'error':str(e)})
report={
 'generatedAt':datetime.utcnow().isoformat()+'Z',
 'target':'Joyca',
 'mode':'READ_ONLY_TVDB_HISTORICAL_DETAIL',
 'expected':len(targets),
 'found':len(rows),
 'errors':errors,
 'episodes':sorted(rows,key=lambda x:x['code'])
}
json.dump(report,open(f'{OUT}/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
print('expected',len(targets),'found',len(rows),'errors',len(errors))
for x in report['episodes']:
    print(x['code'],x['episode_id'],x['createdText'],x['modifiedText'])
if len(rows)!=len(targets) or errors: raise SystemExit(2)
