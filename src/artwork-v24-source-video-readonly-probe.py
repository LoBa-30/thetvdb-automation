#!/usr/bin/env python3
"""Public YouTube video metadata-only availability check for unresolved episode stills.
No account login, downloads, evasions, retries, or TheTVDB access.
"""
import json,subprocess,datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'reports/artwork-v24-source-video-readonly-probe'
OUT.mkdir(parents=True,exist_ok=True)
manifest=json.loads((ROOT/'reports/artwork-user-approvals-v23-2-2026-10-09.json').read_text())
target={x['creator']+'|'+x['code']:x for x in manifest['targets']}
samples=['Djilsi|S2019E11','Raska|S2018E03','Mastu|S2016E01']
rows=[]
for key in samples:
  x=target[key]
  cmd=['yt-dlp','--no-playlist','--skip-download','--no-cache-dir','--no-warnings',
       '--print','%(id)s|%(duration)s|%(title)s','https://www.youtube.com/watch?v='+x['youtubeId']]
  try:
    p=subprocess.run(cmd,capture_output=True,text=True,timeout=65,check=False)
    result={'creator':x['creator'],'code':x['code'],'youtubeId':x['youtubeId'],
      'exitCode':p.returncode,
      'status':'METADATA_READABLE' if p.returncode==0 else 'SOURCE_UNAVAILABLE_DO_NOT_RETRY',
      'summary':p.stdout.strip()[:350] if p.returncode==0 else None,
      'error':p.stderr.strip()[-1000:] if p.returncode else None}
  except subprocess.TimeoutExpired:
    result={'creator':x['creator'],'code':x['code'],'youtubeId':x['youtubeId'],
      'status':'SOURCE_TIMEOUT_DO_NOT_RETRY'}
  rows.append(result)
report={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
'operation':'ANONYMOUS_METADATA_ONLY_ONE_PASS','siteWrites':0,
'noAuthentication':True,'noBypass':True,'noVideoDownloads':True,'results':rows}
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print('YOUTUBE_SOURCE_PROBE='+json.dumps(rows,ensure_ascii=False))
