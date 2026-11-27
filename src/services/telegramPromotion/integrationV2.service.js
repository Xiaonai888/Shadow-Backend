import { createPromotionSourceV2 } from './sourceV2.service.js'
import { createPromotionQueueV2 } from './queueV2.service.js'
import { createPromotionUpdateQueueV2,createPromotionEditWorkerV2 } from './updateQueueV2.service.js'
import { createPromotionStatusSourceV2 } from './statusSourceV2.service.js'
import { createPromotionMessageBuilderV2,buildStoryPromotionV2 } from './messageV2.service.js'
import { createPromotionOptionalV2 } from './optionalV2.service.js'
import { createPromotionUpdatePreparerV2 } from './prepareUpdatesV2.service.js'
import { createPromotionValidatorV2 } from './validateV2.service.js'
import { createPromotionWorkerV2 } from './workerV2.service.js'
import { createPromotionCompletionV2 } from './completionV2.service.js'
import { promotionSlotsV2,nextPromotionSlotV2 } from './scheduleV2.service.js'

export function createPromotionIntegrationV2({db,queue,source,candidates,token,onError=()=>{},safeCoverUrl=null}){
  if(safeCoverUrl){
    const u=new URL(safeCoverUrl)
    if(u.protocol!=='https:'||u.username||u.password)throw new TypeError('Invalid safe cover URL')
    safeCoverUrl=u.href
  }
  const dataSource=createPromotionSourceV2(db)
  const optionalQueue=createPromotionQueueV2(db)
  const updateQueue=createPromotionUpdateQueueV2(db)
  const statusSource=createPromotionStatusSourceV2(db)
  const baseBuilder=createPromotionMessageBuilderV2({source:dataSource,statusSource,safeCoverUrl})
  const messageBuilder={async build(options){
    if(!options.story?.is_adult&&!options.episode?.is_adult)return baseBuilder.build({...options,approvedPublicPreview:false,approvedPublicCover:false})
    if(options.postType==='solo'||!safeCoverUrl)return null
    const statusContext=await statusSource.status(options.story.id,options.episode.id)
    return buildStoryPromotionV2({...options,story:{...options.story,title:options.language==='km'?'រឿងសម្រាប់មនុស្សពេញវ័យ':'Mature story'},episode:{...options.episode,title:'',content:''},authorName:'',content:'',statusContext,mangaPreview:null,approvedPublicPreview:false,approvedPublicCover:false,safeCoverUrl})
  }}
  const completion=createPromotionCompletionV2({db,source,onError})
  const optional=createPromotionOptionalV2({db,source:dataSource,storySource:source,queue:optionalQueue,messageBuilder})
  const prepare=createPromotionUpdatePreparerV2({source,updateQueue,messageBuilder,onError})
  const baseValidator=createPromotionValidatorV2({db,legacy:candidates,source,messageBuilder,safeCoverUrl})
  const validator={async validate(job,...args){
    if(job.job_key?.startsWith('completion:')){
      const {data,error}=await db.rpc('telegram_promotion_v2_completion_valid',{p_id:job.id})
      if(error)throw new Error('Completion validation failed')
      if(data!==true)return {eligible:false,reason:'completion_event_changed'}
    }
    return baseValidator.validate(job,...args)
  }}
  const worker=createPromotionWorkerV2({queue,optionalQueue,updateQueue,validator,token,onError})
  const editWorker=createPromotionEditWorkerV2({queue:updateQueue,token,onError})
  return {supports:language=>['km','en'].includes(language),prepare,optional,completion,worker,editWorker,updateQueue,slots:promotionSlotsV2,nextSlot:nextPromotionSlotV2}
}
