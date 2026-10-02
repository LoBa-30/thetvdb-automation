import json, io, os, requests
from PIL import Image
import imagehash
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT='reports/mastu-artwork-v3'
V2='reports/mastu-final-v2/audit-v2.json'
os.makedirs(ROOT,exist_ok=True)
d=json.load(open(V2,encoding='utf-8'))
items=[]
for r in d.get('rows',[]):
    if r.get('image_status') in ('PRESENT_ORIGIN_UNPROVEN_SCREENSHOT_OR_CUSTOM','PRESENT_COMPARE_ERROR'):
        items.append({
            'publicId':r['episode_id'],'code':r['code'],'title':r['youtube_title'],
            'artwork':r['tvdb_artwork'],'youtubeId':r['youtube_id']
        })
# Historical Loup-Garou is not in aligned rows but has a stored official YouTube URL.
items.append({
  'publicId':'10115998','code':'S2023E17',
  'title':'LOUP-GAROU NOCTURNE (Avec Joyca, Michou, Maghla...)',
  'artwork':'https://artworks.thetvdb.com/banners/v4/episode/10115998/screencap/653f96156bb4f.jpg',
  'youtubeId':'t1zyUOvZGK0'
})
H={'User-Agent':'Mozilla/5.0'}

def phash_url(url):
    rr=requests.get(url,headers=H,timeout=20)
    rr.raise_for_status()
    im=Image.open(io.BytesIO(rr.content)).convert('RGB')
    return imagehash.phash(im), im.size

def one(x):
    out=dict(x)
    try:
        ah,asz=phash_url(x['artwork'])
        out['artworkSize']=asz
    except Exception as e:
        out['status']='ARTWORK_FETCH_ERROR';out['error']=str(e);return out
    refs=[]
    urls=[
      ('maxres',f"https://i.ytimg.com/vi/{x['youtubeId']}/maxresdefault.jpg"),
      ('hq',f"https://i.ytimg.com/vi/{x['youtubeId']}/hqdefault.jpg"),
      ('frame0',f"https://i.ytimg.com/vi/{x['youtubeId']}/0.jpg"),
      ('frame1',f"https://i.ytimg.com/vi/{x['youtubeId']}/1.jpg"),
      ('frame2',f"https://i.ytimg.com/vi/{x['youtubeId']}/2.jpg"),
      ('frame3',f"https://i.ytimg.com/vi/{x['youtubeId']}/3.jpg"),
    ]
    for kind,u in urls:
        try:
            h,size=phash_url(u)
            refs.append({'kind':kind,'url':u,'size':size,'distance':int(ah-h)})
        except Exception as e:
            refs.append({'kind':kind,'url':u,'error':str(e)})
    out['references']=refs
    valid=[r for r in refs if 'distance' in r]
    best=min(valid,key=lambda r:r['distance']) if valid else None
    out['best']=best
    if best and best['distance']<=4:
        out['status']='CONFIRMED_SAME_VIDEO_YOUTUBE_REFERENCE'
    elif best and best['distance']<=10:
        out['status']='STRONG_SAME_VIDEO_CANDIDATE'
    else:
        out['status']='ORIGIN_STILL_UNPROVEN'
    return out

rows=[]
with ThreadPoolExecutor(max_workers=16) as ex:
    futs=[ex.submit(one,x) for x in items]
    for i,f in enumerate(as_completed(futs),1):
        rows.append(f.result())
        if i%10==0: print('checked',i,'/',len(items))
rows.sort(key=lambda x:(x['code'],x['publicId']))
summary={
 'total_existing_unproven_checked':len(rows),
 'confirmed_same_video_reference':sum(1 for x in rows if x.get('status')=='CONFIRMED_SAME_VIDEO_YOUTUBE_REFERENCE'),
 'strong_candidate':sum(1 for x in rows if x.get('status')=='STRONG_SAME_VIDEO_CANDIDATE'),
 'still_unproven':sum(1 for x in rows if x.get('status')=='ORIGIN_STILL_UNPROVEN'),
 'errors':sum(1 for x in rows if 'ERROR' in x.get('status',''))
}
json.dump({'summary':summary,'rows':rows},open(ROOT+'/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
with open(ROOT+'/summary.txt','w',encoding='utf-8') as f:
    f.write(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    for x in rows:
        f.write(f"{x['code']} | {x['status']} | best={x.get('best')} | {x['title']}\n")
print(json.dumps(summary,ensure_ascii=False,indent=2))
