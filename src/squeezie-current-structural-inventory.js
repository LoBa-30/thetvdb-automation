import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const source=await fs.readFile(new URL('./audit.js',import.meta.url),'utf8');
const target={name:'Squeezie',youtubeUrl:'https://www.youtube.com/@Squeezie/videos',tvdbUrl:'https://thetvdb.com/series/279758-show/allseasons/official'};
let patched=source.replace(/const TARGETS = \[[\s\S]*?\n\];/, 'const TARGETS = ['+JSON.stringify(target)+'];');
patched=patched.replace('i < 140 && stableRounds < 6','i < 360 && stableRounds < 12').replace('await page.waitForTimeout(850);','await page.waitForTimeout(1000);');
const tmp=path.join(here,'.squeezie-current-structural-runtime.mjs');
await fs.writeFile(tmp,patched);
await new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[tmp],{stdio:'inherit',cwd:process.cwd()});
 child.on('error',reject); child.on('close',c=>c===0?resolve():reject(new Error('audit child '+c)));
});
await fs.rm(tmp,{force:true});
const full=JSON.parse(await fs.readFile('reports/audit.json','utf8'));
const t=full.targets?.[0];
if(!t) throw new Error('Missing Squeezie target');
const compact={
 generatedAt:new Date().toISOString(),
 target:'Squeezie',
 mode:'READ_ONLY_CURRENT_STRUCTURAL_INVENTORY',
 counts:{youtube:t.youtubeVideoCount,tvdb:t.tvdbEpisodeCount,matched:t.summary?.matched,youtubeWithoutMatch:t.summary?.youtubeWithoutConfidentTvdbMatch,tvdbWithoutCurrentPublicYoutubeMatch:t.summary?.tvdbWithoutCurrentPublicYoutubeMatch},
 youtubeWithoutConfidentTvdbMatch:t.youtubeWithoutConfidentTvdbMatch||[],
 tvdbWithoutCurrentPublicYoutubeMatch:t.tvdbWithoutCurrentPublicYoutubeMatch||[],
 tvdbDuplicateCodes:t.tvdbDuplicateCodes||[],
 tvdbDuplicateTitles:t.tvdbDuplicateTitles||[],
 errors:t.errors||[]
};
await fs.mkdir('reports/squeezie-current-structural',{recursive:true});
await fs.writeFile('reports/squeezie-current-structural/report.json',JSON.stringify(compact,null,2));
console.log(JSON.stringify(compact.counts));
if(compact.errors.length) process.exitCode=2;
