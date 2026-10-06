import json,re,requests,os
from bs4 import BeautifulSoup
OUT='reports/mastu-s2018e08-preflight'
os.makedirs(OUT,exist_ok=True)
VID='TcUSeNjrzFU'
EPISODE_ID='6953923'
TVDB_URL=f'https://www.thetvdb.com/series/346011-show/episodes/{EPISODE_ID}'
HEADERS={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36','Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'}

report={'target':'Mastu S2018E08','episodeId':EPISODE_ID,'youtubeId':VID,'mode':'READ_ONLY'}

# YouTube public player metadata
s=requests.Session(); s.headers.update(HEADERS)
home=s.get('https://www.youtube.com/?hl=fr&gl=FR',timeout=30).text
km=re.search(r'"INNERTUBE_API_KEY":"([^"]+)"',home)
vm=re.search(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"',home) or re.search(r'"clientVersion":"([^"]+)"',home)
if not km: raise RuntimeError('No INNERTUBE_API_KEY')
key=km.group(1); ver=vm.group(1) if vm else '2.20261001.00.00'
payload={'context':{'client':{'clientName':'WEB','clientVersion':ver,'hl':'fr','gl':'FR'}},'videoId':VID,'contentCheckOk':True,'racyCheckOk':True}
r=s.post('https://www.youtube.com/youtubei/v1/player?key='+key,json=payload,timeout=30)
r.raise_for_status(); d=r.json()
micro=((d.get('microformat') or {}).get('playerMicroformatRenderer') or {})
vd=d.get('videoDetails') or {}
report['youtube']={
 'title':vd.get('title'),
 'publishDate':micro.get('publishDate'),
 'uploadDate':micro.get('uploadDate'),
 'durationSeconds':int(vd['lengthSeconds']) if str(vd.get('lengthSeconds','')).isdigit() else None,
 'channelId':vd.get('channelId'),
 'author':vd.get('author'),
 'playability':(d.get('playabilityStatus') or {}).get('status')
}

# TheTVDB public episode page
rr=s.get(TVDB_URL,timeout=30); rr.raise_for_status()
soup=BeautifulSoup(rr.text,'html.parser')
body=' '.join(soup.stripped_strings)
heading=None
for tag in soup.find_all(['h1','h2']):
    t=' '.join(tag.stripped_strings).strip()
    if t:
        heading=t; break
aired=re.search(r'ORIGINALLY AIRED\s+(.+?)(?=\s+RUNTIME|\s+NETWORK|\s+CONTENT RATING|\s+CREATED|\s+MODIFIED|\s+ABOUT)',body,re.I)
runtime=re.search(r'RUNTIME\s+(\d+)\s+minutes?',body,re.I)
report['tvdb']={'title':heading,'firstAiredText':aired.group(1) if aired else None,'runtimeMinutes':int(runtime.group(1)) if runtime else None,'url':TVDB_URL}

# Expected rounded TVDB runtime
sec=report['youtube']['durationSeconds']
report['expectedRuntimeMinutes']=int(sec/60+0.5) if sec is not None else None
report['comparison']={
 'titleExact': report['youtube']['title']==report['tvdb']['title'],
 'runtimeExact': report['expectedRuntimeMinutes']==report['tvdb']['runtimeMinutes'] if report['expectedRuntimeMinutes'] is not None and report['tvdb']['runtimeMinutes'] is not None else None
}
json.dump(report,open(f'{OUT}/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(json.dumps(report,ensure_ascii=False,indent=2))
