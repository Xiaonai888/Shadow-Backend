export function socialPromotionRuntimeConfig(env={}){
  if(env.SOCIAL_PROMOTION_WORKER_ENABLED!=='true')return {enabled:false,code:'SOCIAL_RUNTIME_DISABLED'}
  if(!/^v[1-9][0-9]*\.[0-9]+$/.test(env.SOCIAL_META_GRAPH_VERSION||'')||!String(env.SOCIAL_META_APP_SECRET||'').trim()||!/^([a-fA-F0-9]{64})$/.test(env.SOCIAL_MEDIA_TOKEN_KEY||''))return {enabled:false,code:'SOCIAL_RUNTIME_META_CONFIG_REQUIRED'}
  if(env.SOCIAL_PROMOTION_R2_LIFECYCLE_READY!=='true')return {enabled:false,code:'SOCIAL_RUNTIME_R2_LIFECYCLE_REQUIRED'}
  if(!['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME'].every(k=>String(env[k]||'').trim()))return {enabled:false,code:'SOCIAL_RUNTIME_R2_CONFIG_REQUIRED'}
  try{
    const u=new URL(env.R2_PUBLIC_URL)
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash)throw new Error()
  }catch{return {enabled:false,code:'SOCIAL_RUNTIME_R2_CONFIG_REQUIRED'}}
  return {enabled:true,code:null}
}
export function createSocialPromotionRuntime({env=process.env,initialize,onError=()=>{}}={}){
  if(typeof initialize!=='function'||typeof onError!=='function')throw new TypeError('SOCIAL_RUNTIME_DEPENDENCIES')
  let scheduler=null,pending=null,revision=0
  const report=code=>{try{onError({code})}catch{}}
  return {
    start(){
      const config=socialPromotionRuntimeConfig(env)
      if(!config.enabled){if(config.code!=='SOCIAL_RUNTIME_DISABLED')report(config.code);return Promise.resolve(false)}
      if(scheduler)return Promise.resolve(true)
      if(pending)return pending
      const current=revision
      pending=Promise.resolve().then(async()=>{
        let candidate
        try{
          candidate=await initialize()
          if(!candidate?.start||!candidate?.stop)throw new Error()
          if(current!==revision||!socialPromotionRuntimeConfig(env).enabled){candidate.stop();return false}
          if(candidate.start()!==true){candidate.stop();return false}
          scheduler=candidate
          return true
        }catch{
          try{candidate?.stop?.()}catch{}
          report('SOCIAL_RUNTIME_INIT_FAILED')
          return false
        }
      }).finally(()=>{pending=null})
      return pending
    },
    stop(){revision++;const previous=scheduler;scheduler=null;try{previous?.stop()}catch{report('SOCIAL_RUNTIME_STOP_FAILED')}},
    isStarted(){return scheduler!==null}
  }
}
