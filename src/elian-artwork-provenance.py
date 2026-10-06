import json,io,os,requests
from PIL import Image
import imagehash
from concurrent.futures import ThreadPoolExecutor,as_completed

SRC='reports/elian-artwork-inventory/report.json'
OUT='reports/elian-artwork-provenance'
os.makedirs(OUT,exist_ok=True)
d=json.load(open(SRC,encoding='utf-8'))
items=[{
  'code':x['code'],'episodeId':x['episodeId'],'title':x['tvdbTitle'],
  'artwork':x['tvdbArtwork'],'youtubeId':x['youtubeId'],'youtubeTitle':x['youtubeTitle']
} for x in d.get('matches',[]) if x.get('hasArtwork') and x.get('tvdbArtwork') and x.get('youtubeId')]
H={'User-Agent':'Mozilla/5.0'}

def phash_url(url):
    r=requests.get(url,headers=H,timeout=25)
    r.raise_for_status()
    im=Image.open(io.BytesIO(r.content)).convert('RGB')
    return imagehash.phash(im),im.size

def one(x):
    out=dict(x)
    try:
        ah,asz=phash_url(x['artwork']);out['artworkSize']=asz
    except Exception as e:
        out['status']='ARTWORK_FETCH_ERROR';out['error']=str(e);return out
    refs=[]
    for kind,url in [
      ('maxres',f"https://i.ytimg.com/vi/{x['youtubeId']}/maxresdefault.jpg"),
      ('hq',f"https://i.ytimg.com/vi/{x['youtubeId']}/hqdefault.jpg"),
      ('frame0',f"https://i.ytimg.com/vi/{x['youtubeId']}/0.jpg"),
      ('frame1',f"https://i.ytimg.com/vi/{x['youtubeId']}/1.jpg"),
      ('frame2',f"https://i.ytimg.com/vi/{x['youtubeId']}/2.jpg"),
      ('frame3',f"https://i.ytimg.com/vi/{x['youtubeId']}/3.jpg")
    ]:
        try:
            h,size=phash_url(url);refs.append({'kind':kind,'url':url,'size':size,'distance':int(ah-h)})
        except Exception as e:
            refs.append({'kind':kind,'url':url,'error':str(e)})
    valid=[r for r in refs if 'distance' in r]
    best=min(valid,key=lambda r:r['distance']) if valid else None
    out['references']=refs;out['best']=best
    if best and best['distance']<=4: out['status']='CONFIRMED_SAME_VIDEO_YOUTUBE_REFERENCE'
    elif best and best['distance']<=10: out['status']='STRONG_SAME_VIDEO_CANDIDATE'
    else: out['status']='ORIGIN_STILL_UNPROVEN'
    return out

rows=[]
with ThreadPoolExecutor(max_workers=12) as ex:
    for f in as_completed([ex.submit(one,x) for x in items]): rows.append(f.result())
rows.sort(key=lambda x:x['code'])
summary={
 'existing_artworks_checked':len(rows),
 'confirmed_same_video_reference':sum(x.get('status')=='CONFIRMED_SAME_VIDEO_YOUTUBE_REFERENCE' for x in rows),
 'strong_candidate':sum(x.get('status')=='STRONG_SAME_VIDEO_CANDIDATE' for x in rows),
 'still_unproven':sum(x.get('status')=='ORIGIN_STILL_UNPROVEN' for x in rows),
 'errors':sum('ERROR' in x.get('status','') for x in rows)
}
json.dump({'summary':summary,'rows':rows},open(OUT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
open(OUT+'/summary.txt','w',encoding='utf-8').write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
