import json, re, os, html, time, concurrent.futures, urllib.request
ROOT='reports/squeezie-deep'
IN=os.path.join(ROOT,'youtube-flat.ndjson')
OUT=os.path.join(ROOT,'youtube-watch-metadata.ndjson')
rows=[]
with open(IN,encoding='utf-8') as f:
    for line in f:
        if line.strip():
            try:
                v=json.loads(line)
                if v.get('id'): rows.append(v)
            except: pass

def fetch(v):
    vid=v['id']; url=f'https://www.youtube.com/watch?v={vid}'
    req=urllib.request.Request(url,headers={
        'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
        'Accept-Language':'en-US,en;q=0.9'
    })
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            text=r.read().decode('utf-8','replace')
        def grab(pat):
            m=re.search(pat,text)
            return m.group(1) if m else None
        title=grab(r'"title":"((?:\\.|[^"\\])*)"')
        if title:
            try: title=json.loads('"'+title+'"')
            except: title=html.unescape(title)
        pub=grab(r'"publishDate":"(\d{4}-\d{2}-\d{2})"')
        upload=grab(r'"uploadDate":"(\d{4}-\d{2}-\d{2})"')
        length=grab(r'"lengthSeconds":"(\d+)"')
        owner=grab(r'"ownerChannelName":"((?:\\.|[^"\\])*)"')
        channel=grab(r'"channelId":"([^"]+)"')
        islive=grab(r'"isLiveContent":(true|false)')
        isshort='"/shorts/' in text[:200000] or '"isShort":true' in text
        return {'id':vid,'url':url,'playlistTitle':v.get('title'),'title':title,'publishDate':pub,'uploadDate':upload,
                'lengthSeconds':int(length) if length else None,'ownerChannelName':owner,'channelId':channel,
                'isLiveContent':islive=='true' if islive else None,'isShortPageSignal':isshort,'ok':bool(title and pub)}
    except Exception as e:
        return {'id':vid,'url':url,'playlistTitle':v.get('title'),'ok':False,'error':str(e)}

res=[None]*len(rows)
def job(pair):
    i,v=pair
    return i,fetch(v)
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
    for n,(i,r) in enumerate(ex.map(job,enumerate(rows)),1):
        res[i]=r
        if n%100==0: print('Fetched',n,'/',len(rows),flush=True)

with open(OUT,'w',encoding='utf-8') as f:
    for r in res:
        f.write(json.dumps(r,ensure_ascii=False)+'\n')
summary={
 'count':len(res),'ok':sum(1 for r in res if r.get('ok')),
 'withPublishDate':sum(1 for r in res if r.get('publishDate')),
 'withDuration':sum(1 for r in res if r.get('lengthSeconds') is not None),
 'failed':sum(1 for r in res if not r.get('ok')),
 'channelIds':sorted(set(r.get('channelId') for r in res if r.get('channelId')))
}
with open(os.path.join(ROOT,'youtube-watch-summary.json'),'w',encoding='utf-8') as f: json.dump(summary,f,ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
