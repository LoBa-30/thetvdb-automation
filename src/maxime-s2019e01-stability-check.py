import requests,json,time,re
from pathlib import Path
from datetime import datetime,timezone
OUT=Path('reports/maxime-s2019e01-stability-check-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
url='https://thetvdb.com/series/maxime-biaggi/episodes/11696580'
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
reads=[]
for i in range(6):
  r=S.get(url,params={'stability_probe':i},headers={'Cache-Control':'no-cache'},timeout=30)
  arts=sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+episode[^"\'<>\s]+/screencap/[^"\'<>\s]+',r.text))) if r.status_code==200 else []
  reads.append({'i':i,'status':r.status_code,'artworks':arts})
  time.sleep(2)
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'url':url,'reads':reads,'presentCount':sum(bool(x['artworks']) for x in reads),'stablePresent':all(bool(x['artworks']) for x in reads),'stableAbsent':all(not x['artworks'] for x in reads)}
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
