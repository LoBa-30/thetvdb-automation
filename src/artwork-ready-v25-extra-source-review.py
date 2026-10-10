#!/usr/bin/env python3
"""Three extra same-video suggestions: immutable source verification ONLY.
No TheTVDB connection, no upload, no editing, no automatic editorial approval.
"""
import hashlib, io, json, datetime
from pathlib import Path
from urllib.request import urlopen, Request
from PIL import Image, ImageOps, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'reports/artwork-ready-v25-extra-source-review'
OUT.mkdir(parents=True,exist_ok=True)
manifest=json.loads((ROOT/'reports/artwork-user-approvals-v23-2-2026-10-09.json').read_text())
targets={t['tvdbEpisodeId']:t for t in manifest['targets']}
suggestions=[
  {'episodeId':'11960801','variant':'maxres2','reason':'Raska S2023E06: scene without +10 EUR overlay in prior contact sheet'},
  {'episodeId':'10970002','variant':'maxres2','reason':'Mastu S2025E03: second option without 20,000 EUR subtitle'},
  {'episodeId':'11696621','variant':'maxres3','reason':'Maxime Biaggi S2024E02: natural scene without artificial flower graphics'}
]
assert len(targets)==192 and len(manifest['permanentlyExcluded'])==25
assert len(suggestions)==3
records=[]
canvas=Image.new('RGB',(1280,3*300),'#141923')
draw=ImageDraw.Draw(canvas)
try: font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',19)
except OSError: font=ImageFont.load_default()
for i,s in enumerate(suggestions):
    t=targets[s['episodeId']]
    assert s['variant']!=t['selectedImageVariant']
    url=f'https://i.ytimg.com/vi/{t["youtubeId"]}/{s["variant"]}.jpg'
    with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=25) as resp:
        if resp.status!=200: raise RuntimeError('source inaccessible')
        data=resp.read(10_000_001)
    if len(data)>10_000_000: raise RuntimeError('source too large')
    image=ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')
    w,h=image.size
    if w<640 or h<360 or abs(w/h-16/9)>0.025:raise RuntimeError('source geometry mismatch')
    file=f'{t["creator"].lower().replace(" ","-")}-{t["code"].lower()}-{s["variant"]}.jpg'
    (OUT/file).write_bytes(data)
    canvas.paste(ImageOps.fit(image,(480,270)),(0,i*300+5))
    draw.text((500,i*300+55),t['creator']+' '+t['code'],font=font,fill='#ffffff')
    draw.text((500,i*300+85),'ORIGINAL: '+t['selectedImageVariant'],font=font,fill='#facc86')
    draw.text((500,i*300+120),'ADDITIONAL: '+s['variant'],font=font,fill='#b4e6ff')
    draw.text((500,i*300+155),'CANDIDATE ONLY - NO UPLOAD',font=font,fill='#f4aaaa')
    records.append({'creator':t['creator'],'code':t['code'],'episodeId':t['tvdbEpisodeId'],
      'youtubeId':t['youtubeId'],'originalSelectedVariant':t['selectedImageVariant'],
      'candidateVariant':s['variant'],'url':url,'reason':s['reason'],
      'sha256':hashlib.sha256(data).hexdigest(),'width':w,'height':h,
      'bytes':len(data),'filename':file,'editorialApproval':False,
      'userApprovedVariantChange':False,'uploadReady':False})
canvas.save(OUT/'contact-sheet.jpg',quality=90,optimize=True)
report={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'mode':'READ_ONLY_UNMODIFIED_YOUTUBE_SOURCE_ALTERNATIVES',
  'records':records,'safety':{'tvdbWrites':0,'artworkUploads':0,'originalManifestUnchanged':True}}
(OUT/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
print('EXTRA_V25='+json.dumps({'checked':len(records),'sourceOK':len(records),'uploads':0}))
