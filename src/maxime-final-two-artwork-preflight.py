import json,requests,hashlib,subprocess,os,tempfile
from PIL import Image
from io import BytesIO
from pathlib import Path
from datetime import datetime,timezone

OUT=Path('reports/maxime-final-two-artwork-preflight-2026-10-07');OUT.mkdir(parents=True,exist_ok=True)
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
report={'generatedAt':datetime.now(timezone.utc).isoformat(),'s2019e01':{},'s2025e01':{},'result':'READ_ONLY'}

# S2019E01: compare detached old artwork to official YouTube thumb.
old='https://artworks.thetvdb.com/banners/v4/episode/11696580/screencap/6ac6494b1c107.jpg'
ytid='YC1gtcw9kE8'
def imginfo(url):
 r=S.get(url,timeout=30)
 out={'url':url,'status':r.status_code,'bytes':len(r.content),'contentType':r.headers.get('content-type')}
 if r.status_code==200 and r.headers.get('content-type','').startswith('image/'):
  im=Image.open(BytesIO(r.content));out['size']=list(im.size);out['sha256']=hashlib.sha256(r.content).hexdigest()
 return out
report['s2019e01']['oldArtwork']=imginfo(old)
for name in ['maxresdefault.jpg','hq720.jpg','sddefault.jpg','hqdefault.jpg']:
 try:
  report['s2019e01'].setdefault('youtubeVariants',[]).append(imginfo(f'https://i.ytimg.com/vi/{ytid}/{name}'))
 except Exception as e:report['s2019e01'].setdefault('youtubeVariants',[]).append({'name':name,'error':str(e)})

# S2025E01: create read-only local frame candidates only, no TVDB write.
vid='EqFLIsSB2hg'
tmp=Path(tempfile.mkdtemp(prefix='maxime-frame-'))
report['s2025e01']['youtubeId']=vid
try:
 cmd=['yt-dlp','--no-warnings','-f','bestvideo[height<=720]+bestaudio/best[height<=720]','--download-sections','*00:00:08-00:00:12','--force-keyframes-at-cuts','--merge-output-format','mp4','-o',str(tmp/'clip.%(ext)s'),f'https://www.youtube.com/watch?v={vid}']
 p=subprocess.run(cmd,capture_output=True,text=True,timeout=180)
 report['s2025e01']['download']={'returncode':p.returncode,'stderrTail':p.stderr[-2000:]}
 files=list(tmp.glob('clip.*'))
 if p.returncode==0 and files:
  clip=files[0]
  frame=tmp/'frame.jpg'
  ff=subprocess.run(['ffmpeg','-y','-ss','00:00:01','-i',str(clip),'-frames:v','1','-vf','scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2','-q:v','2',str(frame)],capture_output=True,text=True,timeout=60)
  report['s2025e01']['ffmpeg']={'returncode':ff.returncode,'stderrTail':ff.stderr[-1200:]}
  if frame.exists():
   data=frame.read_bytes();im=Image.open(BytesIO(data))
   report['s2025e01']['frame']={'size':list(im.size),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'path':str(frame)}
   (OUT/'s2025e01-frame.jpg').write_bytes(data)
except Exception as e:
 report['s2025e01']['error']=str(e)

(OUT/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(report,indent=2,ensure_ascii=False))
