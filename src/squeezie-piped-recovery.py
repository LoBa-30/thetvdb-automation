import json, os, urllib.request, concurrent.futures, ssl, time
ROOT='reports/squeezie-deep'
IN=os.path.join(ROOT,'youtube-player-fallback.ndjson')
OUT=os.path.join(ROOT,'youtube-piped-recovery.ndjson')
INSTANCES=[
 'https://pipedapi.leptons.xyz',
 'https://pipedapi.nosebs.ru',
 'https://pipedapi.kavin.rocks',
 'https://api-piped.mha.fi',
 'https://piped-api.garudalinux.org'
]
rows=[]
with open(IN,encoding='utf-8') as f:
  for line in f:
    if line.strip():
      x=json.loads(line)
      if not x.get('ok'): rows.append(x)

def fetch_one(r):
  errs=[]
  for base in INSTANCES:
    try:
      req=urllib.request.Request(base+'/streams/'+r['id'],headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
      with urllib.request.urlopen(req,timeout=25) as resp:
        if resp.status!=200: raise Exception('HTTP '+str(resp.status))
        d=json.loads(resp.read().decode('utf-8','replace'))
      title=d.get('title'); date=d.get('uploadDate'); dur=d.get('duration')
      uploader=d.get('uploader'); uploaderUrl=d.get('uploaderUrl')
      ok=bool(title and date and isinstance(dur,(int,float)) and dur>0)
      if ok:
        return {'id':r['id'],'playlistTitle':r.get('playlistTitle'),'title':title,'publishDate':date,
          'lengthSeconds':int(dur),'uploader':uploader,'uploaderUrl':uploaderUrl,
          'thumbnailUrl':d.get('thumbnailUrl'),'livestream':d.get('livestream'),
          'sourceInstance':base,'ok':True}
      errs.append(base+':missing-fields')
    except Exception as e: errs.append(base+':'+str(e)[:120])
  return {'id':r['id'],'playlistTitle':r.get('playlistTitle'),'ok':False,'errors':errs}

out=[None]*len(rows)
def job(iv):i,r=iv;return i,fetch_one(r)
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
  for n,(i,x) in enumerate(ex.map(job,enumerate(rows)),1):
    out[i]=x
    if n%25==0:print('piped',n,'/',len(rows),flush=True)
with open(OUT,'w',encoding='utf-8') as f:
  for x in out:f.write(json.dumps(x,ensure_ascii=False)+'\n')
summary={'attempted':len(out),'recovered':sum(1 for x in out if x.get('ok')),'failed':sum(1 for x in out if not x.get('ok')),'byInstance':{}}
for x in out:
  if x.get('ok'): summary['byInstance'][x['sourceInstance']]=summary['byInstance'].get(x['sourceInstance'],0)+1
with open(os.path.join(ROOT,'youtube-piped-summary.json'),'w',encoding='utf-8') as f:json.dump(summary,f,ensure_ascii=False,indent=2)
print(json.dumps(summary,ensure_ascii=False,indent=2))
