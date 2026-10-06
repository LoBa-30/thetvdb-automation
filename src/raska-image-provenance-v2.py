import json,io,os,requests
from PIL import Image
import imagehash
from concurrent.futures import ThreadPoolExecutor,as_completed
SRC='reports/raska-images/image-audit.json'
OUT='reports/raska-images-v2'
os.makedirs(OUT,exist_ok=True)
rows=json.load(open(SRC,encoding='utf-8'))
items=[x for x in rows if x.get('tvdb_image') and x.get('youtube_id')]
H={'User-Agent':'Mozilla/5.0'}
def phash(url):
    r=requests.get(url,headers=H,timeout=20);r.raise_for_status()
    im=Image.open(io.BytesIO(r.content)).convert('RGB')
    return imagehash.phash(im),im.size
def one(x):
    out={k:x.get(k) for k in ['code','episode_id','tvdb_title','tvdb_image','youtube_id','youtube_title']}
    try:
        ah,asz=phash(x['tvdb_image']);out['artwork_size']=asz
    except Exception as e:
        out['status']='ARTWORK_FETCH_ERROR';out['error']=str(e);return out
    refs=[]
    for kind,u in [
      ('maxres',f"https://i.ytimg.com/vi/{x['youtube_id']}/maxresdefault.jpg"),
      ('hq',f"https://i.ytimg.com/vi/{x['youtube_id']}/hqdefault.jpg"),
      ('frame0',f"https://i.ytimg.com/vi/{x['youtube_id']}/0.jpg"),
      ('frame1',f"https://i.ytimg.com/vi/{x['youtube_id']}/1.jpg"),
      ('frame2',f"https://i.ytimg.com/vi/{x['youtube_id']}/2.jpg"),
      ('frame3',f"https://i.ytimg.com/vi/{x['youtube_id']}/3.jpg")]:
        try:
            h,size=phash(u);refs.append({'kind':kind,'url':u,'size':size,'distance':int(ah-h)})
        except Exception as e: refs.append({'kind':kind,'url':u,'error':str(e)})
    valid=[r for r in refs if 'distance' in r]
    best=min(valid,key=lambda r:r['distance']) if valid else None
    out['best']=best
    if best and best['distance']<=4: out['status']='CONFIRMED_SAME_VIDEO_REFERENCE'
    elif best and best['distance']<=10: out['status']='STRONG_SAME_VIDEO_CANDIDATE'
    else: out['status']='ORIGIN_UNPROVEN_NOT_WRONG'
    return out
out=[]
with ThreadPoolExecutor(max_workers=20) as ex:
    for f in as_completed([ex.submit(one,x) for x in items]): out.append(f.result())
out.sort(key=lambda x:x.get('code',''))
summary={
 'existing_checked':len(out),
 'confirmed_same_video_reference':sum(x.get('status')=='CONFIRMED_SAME_VIDEO_REFERENCE' for x in out),
 'strong_same_video_candidate':sum(x.get('status')=='STRONG_SAME_VIDEO_CANDIDATE' for x in out),
 'origin_unproven_not_wrong':sum(x.get('status')=='ORIGIN_UNPROVEN_NOT_WRONG' for x in out),
 'errors':sum('ERROR' in x.get('status','') for x in out),
 'missing_images_from_v1':sum(x.get('provenance')=='MISSING_IMAGE' for x in rows)
}
json.dump({'summary':summary,'rows':out},open(OUT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
open(OUT+'/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
