#!/usr/bin/env python3
"""Read-only editorial triage/contact sheets of user-selected TheTVDB artwork.
Never uploads, alters choices, or infers that image dimensions imply editorial compliance.
"""
from __future__ import annotations
import concurrent.futures, collections, hashlib, io, json, re, textwrap
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/'reports/artwork-user-approvals-v23-2-2026-10-09.json'
MASTU=ROOT/'reports/artwork-mastu-97-prior-source-crosscheck-v23-2-2026-10-09.json'
HASHES=ROOT/'reports/artwork-mastu-variant-hash-reconciliation-v23-6-2026-10-09.json'
OUT=ROOT/'reports/artwork-user192-editorial-triage-v24-2026-10-10'
OUT.mkdir(parents=True,exist_ok=True)
manifest=json.loads(MANIFEST.read_text())
cross=json.loads(MASTU.read_text())
hashrep=json.loads(HASHES.read_text())
targets=manifest['targets']
exclusions=manifest['permanentlyExcluded']
hold=manifest['separateHold']
assert len(targets)==192 and len(exclusions)==25
assert hold['tvdbEpisodeId']=='11960844'
assert len({t['tvdbEpisodeId'] for t in targets})==192
assert all(t['userApproved'] is True for t in targets)
assert all(t['technicalAndEditorialValidation']=='PENDING' for t in targets)
assert not set(t['tvdbEpisodeId'] for t in targets)&set(x['tvdbEpisodeId'] for x in exclusions)
assert hold['tvdbEpisodeId'] not in {t['tvdbEpisodeId'] for t in targets}
assert all(t['selectedImageUrl'].endswith('/'+t['selectedImageVariant']+'.jpg') for t in targets)
assert all('/'+t['youtubeId']+'/' in t['selectedImageUrl'] for t in targets)
assert all(t['selectedImageVariant'] in ('maxres1','maxres2','maxres3') for t in targets)
assert len({t['selectedImageUrl'] for t in targets})==len(targets)
assert len({t['youtubeId'] for t in targets})==len(targets)
mastu_index={i['tvdbEpisodeId']:i for i in cross['items']}
no_prior={str(x['id']) for x in cross['summary']['noEarlierReport']}
explicit_flags={
  '11960879':'Historical example: Raska S2020E18 had a subscribe/banner overlay; selected variant must be checked independently.',
  '11960803':'Historical example: Raska S2023E08 had a timer overlay; selected variant must be checked independently.',
  '11696610':'Historical example: Maxime Biaggi S2023E08 had logos across three variants.',
  '11960842':'Historical example: Raska S2018E03 had a TEMA logo; check exact selected frame.',
  '8082821':'Historical example: Mastu S2020E35 had TikTok watermark on historic variant.',
  '8571340':'Historical example: Mastu S2021E19 had yellow subtitles on an older variant.',
  '9195558':'Mastu S2016E01: prior candidate reports flagged text/date overlay.',
  '11960872':'Raska S2020E09: historic review warned about text on an in-scene screen.',
}
font_path='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
try:
  font=ImageFont.truetype(font_path,15)
  font_small=ImageFont.truetype(font_path,13)
except OSError:
  font=ImageFont.load_default()
  font_small=font

