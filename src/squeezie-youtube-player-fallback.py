import json,re,os,urllib.request,concurrent.futures,threading,time
ROOT='reports/squeezie-deep'
BASE=os.path.join(ROOT,'youtube-player-metadata.ndjson')
OUT=os.path.join(ROOT,'youtube-player-fallback.ndjson')
def get_text(url):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Accept-Language':'fr-FR,fr;q=0.9'})
    with urllib.request.urlopen(req,timeout=30) as r:return r.read().decode('utf-8','replace')
home=get_text('https://www.youtube.com/')
key=re.search(r'"INNERTUBE_API_KEY":"([^"]+)"',home).group(1)
visitor=(re.search(r'"VISITOR_DATA":"([^"]+)"',home) or [None,None])[1]
api='https://www.youtube.com/youtubei/v1/player?key='+key
clients=[
 ('ANDROID_VR','1.60.19'),
 ('WEB_EMBEDDED_PLAYER','1.20261001.00.00'),
 ('TVHTML5','7.20261001'),
 ('IOS','20.39.1'),
 ('MWEB','2.20261001.01.00'),
 ('ANDROID','20.39.37')
]
rows=[]
with open(BASE,encoding='utf-8') as f:
    for line in f:
        if line.strip(): rows.append(json.loads(line))
failed=[r for r in rows if not r.get('ok')]
print('failed base',len(failed),flush=True)
def one(videoId,name,ver):
    client={'clientName':name,'clientVersion':ver,'hl':'fr','gl':'FR'}
    if visitor: client['visitorData']=visitor
    body=json.dumps({'context':{'client':client},'videoId':videoId,'contentCheckOk':True,'racyCheckOk':True}).encode()
    req=urllib.request.Request(api,data=body,headers={'User-Agent':'Mozilla/5.0','Content-Type':'application/json','Origin':'https://www.youtube.com'})
    with urllib.request.urlopen(req,timeout=25) as resp:data=json.loads(resp.read().decode('utf-8','replace'))
    vd=data.get('videoDetails') or {}; mf=((data.get('microformat') or {}).get('playerMicroformatRenderer') or {}); ps=data.get('playabilityStatus') or {}
    return {'id':videoId,'title':vd.get('title'),'publishDate':mf.get('publishDate'),'uploadDate':mf.get('uploadDate'),
      'lengthSeconds':int(vd['lengthSeconds']) if str(vd.get('lengthSeconds','')).isdigit() else None,'channelId':vd.get('channelId'),
      'author':vd.get('author'),'isLiveContent':vd.get('isLiveContent'),'playability':ps.get('status'),'reason':ps.get('reason'),
      'clientUsed':name,'ok':bool(vd.get('title') and mf.get('publishDate'))}
def fetch(r):
    errors=[]
    for name,ver in clients:
      try:
        x=one(r['id'],name,ver)
        if x['ok']: return {**r,**x}
        errors.append(name+':'+str(x.get('reason') or x.get('playability')))
      except Exception as e: errors.append(name+':'+str(e)[:80])
    return {**r,'fallbackErrors':errors}
res=[None]*len(failed)
def job(iv):i,r=iv;return i,fetch(r)
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    for n,(i,r) in enumerate(ex.map(job,enumerate(failed)),1):
        res[i]=r
        if n%100==0:print('fallback',n,'/',len(failed),flush=True)
with open(OUT,'w',encoding='utf-8') as f:
    for r in res:f.write(json.dumps(r,ensure_ascii=False)+'\n')
summary={'attempted':len(res),'recovered':sum(1 for r in res if r.get('ok')),'stillFailed':sum(1 for r in res if not r.get('ok')),
 'byClient':{}}
for r in res:
    if r.get('ok'):summary['byClient'][r.get('clientUsed')]=summary['byClient'].get(r.get('clientUsed'),0)+1
with open(os.path.join(ROOT,'youtube-player-fallback-summary.json'),'w',encoding='utf-8') as f:json.dump(summary,f,ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
