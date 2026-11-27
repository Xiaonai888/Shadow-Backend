import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSocialPromotionScheduler } from '../src/services/socialMedia/socialPromotionScheduler.service.js'
import { createSocialPromotionMedia,convertSocialJpeg } from '../src/services/socialMedia/socialPromotionMedia.service.js'
const now=Date.parse('2026-11-27T11:01:00Z')
const slot='2026-11-27T11:00:00.000Z'
const item=i=>({rule:{id:`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,owner_type:'admin',owner_id:'shadow',enabled:true},slot})
function scheduler({due=[],hasWork=false,enabled=()=>true,plan=async()=>({state:'queued'}),runWorker=async()=>({state:'published'})}={}){
  const calls=[]
  const instance=createSocialPromotionScheduler({db:{rpc:async(name,args)=>{calls.push(['poll',name,args]);return {data:{due,hasWork}}}},integration:{plan:async arg=>{calls.push(['plan',arg]);return plan(arg)},runWorker:async()=>{calls.push(['worker']);return runWorker()}},enabled,clock:()=>now})
  return {instance,calls}
}
test('disabled scheduler never queries or publishes',async()=>{const {instance,calls}=scheduler({enabled:()=>false});assert.equal(instance.start(),false);assert.deepEqual(await instance.tick(),{state:'disabled'});assert.equal(calls.length,0)})
test('idle poll performs one RPC only',async()=>{const {instance,calls}=scheduler();assert.deepEqual(await instance.tick(),{state:'ok',planned:0,worker:null});assert.equal(calls.length,1)})
test('at most three rules and one worker per tick, remembers attempted slots',async()=>{const {instance,calls}=scheduler({due:[1,2,3,4,5].map(item)});assert.equal((await instance.tick()).planned,3);assert.equal((await instance.tick()).planned,2);assert.equal(calls.filter(x=>x[0]==='worker').length,2);assert.equal(calls.filter(x=>x[0]==='poll')[1][2].p_skip.length,3);assert.equal((await instance.tick()).planned,0)})
test('expired slots are ignored and stale queued work still drains',async()=>{const {instance,calls}=scheduler({due:[{...item(1),slot:'2026-11-27T10:00:00Z'}],hasWork:true});assert.equal((await instance.tick()).planned,0);assert.equal(calls.filter(x=>x[0]==='worker').length,1)})
test('no overlapping ticks',async()=>{let release;const blocked=new Promise(resolve=>{release=resolve});const {instance}=scheduler({due:[item(1)],plan:()=>blocked});const pending=instance.tick();assert.equal((await instance.tick()).state,'busy');release({state:'empty'});assert.equal((await pending).state,'ok')})
const base='https://media.shadow.example.com',photo=`${base}/stories/a.webp`
function media(overrides={}){
  const calls=[];let n=0
  const prepare=createSocialPromotionMedia({publicUrl:base,fetchImpl:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/webp'}}),admit:()=>({allowed:true}),lifecycleReady:()=>true,convert:async(input,output)=>{calls.push(['convert',input,output]);assert.equal((await readFile(input)).length,3);await writeFile(output,new Uint8Array([1,2,3]))},uploadFile:async(file,folder)=>{calls.push(['upload',file,folder]);assert.equal(file.mimetype,'image/jpeg');return `${base}/${folder}/${++n}.jpg`},deleteFile:async url=>{calls.push(['delete',url])},...overrides})
  return {prepare,calls}
}
const post={platform:'instagram',mediaType:'photo',photos:[photo],caption:'Shadow'}
test('Facebook bypasses conversion and storage',async()=>{const {prepare,calls}=media({lifecycleReady:()=>false});const fb={...post,platform:'facebook'};assert.equal(await prepare({platform:'facebook',post:fb}),fb);assert.equal(calls.length,0)})
test('IG requires lifecycle confirmation and memory admission',async()=>{await assert.rejects(media({lifecycleReady:()=>false}).prepare({platform:'instagram',post}),/LIFECYCLE_REQUIRED/);await assert.rejects(media({admit:()=>({allowed:false})}).prepare({platform:'instagram',post}),/MEMORY_BUSY/)})
test('rejects other hosts, traversal and query URLs before fetch',async()=>{for(const url of ['https://example.net/a.jpg',`${base}/a/../b.jpg`,`${base}/a.jpg?secret=x`,`${base}/%2e%2e/a.jpg`]){await assert.rejects(media({fetchImpl:()=>assert.fail('network')}).prepare({platform:'instagram',post:{...post,photos:[url]}}),/SOURCE_INVALID/)}})
test('IG conversion uses temporary disk and removes local files',async()=>{const {prepare,calls}=media();const result=await prepare({platform:'instagram',post});assert.equal(result.photos[0],`${base}/social-promotion/temp-jpeg/1.jpg`);assert.deepEqual(post.photos,[photo]);await assert.rejects(readFile(calls[0][1]),{code:'ENOENT'});await assert.rejects(readFile(calls[0][2]),{code:'ENOENT'})})
test('rejects oversized streamed input without upload',async()=>{const {prepare,calls}=media({fetchImpl:async()=>new Response(new Uint8Array(5*1024*1024+1),{headers:{'content-type':'image/png'}})});await assert.rejects(prepare({platform:'instagram',post}),/INPUT_LIMIT/);assert.equal(calls.length,0)})
test('cleans already uploaded files if album conversion fails',async()=>{let count=0;const {prepare,calls}=media({convert:async(input,output)=>{if(++count===2)throw new Error('failure');await writeFile(output,'jpeg')}});await assert.rejects(prepare({platform:'instagram',post:{...post,mediaType:'carousel',photos:[photo,`${base}/b.png`,`${base}/c.jpg`]}}),/PREPARATION_FAILED/);assert.deepEqual(calls.filter(x=>x[0]==='delete'),[['delete',`${base}/social-promotion/temp-jpeg/1.jpg`]])})
test('real JPEG worker converts PNG to bounded portrait JPEG',async()=>{const dir=await mkdtemp(join(tmpdir(),'shadow-jpeg-test-'));try{const input=join(dir,'source.png'),output=join(dir,'result.jpg');const sharp=(await import('sharp')).default;await sharp({create:{width:64,height:64,channels:4,background:{r:0,g:0,b:0,alpha:0.5}}}).png().toFile(input);await convertSocialJpeg(input,output);const meta=await sharp(output).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.width,1080);assert.equal(meta.height,1350);assert.ok((await readFile(output)).length<5*1024*1024)}finally{await rm(dir,{recursive:true,force:true})}})
