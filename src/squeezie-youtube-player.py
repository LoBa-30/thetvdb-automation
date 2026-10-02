import json,re,os,urllib.request,concurrent.futures,time
ROOT='reports/squeezie-deep'
IN=os.path.join(ROOT,'youtube-flat.ndjson')
OUT=os.path.join(ROOT,'youtube-player-metadata.ndjson')

def get_text(url):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Accept-Language':'fr-FR,fr;q=0.9'})
    with urllib.request.urlopen(req,timeout=30) as r:
        return r.read().decode('utf-8','replace')

home=get_text('https://www.youtube.com/')
def grab(pat,default=None):
    m=re.search(pat,home)
    return m.group(1) if m else default
key=grab(r'"INNERTUBE_API_KEY":"([^"]+)"')
version=grab(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"','2.20261001.00.00')
visitor=grab(r'"VISITOR_DATA":"([^"]+)"')
if not key: raise SystemExit('No INNERTUBE_API_KEY found')
print('clientVersion',version,'visitor',bool(visitor),flush=True)

rows=[]
with open(IN,encoding='utf-8') as f:
  for line in f:
    if line.strip():
      try:
        v=json.loads(line)
        if v.get('id'): rows.append(v)
      except: pass

api='https://www.youtube.com/youtubei/v1/player?key='+key
base_client={'clientName':'WEB','clientVersion':version,'hl':'fr','gl':'FR'}
if visitor: base_client['visitorData']=visitor

def fetch(v):
    body=json.dumps({'context':{'client':base_client},'videoId':v['id'],'contentCheckOk':True,'racyCheckOk':True}).encode()
    req=urllib.request.Request(api,data=body,headers={
      'User-Agent':'Mozilla/5.0','Content-Type':'application/json','Accept-Language':'fr-FR,fr;q=0.9',
      'Origin':'https://www.youtube.com'
    })
    try:
      with urllib.request.urlopen(req,timeout=30) as r:
        data=json.loads(r.read().decode('utf-8','replace'))
      vd=data.get('videoDetails') or {}
      mf=((data.get('microformat') or {}).get('playerMicroformatRenderer') or {})
      ps=data.get('playabilityStatus') or {}
      return {
        'id':v['id'],'url':'https://www.youtube.com/watch?v='+v['id'],
        'playlistTitle':v.get('title'),'title':vd.get('title'),
        'publishDate':mf.get('publishDate'),'uploadDate':mf.get('uploadDate'),
        'lengthSeconds':int(vd['lengthSeconds']) if str(vd.get('lengthSeconds','')).isdigit() else None,
        'channelId':vd.get('channelId'),'author':vd.get('author'),
        'isLiveContent':vd.get('isLiveContent'),'isLive':vd.get('isLive'),
        'shortDescription':vd.get('shortDescription'),
        'playability':ps.get('status'),'reason':ps.get('reason'),
        'thumbnail':((vd.get('thumbnail') or {}).get('thumbnails') or [{}])[-1].get('url'),
        'ok':bool(vd.get('title') and mf.get('publishDate'))
      }
    except Exception as e:
      return {'id':v['id'],'url':'https://www.youtube.com/watch?v='+v['id'],'playlistTitle':v.get('title'),'ok':False,'error':str(e)}

res=[None]*len(rows)
def job(iv): i,v=iv; return i,fetch(v)
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
    for n,(i,r) in enumerate(ex.map(job,enumerate(rows)),1):
        res[i]=r
        if n%100==0: print('player',n,'/',len(rows),flush=True)

with open(OUT,'w',encoding='utf-8') as f:
    for r in res: f.write(json.dumps(r,ensure_ascii=False)+'\n')
summary={
 'count':len(res),'ok':sum(1 for r in res if r.get('ok')),
 'withPublishDate':sum(1 for r in res if r.get('publishDate')),
 'withDuration':sum(1 for r in res if r.get('lengthSeconds') is not None),
 'playable':sum(1 for r in res if r.get('playability')=='OK'),
 'failed':sum(1 for r in res if not r.get('ok')),
 'channelIds':sorted(set(r.get('channelId') for r in res if r.get('channelId'))),
 'apiClientVersion':version
}
with open(os.path.join(ROOT,'youtube-player-summary.json'),'w',encoding='utf-8') as f:
    json.dump(summary,f,ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
