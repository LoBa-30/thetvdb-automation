#!/usr/bin/env python3
"""Contact sheet for only four confirmed missing artwork uploads, read-only."""
import json,base64,io,textwrap
from pathlib import Path
from urllib.request import urlopen, Request
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'reports/artwork-user-approvals-v23-2-2026-10-09.json'
LIVE=ROOT/'reports/artwork-user192-live-preflight-v23-2/report.json'
OUT=ROOT/'reports/artwork-user192-visual-canary-v23-2'
OUT.mkdir(parents=True,exist_ok=True)
manifest=json.loads(SRC.read_text())
live=json.loads(LIVE.read_text())
ids=[x['id'] for x in live['checked'] if x['status']=='STILL_MISSING_IDENTITY_VERIFIED']
assert len(ids)==4,ids
items={x['tvdbEpisodeId']:x for x in manifest['targets']}
sheet=Image.new('RGB',(1040,760),'#111827')
draw=ImageDraw.Draw(sheet)
entries=[]
for i,id in enumerate(ids):
    x=items[id];url=x['selectedImageUrl']
    with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=25) as r:
       if r.status!=200:raise ValueError(str(r.status))
       data=r.read()
    im=Image.open(io.BytesIO(data)).convert('RGB')
    if im.size!=(1280,720):raise ValueError('Unexpected frame size '+repr(im.size))
    thumb=im.resize((500,281),Image.Resampling.LANCZOS)
    left=10+(i%2)*520; top=12+(i//2)*375
    sheet.paste(thumb,(left,top))
    lines=[x['creator']+' — '+x['code'],x['episodeTitle'][:57],
        'TVDB '+str(x['tvdbEpisodeId'])+' | YT '+x['youtubeId']+' | '+x['selectedImageVariant']]
    for li,t in enumerate(lines):draw.text((left+3,top+286+li*21),t,fill='#ffffff')
    entries.append({'creator':x['creator'],'code':x['code'],'tvdbEpisodeId':id,
        'selectedImageUrl':url,'imageSize':list(im.size)})
bio=io.BytesIO()
sheet.save(bio,format='JPEG',quality=82,optimize=True)
(OUT/'contact-sheet.jpg.base64.txt').write_text(base64.b64encode(bio.getvalue()).decode()+'\n')
(OUT/'report.json').write_text(json.dumps({'status':'VISUAL_INSPECTION_REQUIRED',
 'imageCount':len(entries),'entries':entries,'siteWrites':0,'contactSheetBytes':len(bio.getvalue())},indent=2,ensure_ascii=False)+'\n')
print(f"saved {len(entries)} thumbnails ({len(bio.getvalue())} JPEG bytes). No uploads.")
