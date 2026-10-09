#!/usr/bin/env python3
"""Inventory-based, read-only image duplicate comparison. Never edit TheTVDB."""
from __future__ import annotations
import json, re, hashlib, math, os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen
from PIL import Image, ImageOps
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"reports/artwork-exact-duplicates-v23"
OUT.mkdir(parents=True,exist_ok=True)
INPUTS={
 "Djilsi":"reports/djilsi-live-215-artwork-rescan-2026-10-08.json",
 "Raska":"reports/optionA-raska-150-live-audit-2026-10-08.json",
 "Maxime Biaggi":"reports/maxime-biaggi-live-artwork-rescan-2026-10-08.json",
 "Mastu":"reports/optionA-mastu-376-inventory-2026-10-08.json"}
rows=[]
for creator,path in INPUTS.items():
 data=json.loads((ROOT/path).read_text())
 for r in data["rows"]:
  if isinstance(r,list):
   if creator=="Mastu":
    code,tid,status,url=(r+[None]*4)[:4]
    yt=None
   else:
    code,tid,yt,status,url=(r+[None]*5)[:5]
  else:
   code=r.get("code") or r.get("episode")
   tid=r.get("tvdbEpisodeId") or r.get("tvdbId")
   yt=r.get("youtubeId")
   status=r.get("status") or ("PRESENT" if r.get("artworkUrl") else "MISSING")
   url=r.get("artworkUrl")
  rows.append({"channel":creator,"code":str(code or ""),"tvdbEpisodeId":str(tid or ""),
   "youtubeId":yt,"state":str(status),"url":url,"source":path})
usable=[r for r in rows if r["url"] and str(r["url"]).startswith("https://artworks.thetvdb.com/")]
# 96x54 pixel image signature catches duplicated images saved as distinct files.
# 8x8 dhash is a coarse *candidate* only: never label merely similar as identical.
def sample(item):
 request=Request(item["url"],headers={
  "User-Agent":"Mozilla/5.0 (compatible; ArtworkResearchAudit/1.0; read-only)",
  "Accept":"image/avif,image/webp,image/png,image/jpeg,image/*"})
 try:
  with urlopen(request, timeout=30) as response:
   status=response.status
   if status!=200: raise ValueError("HTTP_"+str(status))
   payload=response.read(10*1024*1024+1)
  if len(payload)>10*1024*1024: raise ValueError("MAX_FILE_SIZE")
  im=Image.open(BytesIO(payload))
  im=ImageOps.exif_transpose(im)
  if im.width*im.height>18000000: raise ValueError("MAX_PIXELS")
  rgb=im.convert("RGB")
  exact=hashlib.sha256(rgb.tobytes()).hexdigest()
  binary=hashlib.sha256(payload).hexdigest()
  arr=np.asarray(rgb.resize((96,54),Image.Resampling.LANCZOS),dtype=np.uint8)
  gray=np.asarray(rgb.convert("L").resize((9,8),Image.Resampling.LANCZOS),dtype=np.int16)
  dhash=0
  for val in (gray[:,:-1]>gray[:,1:]).flatten():
   dhash=(dhash<<1)|int(val)
  # Additional 8x8 block average and per-channel means used to avoid many false-positive perceptual comparisons
  mean=[round(float(x),2) for x in arr.mean(axis=(0,1))]
  return {**item,"ok":True,"fileSha256":binary,"pixelSha256":exact,
    "size":[rgb.width,rgb.height],"dHash":f"{dhash:016x}","mean":mean,"arr":arr}
 except Exception as e:
  return {**item,"ok":False,"failure":str(e)[:160]}
done=[]
with ThreadPoolExecutor(max_workers=8) as ex:
 jobs=[ex.submit(sample,x) for x in usable]
 for f in as_completed(jobs):
  done.append(f.result())
done.sort(key=lambda x:(x["channel"],x["code"]))
good=[r for r in done if r["ok"]]
by_url=defaultdict(list)
by_binary=defaultdict(list)
by_pixels=defaultdict(list)
for r in good:
 by_url[r["url"]].append(r)
 by_binary[r["fileSha256"]].append(r)
 by_pixels[(r["size"][0],r["size"][1],r["pixelSha256"])].append(r)
