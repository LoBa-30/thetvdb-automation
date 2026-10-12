import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot=process.cwd();
const base='reports/artwork-ready-v25-2026-10-10';
const inputs=[
  base+'/queue.json',
  base+'/needs-new-still-25.json',
  base+'/extra-visual-review.json',
  base+'/review.html',
  'reports/artwork-user-approvals-v23-2-2026-10-09.json',
  'reports/artwork-user192-source-preflight-v23-2/report.json',
  'reports/artwork-user192-manual-visual-flags-v24-1-2026-10-10.json',
  'reports/artwork-user192-fullres-alternatives-review-v24-4-2026-10-10.json',
  'reports/artwork-mastu-26-historical-id-reconciliation-v25-2026-10-10.json',
  'reports/artwork-public-identity-recheck-v25-3-2026-10-12.json'
];
const read=(root,p)=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(root,p,value)=>fs.writeFileSync(path.join(root,p),JSON.stringify(value,null,2)+'\n');
function executeWithMutation(mutate){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tvdb-v25-offline-test-'));
  try {
    for(const p of inputs){
      fs.mkdirSync(path.dirname(path.join(temp,p)),{recursive:true});
      fs.copyFileSync(path.join(repoRoot,p),path.join(temp,p));
    }
    if(mutate)mutate(temp);
    const result=spawnSync(process.execPath,[path.join(repoRoot,'src/artwork-ready-v25-queue-guard.mjs')],{
      cwd:temp,encoding:'utf8',timeout:30000,env:{...process.env,TVDB_USERNAME:'',TVDB_PASSWORD:''}
    });
    assert.equal(result.error,undefined,'offline guard process failed to start');
    return result;
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
function mustReject(mutation,reason){
  const result=executeWithMutation(mutation);
  assert.equal(result.status,2,'unsafe mutation must fail closed: '+result.stdout+' '+result.stderr);
  assert.match(result.stdout,reason);
}

test('unchanged 192-item V25 queue passes strictly offline',()=>{
  const result=executeWithMutation();
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
  assert.match(result.stdout,/"valid":true/);
  assert.match(result.stdout,/"siteRequests":0/);
  assert.match(result.stdout,/"eligibleToUploadNow":0/);
});
test('swapping an exclusion ID without changing 25-item count fails',()=>{
  mustReject(root=>{
    const p=base+'/queue.json',q=read(root,p);
    q.permanentExclusions[0].tvdbEpisodeId=q.staging[0].tvdbEpisodeId;
    write(root,p,q);
  },/queue vs explicit refusals|permanent refusal details/);
});
test('changing a pinned pixel SHA-256 fails',()=>{
  mustReject(root=>{
    const p=base+'/queue.json',q=read(root,p);
    q.staging[0].originalPixelSha256='f'.repeat(64);
    write(root,p,q);
  },/original pixel hash mismatch/);
});
test('changing a recapture video ID fails',()=>{
  mustReject(root=>{
    const p=base+'/needs-new-still-25.json',q=read(root,p);
    q.items[0].youtubeId='AAAAAAAAAAA';
    write(root,p,q);
  },/recapture identity drift/);
});
test('swapping a Mastu episode source fails',()=>{
  mustReject(root=>{
    const p='reports/artwork-mastu-26-historical-id-reconciliation-v25-2026-10-10.json',q=read(root,p);
    q.rows[0].sourceSelected='https://i.ytimg.com/vi/AAAAAAAAAAA/maxres1.jpg';
    write(root,p,q);
  },/Mastu immutable numeric-ID provenance mismatch/);
});
test('public V25.3 documentary evidence cannot set approval or lift status',()=>{
  mustReject(root=>{
    const p='reports/artwork-public-identity-recheck-v25-3-2026-10-12.json',q=read(root,p);
    q.safety.accountRestrictionLiftVerified=true;
    q.readOnlyEvidence[0].submissionAllowed=true;
    write(root,p,q);
  },/V25.3 .*release-gate claim|V25.3 .*authorized upload/);
});
