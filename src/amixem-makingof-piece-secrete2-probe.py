import json, subprocess, pathlib, datetime
OUT=pathlib.Path('reports/amixem-makingof-piece-secrete2-probe')
OUT.mkdir(parents=True,exist_ok=True)
vid='M93zTCxjqp8'
cmd=['yt-dlp','--dump-single-json','--no-warnings','--skip-download',f'https://www.youtube.com/watch?v={vid}']
p=subprocess.run(cmd,text=True,capture_output=True)
report={'generatedAt':datetime.datetime.utcnow().isoformat()+'Z','target':'Amixem Unassigned 10857946','youtubeId':vid,'returncode':p.returncode}
if p.returncode==0:
    d=json.loads(p.stdout)
    report['youtube']={
      'id':d.get('id'),'title':d.get('title'),'upload_date':d.get('upload_date'),
      'timestamp':d.get('timestamp'),'duration_seconds':d.get('duration'),
      'channel':d.get('channel'),'channel_id':d.get('channel_id'),
      'availability':d.get('availability'),'webpage_url':d.get('webpage_url'),
      'live_status':d.get('live_status')
    }
    report['result']='METADATA_RETRIEVED'
else:
    report['stderr']=p.stderr[-4000:]
    report['result']='METADATA_BLOCKED'
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
