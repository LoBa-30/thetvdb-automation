import json, os, re, hashlib, io, unicodedata, urllib.request
from collections import defaultdict
from PIL import Image, ImageStat
import imagehash

ROOT='reports'
ART=os.path.join(ROOT,'squeezie-artwork','artwork-presence.json')
YT=os.path.join(ROOT,'squeezie-deep','youtube-full.ndjson')
if not os.path.exists(YT):
    YT=os.path.join(ROOT,'squeezie-deep','youtube-flat.ndjson')
OUT=os.path.join(ROOT,'squeezie-artwork')
os.makedirs(OUT,exist_ok=True)

def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=''.join(c for c in s if not unicodedata.combining(c)).lower()
    s=s.replace('’',"'").replace('‘',"'")
    return re.sub(r'\s+',' ',s).strip()

def get(url, timeout=30):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req,timeout=timeout) as r:
        return r.read()

with open(ART,encoding='utf-8') as f: art=json.load(f)
yt=[]
with open(YT,encoding='utf-8') as f:
    for line in f:
        if line.strip():
            try: yt.append(json.loads(line))
            except: pass

title_map=defaultdict(list)
for v in yt:
    if v.get('id') and v.get('title'):
        title_map[norm(v['title'])].append(v)

rows=[]
for ep in art['episodes']:
    if not ep.get('hasImage'): continue
    rec={k:ep.get(k) for k in ('season','episode','code','title','url')}
    rec['artworkUrl']=(ep.get('images') or [None])[0]
    candidates=title_map.get(norm(ep.get('title','')),[])
    rec['youtubeId']=candidates[0].get('id') if len(candidates)==1 else None
    rec['youtubeTitle']=candidates[0].get('title') if len(candidates)==1 else None
    rec['titleMapCount']=len(candidates)
    try:
        b=get(rec['artworkUrl'])
        rec['artworkBytesMd5']=hashlib.md5(b).hexdigest()
        im=Image.open(io.BytesIO(b)).convert('RGB')
        rec['width'],rec['height']=im.size
        rec['aspect']=round(im.width/im.height,4) if im.height else None
        rec['phash']=str(imagehash.phash(im))
        rec['brightness']=round(sum(ImageStat.Stat(im.resize((64,64))).mean)/3,2)
        rec['tooSmall']=im.width<640 or im.height<360
        rec['wrongAspect']=abs((im.width/im.height)-(16/9))>0.03 if im.height else True
    except Exception as e:
        rec['artworkError']=str(e)
        rows.append(rec); continue
    rec['thumbnailComparisons']=[]
    if rec['youtubeId']:
        for kind,u in [
            ('maxres',f"https://i.ytimg.com/vi/{rec['youtubeId']}/maxresdefault.jpg"),
            ('sd',f"https://i.ytimg.com/vi/{rec['youtubeId']}/sddefault.jpg"),
            ('hq',f"https://i.ytimg.com/vi/{rec['youtubeId']}/hqdefault.jpg"),
        ]:
            try:
                tb=get(u)
                ti=Image.open(io.BytesIO(tb)).convert('RGB')
                dist=imagehash.phash(im)-imagehash.phash(ti)
                rec['thumbnailComparisons'].append({'kind':kind,'url':u,'distance':int(dist),'width':ti.width,'height':ti.height})
            except Exception as e:
                pass
        d=[x['distance'] for x in rec['thumbnailComparisons']]
        rec['bestThumbnailPHashDistance']=min(d) if d else None
        rec['confirmedOfficialThumbnail']=bool(d and min(d)<=4)
    else:
        rec['confirmedOfficialThumbnail']=False
    rows.append(rec)

hash_groups=defaultdict(list)
for r in rows:
    if r.get('phash'): hash_groups[r['phash']].append(r['code'])
duplicate_groups={h:codes for h,codes in hash_groups.items() if len(codes)>1}
for r in rows:
    r['duplicateSamePHashCodes']=duplicate_groups.get(r.get('phash'),[])

summary={'generatedAt':__import__('datetime').datetime.utcnow().isoformat()+'Z',
         'existingImages':len(rows),
         'exactYoutubeTitleMapped':sum(1 for r in rows if r.get('youtubeId')),
         'confirmedOfficialThumbnail':sum(1 for r in rows if r.get('confirmedOfficialThumbnail')),
         'notThumbnailOrUnconfirmed':sum(1 for r in rows if not r.get('confirmedOfficialThumbnail')),
         'tooSmall':sum(1 for r in rows if r.get('tooSmall')),
         'wrongAspect':sum(1 for r in rows if r.get('wrongAspect')),
         'darkBelow35':sum(1 for r in rows if isinstance(r.get('brightness'),(int,float)) and r['brightness']<35),
         'duplicatePHashGroups':len(duplicate_groups),
         'duplicatePHashGroupsDetail':duplicate_groups,
         'bySeason':{},'images':rows}
for season in range(2011,2027):
    s=[r for r in rows if r['season']==season]
    summary['bySeason'][str(season)]={
        'existing':len(s),
        'mapped':sum(1 for r in s if r.get('youtubeId')),
        'thumbnailConfirmed':sum(1 for r in s if r.get('confirmedOfficialThumbnail')),
        'originUnconfirmed':sum(1 for r in s if not r.get('confirmedOfficialThumbnail')),
        'tooSmall':sum(1 for r in s if r.get('tooSmall')),
        'wrongAspect':sum(1 for r in s if r.get('wrongAspect')),
    }

with open(os.path.join(OUT,'artwork-provenance.json'),'w',encoding='utf-8') as f: json.dump(summary,f,ensure_ascii=False,indent=2)
lines=['# Squeezie — provenance/qualité des images existantes','','Généré: '+summary['generatedAt'],
f"Images existantes contrôlées: {summary['existingImages']}",
f"Épisodes reliés de façon exacte à une vidéo YouTube: {summary['exactYoutubeTitleMapped']}",
f"Images confirmées comme miniature officielle de CETTE vidéo (pHash très proche): {summary['confirmedOfficialThumbnail']}",
f"Images qui ne sont pas la miniature ou dont l'origine reste à confirmer par comparaison avec le contenu vidéo: {summary['notThumbnailOrUnconfirmed']}",
f"Images sous 640×360: {summary['tooSmall']}",f"Images hors ratio 16:9: {summary['wrongAspect']}",
f"Groupes de doublons visuels exacts (pHash identique): {summary['duplicatePHashGroups']}",'']
for season in range(2011,2027):
    s=summary['bySeason'][str(season)]
    if s['existing']:
        lines.append(f"- {season}: {s['existing']} images; {s['mapped']} vidéos mappées; {s['thumbnailConfirmed']} miniatures confirmées; {s['originUnconfirmed']} origines à confirmer; {s['tooSmall']} trop petites; {s['wrongAspect']} mauvais ratio")
lines += ['','NB: une image non identique à la miniature officielle peut être une capture valide tirée de la vidéo. Elle n’est donc pas déclarée incorrecte sans vérification de frame.']
with open(os.path.join(OUT,'ARTWORK_PROVENANCE.md'),'w',encoding='utf-8') as f: f.write('\n'.join(lines))
print('\n'.join(lines))
