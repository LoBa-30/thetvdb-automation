import json,io,os,requests
import numpy as np
from PIL import Image
import imagehash
from skimage.metrics import structural_similarity as ssim
SRC='reports/raska-images-v2/report.json'; OUT='reports/raska-images-v3'
os.makedirs(OUT,exist_ok=True)
d=json.load(open(SRC,encoding='utf-8'))
targets=[x for x in d['rows'] if x.get('status')=='STRONG_SAME_VIDEO_CANDIDATE']
H={'User-Agent':'Mozilla/5.0'}
def load(url):
    r=requests.get(url,headers=H,timeout=25);r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert('RGB')
rows=[]
for x in targets:
    tv=load(x['tvdb_image'])
    comps=[]
    for kind,url in [('maxres',f"https://i.ytimg.com/vi/{x['youtube_id']}/maxresdefault.jpg"),('hq',f"https://i.ytimg.com/vi/{x['youtube_id']}/hqdefault.jpg"),('frame0',f"https://i.ytimg.com/vi/{x['youtube_id']}/0.jpg"),('frame1',f"https://i.ytimg.com/vi/{x['youtube_id']}/1.jpg"),('frame2',f"https://i.ytimg.com/vi/{x['youtube_id']}/2.jpg"),('frame3',f"https://i.ytimg.com/vi/{x['youtube_id']}/3.jpg")]:
        try:
            yt=load(url).resize(tv.size,Image.Resampling.LANCZOS)
            a=np.asarray(tv,dtype=np.float32)/255; b=np.asarray(yt,dtype=np.float32)/255
            ga=np.asarray(tv.convert('L'),dtype=np.float32)/255; gb=np.asarray(yt.convert('L'),dtype=np.float32)/255
            hashes={'phash':int(imagehash.phash(tv)-imagehash.phash(yt)),'dhash':int(imagehash.dhash(tv)-imagehash.dhash(yt)),'whash':int(imagehash.whash(tv)-imagehash.whash(yt)),'average_hash':int(imagehash.average_hash(tv)-imagehash.average_hash(yt))}
            comps.append({'kind':kind,'ssim':round(float(ssim(ga,gb,data_range=1.0)),4),'mae':round(float(np.mean(np.abs(a-b))),4),'hashes':hashes})
        except Exception as e: comps.append({'kind':kind,'error':str(e)})
    valid=[c for c in comps if 'ssim' in c];best=max(valid,key=lambda c:c['ssim']) if valid else None
    confirmed=bool(best and (best['ssim']>=0.82 or (best['hashes']['phash']<=10 and best['hashes']['dhash']<=10 and best['hashes']['whash']<=10)))
    rows.append({'code':x['code'],'episode_id':x['episode_id'],'youtube_id':x['youtube_id'],'tvdb_title':x['tvdb_title'],'comparisons':comps,'best':best,'status':'CONFIRMED_SAME_VIDEO_REFERENCE_V3' if confirmed else 'PROVENANCE_REMAINS_STRONG_CANDIDATE'})
summary={'checked':len(rows),'confirmed_v3':sum(x['status']=='CONFIRMED_SAME_VIDEO_REFERENCE_V3' for x in rows),'remaining_strong_candidate':sum(x['status']=='PROVENANCE_REMAINS_STRONG_CANDIDATE' for x in rows)}
json.dump({'summary':summary,'rows':rows},open(OUT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
