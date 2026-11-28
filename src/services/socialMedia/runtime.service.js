import { createSocialPromotionRuntime, socialPromotionRuntimeConfig } from './socialPromotionRuntimeGuard.service.js'

const onError=({code})=>console.error('SOCIAL_PROMOTION_RUNTIME_ERROR',/^SOCIAL_[A-Z0-9_]{1,90}$/.test(code||'')?code:'SOCIAL_RUNTIME_UNKNOWN')
const enabled=()=>socialPromotionRuntimeConfig(process.env).enabled
const runtime=createSocialPromotionRuntime({onError,async initialize(){
  const [dbModule,integrationModule,schedulerModule,mediaModule,vaultModule,r2Module,memoryModule]=await Promise.all([
    import('../../config/supabase.js'),
    import('./socialPromotionIntegration.service.js'),
    import('./socialPromotionScheduler.service.js'),
    import('./socialPromotionMedia.service.js'),
    import('./tokenVault.service.js'),
    import('../r2Storage.service.js'),
    import('../memoryGuard.service.js')
  ])
  const db=dbModule.supabase
  const ready=await db.rpc('social_promotion_assignment_ready_v5')
  if(ready.error||ready.data!==true)throw new Error('SOCIAL_RUNTIME_ASSIGNMENT_GUARD_NOT_READY')
  const {data,error}=await db.rpc('social_promotion_poll_v5',{p_skip:[]})
  if(error||!Array.isArray(data?.due)||typeof data.hasWork!=='boolean')throw new Error('SOCIAL_RUNTIME_DATABASE_NOT_READY')
  const prepareMedia=mediaModule.createSocialPromotionMedia({
    publicUrl:process.env.R2_PUBLIC_URL,
    uploadFile:r2Module.uploadFileToR2,
    deleteFile:r2Module.deleteR2ObjectByUrl,
    lifecycleReady:()=>process.env.SOCIAL_PROMOTION_R2_LIFECYCLE_READY==='true',
    admit:()=>{
      const admission=memoryModule.evaluateHeavyJobAdmission({jobType:'r2_image',estimatedJobMb:140})
      return {...admission,allowed:admission.allowed===true&&!admission.active_manga_upload}
    }
  })
  const integration=integrationModule.createSocialPromotionIntegration({db,decryptToken:vaultModule.decryptSocialToken,prepareMedia})
  return schedulerModule.createSocialPromotionScheduler({db,integration,enabled,onError})
}})
export const startSocialPromotionScheduler=()=>runtime.start()
export const stopSocialPromotionScheduler=()=>runtime.stop()
