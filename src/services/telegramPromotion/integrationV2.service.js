import { createPromotionSourceV2 } from './sourceV2.service.js'
import { createPromotionQueueV2 } from './queueV2.service.js'
import { createPromotionUpdateQueueV2,createPromotionEditWorkerV2 } from './updateQueueV2.service.js'
import { createPromotionStatusSourceV2 } from './statusSourceV2.service.js'
import { createPromotionMessageBuilderV2 } from './messageV2.service.js'
import { createPromotionOptionalV2 } from './optionalV2.service.js'
import { createPromotionUpdatePreparerV2 } from './prepareUpdatesV2.service.js'
import { createPromotionValidatorV2 } from './validateV2.service.js'
import { createPromotionWorkerV2 } from './workerV2.service.js'
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
  const messageBuilder=createPromotionMessageBuilderV2({source:dataSource,statusSource,safeCoverUrl})
  const optional=createPromotionOptionalV2({db,source:dataSource,storySource:source,queue:optionalQueue,messageBuilder})
  const prepare=createPromotionUpdatePreparerV2({source,updateQueue,messageBuilder,onError})
  const validator=createPromotionValidatorV2({db,legacy:candidates,source,messageBuilder,safeCoverUrl})
  const worker=createPromotionWorkerV2({queue,optionalQueue,updateQueue,validator,token,onError})
  const editWorker=createPromotionEditWorkerV2({queue:updateQueue,token,onError})
  return {supports:language=>['km','en'].includes(language),prepare,optional,worker,editWorker,updateQueue,slots:promotionSlotsV2,nextSlot:nextPromotionSlotV2}
}
