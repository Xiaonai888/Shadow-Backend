import {useEffect,useRef,useState} from 'react'
import {eventRequest} from '../../../services/telegramEventAdminApi'
const limit=5*1024*1024
const types=new Set(['image/png','image/jpeg','image/webp'])
async function prepare(file,preview){
  const img=new Image()
  img.src=preview
  await img.decode()
  if(!img.naturalWidth||!img.naturalHeight)throw new Error('Invalid image')
  if(file.size<=limit)return file
  let scale=Math.min(1,4096/Math.max(img.naturalWidth,img.naturalHeight))
  const canvas=document.createElement('canvas')
  const ctx=canvas.getContext('2d')
  if(!ctx)throw new Error('Image compression is unavailable')
  try{
    for(let attempt=0;attempt<8;attempt++){
      canvas.width=Math.max(1,Math.round(img.naturalWidth*scale))
      canvas.height=Math.max(1,Math.round(img.naturalHeight*scale))
      ctx.drawImage(img,0,0,canvas.width,canvas.height)
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,file.type,0.85))
      if(blob&&types.has(blob.type)&&blob.size<=limit)return new File([blob],file.name,{type:blob.type,lastModified:Date.now()})
      scale*=0.7
    }
    throw new Error('Image is too large. Choose a smaller image.')
  }finally{canvas.width=0;canvas.height=0}
}
function put(url,file,signal,progress){
  return new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(new DOMException('Cancelled','AbortError'))
    const xhr=new XMLHttpRequest()
    const abort=()=>xhr.abort()
    const finish=(error)=>{signal.removeEventListener('abort',abort);error?reject(error):resolve()}
    xhr.open('PUT',url)
    xhr.timeout=180000
    xhr.setRequestHeader('Content-Type',file.type)
    xhr.upload.onprogress=e=>{if(e.lengthComputable)progress(Math.min(99,Math.round(e.loaded/e.total*100)))}
    xhr.onload=()=>finish(xhr.status>=200&&xhr.status<300?null:new Error(`Cloudflare upload failed (${xhr.status})`))
    xhr.onerror=()=>finish(new Error('Cloudflare network error'))
    xhr.ontimeout=()=>finish(new Error('Cloudflare upload timed out'))
    xhr.onabort=()=>finish(new DOMException('Cancelled','AbortError'))
    signal.addEventListener('abort',abort,{once:true})
    xhr.send(file)
  })
}
export default function useTelegramEventImages(onReady){
  const [jobs,setJobs]=useState({})
  const current=useRef({})
  const ready=useRef(onReady)
  ready.current=onReady
  const remove=(language)=>{
    const job=current.current[language]
    if(job){job.controller.abort();URL.revokeObjectURL(job.preview);delete current.current[language]}
    setJobs(old=>{const next={...old};delete next[language];return next})
  }
  useEffect(()=>()=>{for(const job of Object.values(current.current)){job.controller.abort();URL.revokeObjectURL(job.preview)}current.current={}},[])
  function start(language,file){
    if(!types.has(file?.type)||file.size<16||file.size>40*1024*1024)throw new Error('Choose a PNG, JPEG or WEBP image up to 40 MB')
    remove(language)
    const job={file,preview:URL.createObjectURL(file),controller:new AbortController()}
    current.current[language]=job
    const live=()=>current.current[language]===job&&!job.controller.signal.aborted
    const update=patch=>{if(live())setJobs(old=>({...old,[language]:{...old[language],...patch}}))}
    setJobs(old=>({...old,[language]:{preview:job.preview,name:file.name,status:'preparing',progress:0}}))
    void (async()=>{
      try{
        const data=await prepare(file,job.preview)
        if(!live())return
        update({status:'uploading'})
        const signal=job.controller.signal
        const init=await eventRequest('/api/media-direct/admin/init',{method:'POST',body:{category:'admin_telegram_event',mime_type:data.type,file_size:data.size},signal})
        if(!live())return
        if(!init.upload_url||!init.upload_token)throw new Error('Upload initialization failed')
        await put(init.upload_url,data,signal,progress=>update({progress}))
        if(!live())return
        update({status:'finalizing',progress:99})
        const result=await eventRequest('/api/media-direct/admin/finalize',{method:'POST',body:{upload_token:init.upload_token},signal})
        if(!live())return
        const url=result.image_url||result.imageUrl
        const key=result.path||result.storage_key||result.storageKey||result.image_key||result.key
        if(!url||!key||!key.startsWith('telegram-events/images/'))throw new Error('Cloudflare image reference is missing')
        ready.current(language,{image_url:url,image_key:key})
        update({status:'ready',progress:100})
      }catch(error){if(live())update({status:'error',error:error.message||'Upload failed'})}
    })()
  }
  return {jobs,start,remove,retry:language=>{const file=current.current[language]?.file;if(file)start(language,file)},blocked:Object.values(jobs).some(job=>job.status!=='ready')}
}
