import json,re,math,unicodedata
from datetime import datetime
from difflib import SequenceMatcher
from concurrent.futures import ThreadPoolExecutor,as_completed
import requests
from bs4 import BeautifulSoup

SERIES='raska'; REF='2026-09-09'; ROOT='reports/raska-exact-date-audit-v2'
HEAD={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36','Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'}

def norm(s):
 s=unicodedata.normalize('NFKD',s or '')
 s=''.join(c for c in s if not unicodedata.combining(c)).lower()
 s=re.sub(r'@[\w.-]+',' ',s); s=re.sub(r'[^a-z0-9]+',' ',s)
 return re.sub(r'\s+',' ',s).strip()
def canon(s): return unicodedata.normalize('NFC',(s or '')).strip()
def sim(a,b):
 A=norm(a);B=norm(b);seq=SequenceMatcher(None,A,B).ratio();sa=set(A.split());sb=set(B.split());inter=len(sa&sb)
 return max(seq,0.55*(inter/(len(sa|sb) or 1))+0.45*(inter/(min(len(sa) or 1,len(sb) or 1))))
def expected_minutes(sec): return int(math.floor(float(sec)/60+0.5)) if sec is not None else None
def fmt(sec):
 if sec is None:return None
 sec=int(sec);h,r=divmod(sec,3600);m,s=divmod(r,60);return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'
def get(url,t=25):
 s=requests.Session();s.headers.update(HEAD);r=s.get(url,timeout=t);r.raise_for_status();return r

cat=json.load(open(ROOT+'/catalogue.json',encoding='utf-8'))
yt=[]
for pos,e in enumerate(cat.get('entries') or []):
 if not e.get('id') or not e.get('title'):continue
 yt.append({'position':pos,'id':e['id'],'title':e['title'],'duration_seconds':e.get('duration'),'url':e.get('url') or f"https://www.youtube.com/watch?v={e['id']}"})
print('YouTube flat',len(yt))

home=get('https://www.youtube.com/?hl=fr&gl=FR').text
mk=re.search(r'"INNERTUBE_API_KEY":"([^"]+)"',home)
mv=re.search(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"',home) or re.search(r'"clientVersion":"([^"]+)"',home)
key=mk.group(1) if mk else None; version=mv.group(1) if mv else '2.20261001.00.00'
api='https://www.youtube.com/youtubei/v1/player?key='+key if key else None

def meta(v):
 out={'id':v['id'],'publish_date':None,'upload_date':None,'api_duration_seconds':None,'api_title':None,'metadata_attempts':[],'date_source':None}
 clients=[
  ('WEB',version,HEAD),
  ('WEB_EMBEDDED_PLAYER',version,{**HEAD,'Referer':'https://www.youtube.com/embed/'+v['id']}),
  ('ANDROID','20.10.38',{'User-Agent':'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip','Accept-Language':'fr-FR'}),
  ('TVHTML5','7.20261002',HEAD)
 ]
 try:
  if api:
   for cname,cver,headers in clients:
    try:
     payload={'context':{'client':{'clientName':cname,'clientVersion':cver,'hl':'fr','gl':'FR'}},'videoId':v['id'],'contentCheckOk':True,'racyCheckOk':True}
     rr=requests.post(api,headers={**headers,'Content-Type':'application/json'},json=payload,timeout=15)
     d=rr.json()
     micro=((d.get('microformat') or {}).get('playerMicroformatRenderer') or {})
     vd=d.get('videoDetails') or {}
     attempt={'client':cname,'status':rr.status_code,'playability':((d.get('playabilityStatus') or {}).get('status')),'reason':((d.get('playabilityStatus') or {}).get('reason')),'publish_date':micro.get('publishDate'),'upload_date':micro.get('uploadDate')}
     out['metadata_attempts'].append(attempt)
     if not out.get('api_title') and vd.get('title'): out['api_title']=vd.get('title')
     if out.get('api_duration_seconds') is None and str(vd.get('lengthSeconds','')).isdigit(): out['api_duration_seconds']=int(vd['lengthSeconds'])
     if micro.get('publishDate'):
      out['publish_date']=micro.get('publishDate');out['upload_date']=micro.get('uploadDate');out['date_source']='PLAYER_'+cname;break
     if not out.get('upload_date') and micro.get('uploadDate'): out['upload_date']=micro.get('uploadDate')
    except Exception as ex:
     out['metadata_attempts'].append({'client':cname,'error':str(ex)})
  if not out['publish_date']:
   txt=get('https://www.youtube.com/watch?v='+v['id']+'&hl=fr&gl=FR',12).text
   for label,pat in [('WATCH_publishDate',r'"publishDate":"(\d{4}-\d{2}-\d{2})"'),('WATCH_uploadDate',r'"uploadDate":"(\d{4}-\d{2}-\d{2})"'),('WATCH_meta',r'itemprop="datePublished" content="(\d{4}-\d{2}-\d{2})"')]:
    m=re.search(pat,txt)
    if m:out['publish_date']=m.group(1);out['date_source']=label;break
 except Exception as ex:out['error']=str(ex)
 return out

byid={v['id']:v for v in yt}
with ThreadPoolExecutor(max_workers=20) as ex:
 futs=[ex.submit(meta,v) for v in yt]
 for i,f in enumerate(as_completed(futs),1):
  d=f.result();byid[d['id']].update(d)
  if i%40==0:print('metadata',i,'/',len(yt))
print('Exact dates',sum(1 for v in yt if v.get('publish_date')),'/',len(yt))

tv=[]
date_re=re.compile(r'^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$')
for year in range(2017,2027):
 soup=BeautifulSoup(get(f'https://www.thetvdb.com/series/{SERIES}/seasons/official/{year}',30).text,'html.parser');seen=set()
 for a in soup.select(f'a[href*="/series/{SERIES}/episodes/"]'):
  href=a.get('href') or '';mm=re.search(r'/episodes/(\d+)',href)
  if not mm or mm.group(1) in seen:continue
  eid=mm.group(1);seen.add(eid);row=a.find_parent('tr') or a.find_parent(class_=re.compile('list-group-item|row'))
  text='\n'.join(x.strip() for x in (row.stripped_strings if row else a.parent.stripped_strings))
  mc=re.search(rf'S{year}E(\d+)',text)
  if not mc:continue
  ep=int(mc.group(1));lines=[x.strip() for x in text.split('\n') if x.strip()]
  try:ci=next(i for i,x in enumerate(lines) if re.fullmatch(rf'S{year}E0*{ep}',x))
  except StopIteration:ci=0
  j=ci+1;parts=[];flag=None;date=None
  while j<len(lines) and not date_re.match(lines[j]) and not re.match(r'^season (premiere|finale)$',lines[j],re.I):
   parts.append(lines[j]);j+=1
  if j<len(lines) and re.match(r'^season (premiere|finale)$',lines[j],re.I):flag=lines[j].lower();j+=1
  if j<len(lines) and date_re.match(lines[j]):date=datetime.strptime(lines[j],'%B %d, %Y').strftime('%Y-%m-%d');j+=1
  if j<len(lines) and lines[j]=='YouTube':j+=1
  runtime=int(lines[j]) if j<len(lines) and re.fullmatch(r'\d+',lines[j]) else None
  tv.append({'season':year,'episode':ep,'code':f'S{year}E{ep:02d}','episode_id':eid,'title':' '.join(parts).strip(),'date':date,'runtime_minutes':runtime,'flag':flag})
 print('TVDB',year,len(seen))
print('TVDB total',len(tv))

tvsort=sorted(tv,key=lambda e:(e.get('date') or '',e['season'],e['episode']),reverse=True)
n,m=len(yt),len(tvsort);NEG=-10**9
score=[[NEG]*(m+1) for _ in range(n+1)];ptr=[[None]*(m+1) for _ in range(n+1)];score[0][0]=0
for j in range(1,m+1):score[0][j]=score[0][j-1]-0.35;ptr[0][j]='skip_tv'
for i in range(1,n+1):score[i][0]=score[i-1][0]-2.0;ptr[i][0]='skip_yt'
for i in range(1,n+1):
 for j in range(1,m+1):
  y,e=yt[i-1],tvsort[j-1];s=sim(y['title'],e['title']);bonus=0
  if y.get('publish_date') and e.get('date'):
   bonus=0.8 if y['publish_date']==e['date'] else (0.1 if y['publish_date'][:4]==str(e['season']) else -1.0)
  opts=[(score[i-1][j-1]+2.2*s-0.65+bonus,'match'),(score[i][j-1]-0.35,'skip_tv'),(score[i-1][j]-2.0,'skip_yt')]
  score[i][j],ptr[i][j]=max(opts,key=lambda x:x[0])
pairs=[];stv=[];syt=[];i=n;j=m
while i or j:
 p=ptr[i][j]
 if p=='match':pairs.append((i-1,j-1,sim(yt[i-1]['title'],tvsort[j-1]['title'])));i-=1;j-=1
 elif p=='skip_tv':stv.append(j-1);j-=1
 elif p=='skip_yt':syt.append(i-1);i-=1
 else:break
pairs.reverse();stv.reverse();syt.reverse()

rows=[]
for yi,ti,s in pairs:
 y,e=yt[yi],tvsort[ti];pub=y.get('publish_date');dur=y.get('api_duration_seconds') or y.get('duration_seconds');exp=expected_minutes(dur)
 rows.append({'code':e['code'],'episode_id':e['episode_id'],'tvdb_title':e['title'],'youtube_title':y['title'],'title_similarity':round(s,3),'title_exact':canon(e['title'])==canon(y['title']),'youtube_id':y['id'],'tvdb_date':e.get('date'),'youtube_date':pub,'date_exact':(pub==e.get('date')) if pub and e.get('date') else None,'youtube_duration':fmt(dur),'youtube_duration_seconds':dur,'tvdb_runtime_minutes':e.get('runtime_minutes'),'expected_runtime_minutes':exp,'runtime_exact':(exp==e.get('runtime_minutes')) if exp is not None and e.get('runtime_minutes') is not None else None,'reference_scope':'IN_SCOPE' if (pub or e.get('date') or '')<=REF else 'AFTER_REFERENCE','season_flag':e.get('flag')})

unmatched_tv=[tvsort[x] for x in stv];unmatched_yt=[yt[x] for x in syt]
ins=[r for r in rows if r['reference_scope']=='IN_SCOPE']
summary={
 'youtube_public_long':len(yt),'youtube_exact_dates':sum(1 for v in yt if v.get('publish_date')),
 'tvdb_episodes':len(tv),'matched':len(rows),'youtube_unmatched':len(unmatched_yt),'tvdb_without_current_public_youtube':len(unmatched_tv),
 'in_scope_matched':len(ins),'date_mismatches':sum(r['date_exact'] is False for r in ins),'date_unverified':sum(r['date_exact'] is None for r in ins),
 'runtime_mismatches':sum(r['runtime_exact'] is False for r in ins),'runtime_unverified':sum(r['runtime_exact'] is None for r in ins),
 'substantive_title_candidates':sum(r['title_similarity']<0.78 for r in ins),
 'date_source_counts':dict(__import__('collections').Counter(v.get('date_source') or 'NONE' for v in yt)),
 'playability_counts':dict(__import__('collections').Counter((a.get('client','?')+':'+str(a.get('playability'))) for v in yt for a in (v.get('metadata_attempts') or []) if 'playability' in a))
}
report={'generatedAt':datetime.utcnow().isoformat()+'Z','target':'Raska','referenceDate':REF,'mode':'EXACT_DATE_RUNTIME_READ_ONLY','summary':summary,'rows':rows,'youtube_unmatched':[{'id':x['id'],'title':x['title'],'date':x.get('publish_date')} for x in unmatched_yt],'tvdb_historical_without_current_public_youtube':unmatched_tv}
json.dump(report,open(ROOT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
open(ROOT+'/summary.txt','w',encoding='utf-8').write('\n'.join(f'{k}={v}' for k,v in summary.items())+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
if len(yt)<149 or summary['youtube_exact_dates']<145:raise SystemExit(2)
