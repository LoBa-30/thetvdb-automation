#!/usr/bin/env python3
"""Find same-video YouTube maxres still alternatives for 35 manual visual flags.
Strictly source URLs, no TVDB requests, no account login, no changing selected frames.
"""
import concurrent.futures, collections, hashlib, io, json, re
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import urlopen,Request
from PIL import Image,ImageOps,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[1]
manifest=json.loads((ROOT/'reports/artwork-user-approvals-v23-2-2026-10-09.json').read_text())
flags=json.loads((ROOT/'reports/artwork-user192-manual-visual-flags-v24-1-2026-10-10.json').read_text())['flags']
OUT=ROOT/'reports/artwork-user192-alt-stills-v24-2-2026-10-10'
OUT.mkdir(parents=True,exist_ok=True)
sources={str(x['tvdbEpisodeId']):x for x in manifest['targets']}
assert len(flags)==35 and len(sources)==192
assert len(manifest['permanentlyExcluded'])==25 and manifest['separateHold']['tvdbEpisodeId']=='11960844'
assert all(x['tvdbEpisodeId'] in sources for x in flags)
assert all(x['selectedImageUrl']==sources[x['tvdbEpisodeId']]['selectedImageUrl'] for x in flags)
variants=('maxres1','maxres2','maxres3')
tasks=[]
for x in flags:
    for variant in variants:
        tasks.append((x,variant))
def download(task):
    entry,variant=task
    url='https://i.ytimg.com/vi/'+entry['youtubeId']+'/'+variant+'.jpg'
    result={'creator':entry['creator'],'code':entry['code'],'tvdbEpisodeId':entry['tvdbEpisodeId'],
      'youtubeId':entry['youtubeId'],'variant':variant,'url':url,
      'originallySelected':variant==entry['selectedImageVariant'],
      'editorialStatus':'NOT_REVIEWED','safeToUpload':False}
    try:
        req=Request(url,headers={'User-Agent':'Mozilla/5.0 (read-only frame variant review)'})
        with urlopen(req,timeout=25) as r:
            if r.status!=200:raise RuntimeError('HTTP '+str(r.status))
            data=r.read(10_000_001)
        if len(data)>10_000_000:raise RuntimeError('source over 10 MB')
        image=ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')
        w,h=image.size
        if w<640 or h<360 or abs(w/h-16/9)>.025:raise RuntimeError('image geometry mismatch')
        result.update({'status':'SOURCE_OK','width':w,'height':h,'bytes':len(data),
                       'sha256':hashlib.sha256(data).hexdigest()})
        return result,image
    except Exception as e:
        result.update({'status':'SOURCE_UNAVAILABLE','error':str(e)[:150]})
        return result,None
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    pairs=list(executor.map(download,tasks))
results=[r for r,im in pairs]
images={(r['tvdbEpisodeId'],r['variant']):im for r,im in pairs}
try:
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',14)
    small=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',12)
except OSError:
    font=ImageFont.load_default();small=font

sheets=[]
# 4 flagged episodes per sheet, selected + all three maxres source frames
for blockStart in range(0,len(flags),4):
    group=flags[blockStart:blockStart+4]
    cellw=332;cellh=234
    canvas=Image.new('RGB',(3*cellw,len(group)*cellh),'#101928')
    draw=ImageDraw.Draw(canvas)
    for row,entry in enumerate(group):
        for col,variant in enumerate(variants):
            x=col*cellw+8;y=row*cellh+9
            im=images[(entry['tvdbEpisodeId'],variant)]
            selected=variant==entry['selectedImageVariant']
            if im is not None:
                thumb=ImageOps.fit(im,(316,178),method=Image.Resampling.LANCZOS)
                canvas.paste(thumb,(x,y))
            else:
                draw.rectangle((x,y,x+316,y+178),fill='#613634')
                draw.text((x+20,y+72),'MISSING SOURCE',fill='white',font=font)
            if selected:
                draw.rectangle((x-2,y-2,x+318,y+180),outline='#ffb948',width=4)
            text=f"{entry['creator']} {entry['code']} · {variant}"
            draw.text((x,y+182),text[:43],font=font,fill='#ffca6f' if selected else '#f0f5ff')
            draw.text((x,y+204),'SELECTED (do not overwrite)' if selected else 'ALTERNATIVE — NOT YET APPROVED',font=small,fill='#bccce3')
    filename=f'alternatives-{blockStart//4+1:02d}.jpg'
    canvas.save(OUT/filename,quality=87,optimize=True)
    sheets.append({'filename':filename,'episodeCodes':[x['creator']+' '+x['code'] for x in group]})

byID=collections.defaultdict(list)
for r in results:byID[r['tvdbEpisodeId']].append(r)
for entry in flags:
    arr=byID[entry['tvdbEpisodeId']]
    original=next(r for r in arr if r['originallySelected'])
    for r in arr:
        r['sameFileAsSelected']=(r.get('sha256')==original.get('sha256') if r.get('sha256') else None)
summary={'createdAt':datetime.now(timezone.utc).isoformat(),
    'mode':'READ_ONLY_SAME_YOUTUBE_VIDEO_ALTERNATE_VARIANTS',
    'flaggedEpisodes':35,'originalApprovedPreserved':192,
    'blockedVisible':sum(f['visualTriage']=='BLOCK' for f in flags),
    'reviewNeeded':sum(f['visualTriage']=='REVIEW' for f in flags),
    'candidateVariantChecks':len(results),
    'availableImages':sum(r['status']=='SOURCE_OK' for r in results),
    'newAlternativeFramesDifferingFromSelected':sum(r['status']=='SOURCE_OK' and not r['originallySelected'] and r['sameFileAsSelected'] is False for r in results),
    'contactSheets':len(sheets),
    'tvdbWrites':0,'editoriallyApprovedAlternatives':0}
out={'summary':summary,'flags':flags,'sheets':sheets,'rows':results,
    'safety':{'originalManifestUnchanged':True,'noUploads':True,'noImageEdits':True,'noAccountBypass':True,
              'allAlternativeVariantsRequireVisualAndProvenanceCheck':True}}
(OUT/'report.json').write_text(json.dumps(out,indent=2,ensure_ascii=False)+'\n')
(OUT/'summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n')
print('ALTERNATES_SUMMARY='+json.dumps(summary,ensure_ascii=False))
