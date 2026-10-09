#!/usr/bin/env python3
"""Read-only validation of 192 user-approved artwork candidates, no TheTVDB writes."""
from __future__ import annotations
import json, hashlib, os, io, collections, concurrent.futures
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from pathlib import Path
from datetime import datetime, timezone
from PIL import Image, ImageOps
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/"reports/artwork-user-approvals-v23-2-2026-10-09.json"
OUT=ROOT/"reports/artwork-user192-source-preflight-v23-2"
OUT.mkdir(parents=True, exist_ok=True)
manifest=json.loads(SRC.read_text())
targets=manifest["targets"]
assert len(targets)==192
assert len({x["tvdbEpisodeId"] for x in targets})==192
assert len(manifest["permanentlyExcluded"])==25

def inspect(x):
    out={k:x[k] for k in ("creator","code","episodeTitle","tvdbEpisodeId","youtubeId","selectedImageUrl",
        "previousScanState","provenanceVerified")}
    url=x["selectedImageUrl"]
    if not isinstance(url,str) or not url.startswith("https://i.ytimg.com/vi/") or "/"+x["youtubeId"]+"/" not in url:
        return {**out,"result":"BLOCKED_SOURCE_URL_NOT_VIDEO"}
    if not url.endswith(("/maxres1.jpg","/maxres2.jpg","/maxres3.jpg")):
        return {**out,"result":"BLOCKED_VARIANT_MISMATCH"}
    try:
        req=Request(url,headers={"User-Agent":"TheTVDB-SourceAudit/1.0 (read-only; user-selected YouTube video)"})
        with urlopen(req,timeout=20) as r:
            status=r.status
            if status in (202,401,403,429):
                return {**out,"result":"BLOCKED_SOURCE_ACCESS_RESTRICTION","http":status}
            if status!=200: return {**out,"result":"BLOCKED_HTTP","http":status}
            data=r.read(12*1024*1024+1)
        if len(data)>12*1024*1024:return {**out,"result":"BLOCKED_FILE_OVERSIZE"}
        im=Image.open(io.BytesIO(data))
        im=ImageOps.exif_transpose(im).convert("RGB")
        width,height=im.size
        if width*height>15000000:return {**out,"result":"BLOCKED_IMAGE_PIXEL_OVERSIZE"}
        pixel_sha=hashlib.sha256(im.tobytes()).hexdigest()
        file_sha=hashlib.sha256(data).hexdigest()
        gray=np.asarray(im.convert("L").resize((9,8),Image.Resampling.LANCZOS))
        dhash=0
        for val in (gray[:,:-1]>gray[:,1:]).flatten():
            dhash=(dhash<<1)|int(val)
        arr=np.asarray(im.resize((96,54),Image.Resampling.LANCZOS),dtype=np.int16)
        rgbmean=np.mean(arr,axis=(0,1)).round(2).tolist()
        # Not proof image complies with TheTVDB no-text/logo policy.
        valid=width>=640 and height>=360 and abs(width/height-16/9)<.025
        return {**out,"result":"TECHNICALLY_VALID_AWAITING_VISUAL_AND_LIVE_TVDB_PREFLIGHT" if valid else "BLOCKED_WRONG_IMAGE_GEOMETRY",
            "http":200,"width":width,"height":height,"fileSha256":file_sha,"pixelSha256":pixel_sha,
            "dHash":f"{dhash:016x}","rgbmean":rgbmean,
            "visualModeration":"NOT_CERTIFIED","readyToUpload":False}
    except HTTPError as e:
        return {**out,"result":"BLOCKED_ACCESS_OR_HTTP","http":e.code}
    except Exception as e:
        return {**out,"result":"BLOCKED_DOWNLOAD_OR_DECODE","error":str(e)[:140]}

rows=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    futures=[pool.submit(inspect,x) for x in targets]
    for f in concurrent.futures.as_completed(futures):
        rows.append(f.result())
rows.sort(key=lambda x:(x["creator"],x["code"]))
valid=[x for x in rows if x["result"].startswith("TECHNICALLY_VALID")]
bysha=collections.defaultdict(list)
for x in valid:bysha[x["pixelSha256"]].append(x)
exact=[[{"creator":x["creator"],"code":x["code"],"tvdbEpisodeId":x["tvdbEpisodeId"]} for x in g]
       for g in bysha.values() if len(g)>1]
near=[]
for i,a in enumerate(valid):
    ah=int(a["dHash"],16)
    for b in valid[i+1:]:
        dist=(ah^int(b["dHash"],16)).bit_count()
        if dist>3 or a["pixelSha256"]==b["pixelSha256"]:continue
        color_delta=sum(abs(x-y) for x,y in zip(a["rgbmean"],b["rgbmean"]))/3
        if color_delta>18:continue
        near.append({"first":{"creator":a["creator"],"code":a["code"],"tvdbEpisodeId":a["tvdbEpisodeId"]},
                     "second":{"creator":b["creator"],"code":b["code"],"tvdbEpisodeId":b["tvdbEpisodeId"]},
                     "dhashHamming":dist,"colorDelta":round(color_delta,2),
                     "status":"SIMILAR_CANDIDATE_MANUAL_REVIEW_ONLY"})
counts=dict(collections.Counter(x["result"] for x in rows))
report={"generatedAt":datetime.now(timezone.utc).isoformat(),
 "mode":"READ_ONLY_SOURCE_IMAGE_VERIFICATION",
 "sourceManifest":str(SRC.relative_to(ROOT)),
 "totals":{"userApproved":len(targets),"checked":len(rows),"byStatus":counts,
     "exactDuplicateCandidateGroups":len(exact),"nearDuplicateCandidatePairs":len(near),
     "historicalSourceProvenanceUnknown":sum(x["provenanceVerified"]=="NEEDS_SEPARATE_PROVENANCE" for x in rows),
     "siteWrites":0},
 "exactDuplicateGroups":exact,"nearDuplicateCandidates":near,
 "rows":rows,
 "safety":{"noArtworkUpload":True,"noSiteWrite":True,"noYoutubeAccessBypass":True,
           "pixelChecksNotVisualEditorialApproval":True,
           "noAssumptionOnAccountUploadPermissions":True}}
(OUT/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
(OUT/"summary.txt").write_text(json.dumps(report["totals"],ensure_ascii=False,indent=2)+"\n")
print(json.dumps(report["totals"],ensure_ascii=False))
