import json,re,requests,subprocess
from pathlib import Path
from datetime import datetime,timezone
OUT=Path('reports/elian-series-profile-preflight-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
BASE='https://thetvdb.com';SLUG='elian-ventre-462729';YT='https://www.youtube.com/@elianventre'
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_ELIAN_SERIES_PROFILE_PREFLIGHT','tvdb':{},'youtube':{},'result':'NOT_STARTED'}
r=S.get(f'{BASE}/series/{SLUG}',timeout=30)
report['tvdb']['status']=r.status_code
report['tvdb']['artworkUploadLinks']=sorted(set(re.findall(r'/artwork/upload\?[^"\'<>\s]+',r.text)))
report['tvdb']['artworkUrls']=sorted(set(re.findall(r'https://artworks\.thetvdb\.com/[^"\'<>\s]+',r.text)))[:100]
report['tvdb']['imageTags']=[{'src':m.group(1),'alt':m.group(2)} for m in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*alt=["\']([^"\']*)["\']',r.text,re.I)][:100]
try:
 raw=subprocess.check_output(['yt-dlp','--dump-single-json','--skip-download','--no-warnings',YT],text=True)
 d=json.loads(raw)
 report['youtube']={'id':d.get('channel_id') or d.get('id'),'title':d.get('channel') or d.get('uploader') or d.get('title'),'thumbnails':d.get('thumbnails') or []}
except Exception as e:
 report['youtube']={'error':str(e)}
report['result']='PREFLIGHT_COMPLETE'
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'tvdb':report['tvdb'],'youtubeThumbs':report['youtube'].get('thumbnails',[])},ensure_ascii=False,indent=2))
