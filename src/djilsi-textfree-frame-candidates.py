import json,requests,math,hashlib
from pathlib import Path
from io import BytesIO
from PIL import Image,ImageDraw,ImageFont
from datetime import datetime,timezone

SRC=Path('reports/djilsi-visual-artwork-audit-2026-10-07/report.json')
OUT=Path('reports/djilsi-textfree-frame-candidates-2026-10-07')
IMGDIR=OUT/'images'
OUT.mkdir(parents=True,exist_ok=True);IMGDIR.mkdir(parents=True,exist_ok=True)
audit=json.loads(SRC.read_text(encoding='utf-8'))
missing=[e for e in audit.get('episodes',[]) if 'NO_ARTWORK' in (e.get('status') or []) and (e.get('youtube') or {}).get('id')]
S=requests.Session();S.headers.update({'User-Agent':'Mozilla/5.0'})
rows=[]

def fetch(url):
    try:
        r=S.get(url,timeout=25)
        if r.status_code!=200 or len(r.content)<5000:return None
        im=Image.open(BytesIO(r.content)).convert('RGB')
        return r.content,im
    except Exception:return None

for e in missing:
    vid=e['youtube']['id']; item={'code':e['code'],'episodeId':e['episodeId'],'title':e['title'],'youtubeId':vid,'variants':[]}
    for n in (1,2,3):
        url=f'https://i.ytimg.com/vi/{vid}/maxres{n}.jpg'
        got=fetch(url)
        v={'index':n,'url':url,'available':False}
        if got:
            data,im=got
            v.update({'available':True,'width':im.width,'height':im.height,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
            if im.size==(1280,720):
                p=IMGDIR/f"{e['code']}-maxres{n}.jpg";p.write_bytes(data);v['path']=str(p)
        item['variants'].append(v)
    rows.append(item)

# Contact sheets: four episodes/page, one row per episode, 3 candidate frames.
font=ImageFont.load_default()
thumb=(320,180); label_h=46; row_h=thumb[1]+label_h; page_rows=4
sheets=[]
for page_idx in range(math.ceil(len(rows)/page_rows)):
    batch=rows[page_idx*page_rows:(page_idx+1)*page_rows]
    sheet=Image.new('RGB',(thumb[0]*3,row_h*len(batch)),(245,245,245))
    draw=ImageDraw.Draw(sheet)
    for ri,item in enumerate(batch):
        y=ri*row_h
        label=f"{item['code']}  {item['title'][:92]}"
        draw.rectangle((0,y,thumb[0]*3,y+label_h),fill=(255,255,255))
        draw.text((8,y+5),label,fill=(0,0,0),font=font)
        draw.text((8,y+22),f"YouTube {item['youtubeId']}   candidates: 1 / 2 / 3",fill=(70,70,70),font=font)
        for ci,v in enumerate(item['variants']):
            x=ci*thumb[0]
            if v.get('path') and Path(v['path']).exists():
                im=Image.open(v['path']).convert('RGB').resize(thumb,Image.Resampling.LANCZOS)
                sheet.paste(im,(x,y+label_h))
            else:
                draw.rectangle((x,y+label_h,x+thumb[0],y+label_h+thumb[1]),fill=(40,40,40))
                draw.text((x+12,y+label_h+80),f"maxres{ci+1} unavailable",fill=(255,255,255),font=font)
            draw.text((x+5,y+label_h+5),str(ci+1),fill=(255,255,0),font=font)
    sp=OUT/f'contact-{page_idx+1:02d}.jpg';sheet.save(sp,'JPEG',quality=90);sheets.append(str(sp))

summary={
 'generatedAt':datetime.now(timezone.utc).isoformat(),
 'mode':'READ_ONLY_DJILSI_TEXTFREE_FRAME_CANDIDATES',
 'missingEpisodes':len(rows),
 'episodesWithAtLeastOne1280x720':sum(any(v.get('width')==1280 and v.get('height')==720 for v in x['variants']) for x in rows),
 'total1280x720Candidates':sum(sum(v.get('width')==1280 and v.get('height')==720 for v in x['variants']) for x in rows),
 'contactSheets':sheets,
 'rows':rows
}
(OUT/'report.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'summary.txt').write_text(f"missingEpisodes={summary['missingEpisodes']}\nepisodesWithAtLeastOne1280x720={summary['episodesWithAtLeastOne1280x720']}\ntotal1280x720Candidates={summary['total1280x720Candidates']}\n",encoding='utf-8')
print((OUT/'summary.txt').read_text())
