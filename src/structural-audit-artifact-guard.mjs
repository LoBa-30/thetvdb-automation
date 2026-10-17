import fs from 'node:fs/promises';
import path from 'node:path';
const names=['Djilsi','Elian Ventre','Raska','Maxime Biaggi','Squeezie','Mastu','Amixem','Joyca','Mcfly & Carlito'];
const [dir,destination,runTime]=process.argv.slice(2);
if(!dir||!destination||!runTime)throw Error('Missing arguments');
const candidates=[path.join(dir,'audit.json'),path.join(dir,'reports','audit.json')];
const found=[];
for(const p of candidates){try{const s=await fs.lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>50e6)throw Error('Unsafe artifact file');found.push(p)}catch(e){if(e.code!=='ENOENT')throw e}}
if(found.length!==1)throw Error('Missing or ambiguous audit artifact');
const raw=await fs.readFile(found[0],'utf8');const a=JSON.parse(raw);
if(a.mode!=='READ_ONLY_AUDIT_9_CHANNELS_ISOLATED_STRICT_MINIMUMS'||a.complete!==true||a.targets?.length!==9)throw Error('Not complete authoritative audit');
const expected=new Set(names),seen=new Set();
for(const t of a.targets){if(!expected.has(t.name)||seen.has(t.name)||t.youtubeReachable!==true||t.tvdbReachable!==true||!Array.isArray(t.errors)||t.errors.length||!Number.isSafeInteger(t.youtubeVideoCount)||!Number.isSafeInteger(t.tvdbEpisodeCount)||t.youtubeVideoCount<1||t.tvdbEpisodeCount<1)throw Error('Invalid target '+t.name);seen.add(t.name);for(const k of ['youtubeVideos','tvdbEpisodes','youtubeWithoutConfidentTvdbMatch','tvdbWithoutCurrentPublicYoutubeMatch','tvdbDuplicateCodes','tvdbDuplicateTitles'])if(!Array.isArray(t[k]))throw Error('Invalid '+k);if(t.youtubeVideos.length!==t.youtubeVideoCount||t.tvdbEpisodes.length!==t.tvdbEpisodeCount)throw Error('Count mismatch')}
const created=Date.parse(runTime),generated=Date.parse(a.generatedAt),now=Date.now();
if(!Number.isFinite(created)||!Number.isFinite(generated)||generated<created-300000||generated>created+7200000||generated>now+300000||now-generated>259200000)throw Error('Stale or mismatched provenance');
await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,raw);
console.log('VALIDATED_EXISTING_NINE_CHANNEL_AUDIT '+JSON.stringify({generatedAt:a.generatedAt,sourceRunCreated:runTime,targets:9}));