# Group only different TVDB immutable episode IDs; no same-row duplicates.
def distinct(v):return len(set(x["tvdbEpisodeId"] for x in v))>1
def slim(r):
 return {k:r.get(k) for k in ("channel","code","tvdbEpisodeId","youtubeId","url","fileSha256","pixelSha256","size","dHash")}
def groups(by,tag):
 return [{"verification":tag,"entries":[slim(x) for x in group]} for group in by.values() if distinct(group)]
url_groups=groups(by_url,"SAME_URL")
binary_groups=groups(by_binary,"EXACT_SAME_FILE_SHA256")
pixel_groups=groups(by_pixels,"EXACT_SAME_DECODED_PIXELS")
# candidate image similarity: a hash match alone is insufficient.
near=[]
for i,a in enumerate(good):
 ah=int(a["dHash"],16)
 for b in good[i+1:]:
  if a["tvdbEpisodeId"]==b["tvdbEpisodeId"]:continue
  dh=(ah ^ int(b["dHash"],16)).bit_count()
  if dh>6:continue
  # Required: very close mean RGB and low pixel difference, to prevent
  # different dark/flat/scene images from being misidentified as clones.
  mean_distance=sum(abs(x-y) for x,y in zip(a["mean"],b["mean"]))/3
  if mean_distance>24:continue
  mse=float(np.mean(np.abs(a["arr"].astype(np.int16)-b["arr"].astype(np.int16))))
  if mse>28:continue
  if a["pixelSha256"]==b["pixelSha256"]:continue
  strength="VERY_SIMILAR" if dh<=2 and mse<=10 else "POSSIBLE_VISUAL_DUPLICATE"
  near.append({"a":slim(a),"b":slim(b),"dhashHamming":dh,
    "resizedRgbMeanAbsoluteDifference":round(mse,2),
    "classification":strength,"action":"MANUAL_VISUAL_REVIEW_ONLY"})
# Exact groups from three sources can overlap; deduplicate same member sets.
gindex={}
for g in url_groups+binary_groups+pixel_groups:
 key="|".join(sorted(x["tvdbEpisodeId"] for x in g["entries"]))
 if key not in gindex:gindex[key]=g
 else:
  gindex[key]["verification"]+="+"+g["verification"]
exact=list(gindex.values())
report={
 "generatedAt":datetime.now(timezone.utc).isoformat(),
 "mode":"READ_ONLY_ARTWORK_IMAGE_CONTENT_COMPARISON",
 "scope":"4 creators with complete, dated artwork-URL inventories",
 "files":INPUTS,
 "summary":{
  "inventoryEpisodes":len(rows),"withArtworkUrl":len(usable),
  "downloadedAndDecoded":len(good),"downloadFailed":len(usable)-len(good),
  "missingStatus":sum("MISSING" in r["state"].upper() or "NO_ARTWORK" in r["state"].upper() for r in rows),
  "unknownStatus":sum("UNKNOWN" in r["state"].upper() or r["state"]=="HTTP_202" for r in rows),
  "sameUrlGroups":len(url_groups),"exactSameFileGroups":len(binary_groups),
  "exactSamePixelGroups":len(pixel_groups),
  "uniqueExactGroupCount":len(exact),"perceptualCandidatePairs":len(near),
  "verySimilarCandidatePairs":sum(x["classification"]=="VERY_SIMILAR" for x in near)},
 "exactGroups":exact,"nearCandidates":near,
 "failures":[{k:v for k,v in r.items() if k!="arr"} for r in done if not r["ok"]],
 "safety":{
  "siteWrites":0,
  "similarityIsNotCertainty":True,
  "didNotBypassAccessControls":True,
  "neverDeleteAutomatically":True,
  "missingOrUnknownStillRequiresLiveRecheckBeforeUpload":True,
  "notAllNineCreatorsHaveCompleteArtworkUrlInventories":True,
  "urlEqualityAloneInsufficient":True}}
(OUT/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
(OUT/"summary.txt").write_text("\n".join(f"{k}={v}" for k,v in report["summary"].items())+"\n")
print(json.dumps(report["summary"],ensure_ascii=False))
