import {threadsGraphConfig} from './threadsGraphTransport.service.js'

export function threadsTokenRuntimeEnabled(env=process.env){
  if(env.SOCIAL_THREADS_REFRESH_ENABLED!=='true'||env.SOCIAL_OAUTH_ADMIN_ENABLED!=='true'||!/^([a-fA-F0-9]{64})$/.test(env.SOCIAL_MEDIA_TOKEN_KEY||''))return false
  try{threadsGraphConfig(env);return true}catch{return false}
}
export function createThreadsTokenRuntime({env=process.env,initialize,onError=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(![initialize,onError,setTimer,clearTimer].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_THREADS_RUNTIME_DEPENDENCIES')
  let started=false,running=false,timer=null,revision=0,maintenance=null
  const report=code=>{try{onError({code})}catch{}}
  async function tick(){
    if(!threadsTokenRuntimeEnabled(env))return {state:'disabled'}
    if(running)return {state:'busy'}
    running=true
    const current=revision
    try{
      if(!maintenance){
        const candidate=await initialize()
        if(typeof candidate?.run!=='function')throw new Error('SOCIAL_THREADS_RUNTIME_INVALID')
        maintenance=candidate
      }
      if(current!==revision||!threadsTokenRuntimeEnabled(env))return {state:'disabled'}
      return await maintenance.run()
    }catch{report('SOCIAL_THREADS_REFRESH_RUNTIME_FAILED');return {state:'failed'}}finally{running=false}
  }
  function schedule(delay,current){
    timer=setTimer(async()=>{
      if(!started||revision!==current)return
      timer=null
      try{await tick()}finally{
        if(started&&revision===current){
          if(threadsTokenRuntimeEnabled(env))schedule(3600000,current)
          else started=false
        }
      }
    },delay)
    timer?.unref?.()
  }
  return {tick,start(){
    if(started||!threadsTokenRuntimeEnabled(env))return false
    started=true;schedule(60000,++revision);return true
  },stop(){started=false;revision++;if(timer!==null)clearTimer(timer);timer=null}}
}
const onError=({code})=>console.error('SOCIAL_THREADS_TOKEN_RUNTIME_ERROR',/^SOCIAL_[A-Z0-9_]{1,90}$/.test(code||'')?code:'SOCIAL_RUNTIME_UNKNOWN')
const runtime=createThreadsTokenRuntime({onError,async initialize(){
  const [{supabase},{createThreadsOAuth},{createThreadsTokenMaintenance}]=await Promise.all([import('../../config/supabase.js'),import('./threadsOAuth.service.js'),import('./threadsTokenMaintenance.service.js')])
  const ready=await supabase.rpc('social_promotion_assignment_ready_v5')
  if(ready.error||ready.data!==true)throw new Error('SOCIAL_THREADS_DATABASE_NOT_READY')
  return createThreadsTokenMaintenance({db:supabase,threads:createThreadsOAuth(),onError})
}})
export const startThreadsTokenMaintenance=()=>runtime.start()
export const stopThreadsTokenMaintenance=()=>runtime.stop()
