#!/usr/bin/env python3
"""Download original JPEG bytes of 12 non-approved source-faithful alternative frames.
No TheTVDB access, upload, image retouching, or user-variant modification.
"""
import collections,hashlib,io,json
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import Request,urlopen
from PIL import Image,ImageOps,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1]
p=json.loads((ROOT/'reports/artwork-user192-proposed-clean-alternatives-v24-3-2026-10-10.json').read_text())
m=json.loads((ROOT/'reports/artwork-user-approvals-v23-2-2026-10-09.json').read_text())
OUT=ROOT/'reports/artwork-user192-alternative-fullres-v24-3'
OUT.mkdir(parents=True,exist_ok=True)
assert p['proposedCases']==12 and p['originalApprovalsUnchanged']==192
assert len(m['targets'])==192 and len(m['permanentlyExcluded'])==25
idx={x['tvdbEpisodeId']:x for x in m['targets']}
results=[]
thumbs=[]
for x in p['proposals']:
    old=idx[x['tvdbEpisodeId']]
    assert x['userSelectedVariant']==old['selectedImageVariant']
    assert x['userSelectedUrl']==old['selectedImageUrl']
    assert x['youtubeId']==old['youtubeId']
    assert x['suggestedVariant']!=old['selectedImageVariant']
    assert x['suggestedUrl']==f'https://i.ytimg.com/vi/{x["youtubeId"]}/{x["suggestedVariant"]}.jpg'
    with urlopen(Request(x['suggestedUrl'],headers={'User-Agent':'Mozilla/5.0 (read-only artwork source check)'}),timeout=25) as resp:
       if resp.status!=200:raise RuntimeError('Non-200 source HTTP')
       b=resp.read(10_000_001)
    if len(b)>10_000_000:raise RuntimeError('Input exceeds artwork filesize limit')
    im=Image.open(io.BytesIO(b))
    width,height=im.size
    if not (width>=640 and height>=360 and abs(width/height-16/9)<.025):
        raise RuntimeError('Bad dimensions for '+x['tvdbEpisodeId'])
    name=f'{x["creator"].lower().replace(" ","-")}-{x["code"].lower()}-{x["suggestedVariant"]}.jpg'
    (OUT/name).write_bytes(b)
    results.append({'creator':x['creator'],'code':x['code'],'tvdbEpisodeId':x['tvdbEpisodeId'],
        'youtubeId':x['youtubeId'],'suggestedVariant':x['suggestedVariant'],
        'suggestedUrl':x['suggestedUrl'],'preservedOriginalVariant':x['userSelectedVariant'],
        'file':name,'bytes':len(b),'width':width,'height':height,
        'sha256':hashlib.sha256(b).hexdigest(),'visuallyApproved':False,'uploadReady':False})
    thumbs.append((x,ImageOps.fit(im.convert('RGB'),(480,270),method=Image.Resampling.LANCZOS)))
try:
 font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',17)
except OSError:font=ImageFont.load_default()
canvas=Image.new('RGB',(3*506,4*324),'#131a28')
d=ImageDraw.Draw(canvas)
for i,(item,im) in enumerate(thumbs):
  left=(i%3)*506+10;top=(i//3)*324+8
  canvas.paste(im,(left,top))
  d.text((left,top+275),f'{item["creator"]} {item["code"]} — {item["suggestedVariant"]}',font=font,fill='#eef4ff')
  d.text((left,top+296),'PROPOSITION — pas de validation / envoi',font=font,fill='#ffcb7f')
canvas.save(OUT/'alternatives-12-contact.jpg',quality=90,optimize=True)
report={'createdAt':datetime.now(timezone.utc).isoformat(),
 'total':len(results),'technicalFileChecksPassed':len(results),
 'visualApprovalCount':0,'uploadedToTvdb':0,'modifiedOriginalApproval':0,
 'results':results,
 'safety':{'byteExactPublicYouTubeThumbnails':True,'noTvdbSiteAccess':True,
           'noTvdbUploads':True,'noTvdbDeletes':True,'noAutoSubmission':True}}
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print('ALTERNATE_FULLRES='+json.dumps({'count':len(results),'valid':len(results),'uploads':0}))
