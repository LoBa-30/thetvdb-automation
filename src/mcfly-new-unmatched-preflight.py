import json, subprocess, os
OUT='reports/mcfly-new-video-preflight'
os.makedirs(OUT,exist_ok=True)
vid='QG1WcEWOF4g'
url='https://www.youtube.com/watch?v='+vid
cmd=['yt-dlp','--dump-single-json','--skip-download','--no-warnings',url]
p=subprocess.run(cmd,capture_output=True,text=True,timeout=180)
row={'videoId':vid,'url':url,'returncode':p.returncode,'stderr':p.stderr[-4000:]}
if p.stdout.strip():
    try:
        d=json.loads(p.stdout)
        row.update({
          'title':d.get('title'),'upload_date':d.get('upload_date'),'timestamp':d.get('timestamp'),
          'duration':d.get('duration'),'channel':d.get('channel'),'channel_id':d.get('channel_id'),
          'availability':d.get('availability'),'webpage_url':d.get('webpage_url')
        })
    except Exception as e: row['parse_error']=str(e)
row['reference_date']='2026-09-09'
row['in_scope']=bool(row.get('upload_date') and row['upload_date']<='20260909')
json.dump(row,open(f'{OUT}/report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(json.dumps(row,ensure_ascii=False,indent=2))
if p.returncode!=0 and not row.get('title'): raise SystemExit(2)
