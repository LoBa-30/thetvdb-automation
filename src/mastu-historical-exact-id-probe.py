import json,subprocess,pathlib,datetime
OUT=pathlib.Path('reports/mastu-historical-exact-id-probe');OUT.mkdir(parents=True,exist_ok=True)
items=[
 {'case':'S2018E08','id':'qC3EVM_bhoo','expected':'QUAND 2 BEAUFS PRENNENT LA VOITURE'},
 {'case':'S2018E29','id':'kDmn5RBFIS0','expected':"J'ai besoin de vous parler"},
 {'case':'S2018E09','id':'Pyl8mSyLh-g','expected':"J'AI RETROUVÉ DES VIDÉOS HONTEUSES SUR MON TÉLÉPHONE..."},
 {'case':'S2018E12','id':'L3tY9Z9y7yE','expected':'QUI DE NOUS TROIS ? Ft Amixem & VodK'},
 {'case':'S2018E32','id':'9Ky8gLHoFeY','expected':'YouTube va mal...'},
 {'case':'S2018E25','id':'haKY93EGeUs','expected':'JE VAIS ÊTRE HONNÊTE AVEC VOUS...'},
 {'case':'S2018E05','id':'tiCNmB20GjE','expected':"JE N'ARRIVE PAS À JOUER À FORTNITE... (TOP 1 raté)"},
 {'case':'historical-messenger','id':'POCI2ucog7M','expected':'NOS PREMIÈRES CONVERSATIONS MESSENGER'},
 {'case':'S2017E31','id':'XT-M3Z-wnVE','expected':'PROVOQUER UNE ÉMEUTE DE VACHES EN VOITURE'},
 {'case':'S2016E09','id':'IETntwf8F-w','expected':'JE RÉPONDS À VOS QUESTIONS ÉTRANGES...'},
 {'case':'S2019E32','id':'kUuEzvQaP6E','expected':"JE SUIS UN MAUVAIS CITOYEN (La clé de bras m'a fait mal)"},
 {'case':'S2020E34','id':'_YZeqxoPK18','expected':"JE VOUS FAIS VISITER MA MAISON (6 mois après, j'ai un nouveau chaton)"}
]
rows=[]
for x in items:
    p=subprocess.run(['yt-dlp','--dump-single-json','--no-warnings','--skip-download',f"https://www.youtube.com/watch?v={x['id']}"],capture_output=True,text=True,timeout=90)
    row=dict(x);row['returncode']=p.returncode
    if p.returncode==0:
        d=json.loads(p.stdout)
        row.update({'title':d.get('title'),'upload_date':d.get('upload_date'),'timestamp':d.get('timestamp'),'duration_seconds':d.get('duration'),'channel':d.get('channel'),'channel_id':d.get('channel_id'),'availability':d.get('availability'),'live_status':d.get('live_status'),'webpage_url':d.get('webpage_url'),'status':'PRIMARY_METADATA_RETRIEVED'})
    else:
        row.update({'status':'PRIMARY_METADATA_BLOCKED','error':p.stderr[-1200:]})
    rows.append(row)
summary={'total':len(rows),'retrieved':sum(r['status']=='PRIMARY_METADATA_RETRIEVED' for r in rows),'blocked':sum(r['status']=='PRIMARY_METADATA_BLOCKED' for r in rows)}
report={'generatedAt':datetime.datetime.utcnow().isoformat()+'Z','mode':'READ_ONLY_EXACT_ID_PROBE_NO_CHALLENGE_BYPASS','summary':summary,'rows':rows}
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
