import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp,rm,stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable,Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const prefix='social-promotion/temp-jpeg'
const maxBytes=5*1024*1024
function fail(code){const e=new Error(code);e.code=code;return e}
function baseUrl(value){
  const u=new URL(value)
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash)throw fail('SOCIAL_MEDIA_R2_CONFIG_INVALID')
  return u.href.replace(/\/+$/,'')
}
function sourceUrl(value,base){
  if(typeof value!=='string'||value.length>4096||!value.startsWith(base+'/'))throw fail('SOCIAL_MEDIA_SOURCE_INVALID')
  const raw=value.slice(base.length+1)
  if(!/^[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/.test(raw)||raw.includes('..'))throw fail('SOCIAL_MEDIA_SOURCE_INVALID')
  const u=new URL(value),key=u.href.slice(base.length+1)
  if(u.search||u.hash||u.username||u.password||!key||!/^[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/.test(key)||key.includes('..')||key.startsWith(prefix+'/'))throw fail('SOCIAL_MEDIA_SOURCE_INVALID')
  return u.href
}
async function download(url,path,fetchImpl){
  const signal=AbortSignal.timeout(20000)
  const response=await fetchImpl(url,{redirect:'error',signal,headers:{Accept:'image/jpeg,image/png,image/webp'}})
  if(!response.ok||!response.body||!/^image\/(jpeg|png|webp)(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw fail('SOCIAL_MEDIA_DOWNLOAD_INVALID')
  const length=Number(response.headers.get('content-length')||0)
  if(length>maxBytes)throw fail('SOCIAL_MEDIA_INPUT_LIMIT')
  let bytes=0
  const limit=new Transform({transform(chunk,encoding,cb){bytes+=chunk.length;cb(bytes>maxBytes?fail('SOCIAL_MEDIA_INPUT_LIMIT'):null,chunk)}})
  await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(path,{flags:'wx',mode:0o600}),{signal})
  if(!bytes)throw fail('SOCIAL_MEDIA_DOWNLOAD_INVALID')
}
export function convertSocialJpeg(input,output){
  return new Promise((resolve,reject)=>{
    const worker=fileURLToPath(new URL('../../workers/socialPromotionJpeg.worker.js',import.meta.url))
    const child=spawn(process.execPath,[worker,input,output],{stdio:'ignore'})
    let timedOut=false
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},30000)
    timer.unref?.()
    child.once('error',()=>{clearTimeout(timer);reject(fail('SOCIAL_MEDIA_CONVERT_FAILED'))})
    child.once('close',code=>{clearTimeout(timer);if(code===0&&!timedOut)resolve();else reject(fail(timedOut?'SOCIAL_MEDIA_CONVERT_TIMEOUT':'SOCIAL_MEDIA_CONVERT_FAILED'))})
  })
}
export function createSocialPromotionMedia({publicUrl,uploadFile,deleteFile,admit,fetchImpl=globalThis.fetch,convert=convertSocialJpeg,lifecycleReady=()=>false}={}){
  if(![uploadFile,deleteFile,admit,fetchImpl,convert,lifecycleReady].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_MEDIA_DEPENDENCIES')
  let busy=false
  return async function prepareMedia({platform,post}={}){
    if(post?.platform!==platform||!['facebook','instagram','threads'].includes(platform)||!Array.isArray(post.photos)||!['photo','carousel'].includes(post.mediaType)||(post.mediaType==='photo'?post.photos.length!==1:post.photos.length<3||post.photos.length>5))throw fail('SOCIAL_MEDIA_POST_INVALID')
    if(platform==='facebook')return post
    if(!lifecycleReady())throw fail('SOCIAL_MEDIA_LIFECYCLE_REQUIRED')
    if(busy)throw fail('SOCIAL_MEDIA_BUSY')
    const base=baseUrl(publicUrl),urls=post.photos.map(value=>sourceUrl(value,base))
    if(new Set(urls).size!==urls.length)throw fail('SOCIAL_MEDIA_DUPLICATE')
    busy=true
    const uploaded=[]
    let dir
    try{
      dir=await mkdtemp(join(tmpdir(),'shadow-social-'))
      for(let i=0;i<urls.length;i++){
        if(!admit()?.allowed)throw fail('SOCIAL_MEDIA_MEMORY_BUSY')
        const input=join(dir,`${i}.input`),output=join(dir,`${i}.jpg`)
        await download(urls[i],input,fetchImpl)
        if(!admit()?.allowed)throw fail('SOCIAL_MEDIA_MEMORY_BUSY')
        await convert(input,output)
        const info=await stat(output)
        if(!info.isFile()||info.size<=0||info.size>maxBytes)throw fail('SOCIAL_MEDIA_OUTPUT_LIMIT')
        const url=await uploadFile({path:output,originalname:`${i}.jpg`,mimetype:'image/jpeg',size:info.size},prefix)
        if(typeof url!=='string'||!url.startsWith(`${base}/${prefix}/`)||!/\.jpg$/i.test(url))throw fail('SOCIAL_MEDIA_UPLOAD_INVALID')
        uploaded.push(url)
        await rm(input,{force:true});await rm(output,{force:true})
      }
      if(new Set(uploaded).size!==uploaded.length)throw fail('SOCIAL_MEDIA_DUPLICATE')
      return {...post,photos:uploaded}
    }catch(error){
      for(const url of uploaded)await Promise.resolve().then(()=>deleteFile(url)).catch(()=>{})
      throw error?.code?.startsWith('SOCIAL_')?error:fail('SOCIAL_MEDIA_PREPARATION_FAILED')
    }finally{try{if(dir)await rm(dir,{recursive:true,force:true})}finally{busy=false}}
  }
}