def download(rec):
  x=rec
  meta={'creator':x['creator'],'code':x['code'],'tvdbEpisodeId':str(x['tvdbEpisodeId']),
        'youtubeId':x['youtubeId'],'selectedImageVariant':x['selectedImageVariant'],
        'selectedImageUrl':x['selectedImageUrl'],'sourceProvenance':x.get('provenanceVerified'),
        'userApproved':True,'uploadReady':False,
        'visualCompliance':'NOT_CERTIFIED',
        'userSelectedVariantPreserved':True,'historicalConcerns':[]}
  cross_item=mastu_index.get(meta['tvdbEpisodeId']) if x['creator']=='Mastu' else None
  if meta['tvdbEpisodeId'] in no_prior: meta['historicalConcerns'].append('MASTU_NO_EARLIER_REPORT')
  if cross_item:
    for p in cross_item.get('priorRefs',[]):
      if p.get('visuallyBlocked') or str(p.get('sourceStatus','')).startswith('BLOCKED'):
        meta['historicalConcerns'].append('HISTORICAL_SOURCE_FLAG: '+p['sourceStatus'])
  if meta['tvdbEpisodeId'] in explicit_flags:
    meta['historicalConcerns'].append(explicit_flags[meta['tvdbEpisodeId']])
  if x.get('provenanceVerified') is not True:
    meta['historicalConcerns'].append('EPISODE_SOURCE_PROVENANCE_NOT_CERTIFIED')
  try:
    with urlopen(Request(x['selectedImageUrl'],headers={'User-Agent':'Mozilla/5.0 (artwork read-only audit)'}),timeout=25) as r:
      if r.status != 200: raise RuntimeError('HTTP_'+str(r.status))
      data=r.read(10_000_001)
    if len(data)>=10_000_000: raise RuntimeError('OVER_10_MB')
    image=ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')
    w,h=image.size
    meta.update({'sourceHttp':200,'width':w,'height':h,'sourceBytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    if w<640 or h<360 or abs(w/h-16/9)>.025: raise RuntimeError('GEOMETRY_NOT_16_9_OR_TOO_SMALL')
    meta['technicalCompliance']='PASS_DIMENSIONS_SIZE_DECODE_ONLY'
    return meta,image
  except (Exception,) as e:
    meta['technicalCompliance']='BLOCKED_'+str(e)[:120]
    return meta,None

results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
  for r in pool.map(download,targets):
    results.append(r)
images_by_id={m['tvdbEpisodeId']:im for m,im in results if im is not None}
items=[m for m,_ in results]
assert len(items)==192
seen_hash=collections.defaultdict(list)
for m in items:
  if m.get('sha256'):seen_hash[m['sha256']].append(m['tvdbEpisodeId'])
duplicates={k:v for k,v in seen_hash.items() if len(v)>1}
for m in items:
  if m.get('sha256') in duplicates:
    m['historicalConcerns'].append('DUPLICATE_IDENTICAL_SOURCE_BYTES')
# Hard holds do not mean selected variant is proven noncompliant; they mean it needs inspection.
for m in items:
  if m['technicalCompliance'].startswith('BLOCKED_'):
    m['triage']='SOURCE_TECHNICAL_BLOCK'
  elif m['historicalConcerns']:
    m['triage']='PRIORITY_VISUAL_AND_PROVENANCE_REVIEW'
  else:
    m['triage']='VISUAL_REVIEW_REQUIRED'
  m['editorialApproved']=False
  m['uploadReady']=False

def draw_sheet(group,index,slice_items):
  cols=4;tw=312; th=175; cell_w=338;cell_h=252
  rows=(len(slice_items)+cols-1)//cols
  canvas=Image.new('RGB',(cols*cell_w,rows*cell_h),'#101827')
  draw=ImageDraw.Draw(canvas)
  for i,m in enumerate(slice_items):
    x=(i%cols)*cell_w+12;y=(i//cols)*cell_h+8
    im=images_by_id.get(m['tvdbEpisodeId'])
    if im is not None:
      thumb=ImageOps.fit(im,(tw,th),method=Image.Resampling.LANCZOS)
      canvas.paste(thumb,(x,y))
    else:
      draw.rectangle((x,y,x+tw,y+th),fill='#603737')
      draw.text((x+12,y+74),'SOURCE UNAVAILABLE',font=font,fill='#ffffff')
    flag='!' if m['historicalConcerns'] else '•'
    line1=f"{flag} {m['creator']} {m['code']} | {m['selectedImageVariant']}"
    draw.text((x,y+180),line1[:53],font=font,fill='#ffcd93' if m['historicalConcerns'] else '#eaf2ff')
    draw.text((x,y+204),f"TVDB {m['tvdbEpisodeId']} | YT {m['youtubeId']}",font=font_small,fill='#b1c3dc')
    draw.text((x,y+225),m['triage'][:39],font=font_small,fill='#dadfe8')
  slug=re.sub(r'[^a-z0-9]+','-',group.lower()).strip('-')
  filename=f'{slug}-{index:02d}.jpg'
  canvas.save(OUT/filename,format='JPEG',quality=84,optimize=True)
  return filename

sheets=[]
for group in ['Djilsi','Raska','Maxime Biaggi','Mastu']:
  subset=[m for m in items if m['creator']==group]
  for k in range(0,len(subset),16):
    part=subset[k:k+16]
    sheet=draw_sheet(group,k//16+1,part)
    sheets.append({'file':sheet,'creator':group,'count':len(part),'first':part[0]['code'],'last':part[-1]['code']})

counts=dict(collections.Counter(m['triage'] for m in items))
by_creator={c:len([m for m in items if m['creator']==c]) for c in ['Djilsi','Raska','Maxime Biaggi','Mastu']}
flags=[{'creator':m['creator'],'code':m['code'],'tvdbEpisodeId':m['tvdbEpisodeId'],
        'variant':m['selectedImageVariant'],'flags':m['historicalConcerns']} for m in items if m['historicalConcerns']]
summary={
 'createdAt':datetime.now(timezone.utc).isoformat(),'mode':'READ_ONLY_EDITORIAL_TRIAGE',
 'baseline':'reports/artwork-user-approvals-v23-2-2026-10-09.json',
 'approvedCandidates':len(items),'excludedNeverUpload':len(exclusions),
 'heldRaskaNeverUpload':hold['tvdbEpisodeId'],
 'creators':by_creator,'statusCounts':counts,'flaggedCount':len(flags),
 'failedTechnical':sum(m['triage']=='SOURCE_TECHNICAL_BLOCK' for m in items),
 'contactSheets':len(sheets),'identicalCandidateFileHashes':len(duplicates),
 'mastusUnmatchedEarlier':len(no_prior),'tvdbWrites':0,
 'editoriallyApproved':0,
 'statement':'Technical checks and sheet generation do NOT certify compliance with TheTVDB art rules.'
}
report={'summary':summary,'flags':flags,'contactSheets':sheets,'items':items,
  'permanentlyExcluded':exclusions,'separateHold':hold,
  'safety':{'noTvdbLogin':True,'noTvdbUploads':True,'noTvdbDeletes':True,
    'noEditsToUserChoices':True,'noAutoArtisticApproval':True,
    'siteRestrictionAssumedActive':True}}
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
(OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
(OUT/'priority_review.json').write_text(json.dumps(flags,ensure_ascii=False,indent=2)+'\n')
(OUT/'README.txt').write_text(
 'CONTACT SHEETS READ-ONLY. Each thumbnail is the exact user-selected variant from the GitHub manifest.\n'
 'An exclamation mark denotes historical provenance/moderation concerns, NOT necessarily a newly confirmed violation.\n'
 'No image is approved to upload. Excluded 25 and blocked Raska S2018E05 are not candidates.\n'
 'Prefer selecting a genuinely clean frame from the correct video rather than retouching or hiding a disallowed title/logo.\n'
 'TheTVDB account restriction remains effective unless independently disproved.\n')
print('EDITORIAL_TRIAGE_SUMMARY='+json.dumps(summary,ensure_ascii=False))
