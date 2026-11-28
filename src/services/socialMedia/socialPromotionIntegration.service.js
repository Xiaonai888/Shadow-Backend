import { createSmartContentSource } from '../smartContent/contentSource.service.js'
import { sharedSelection, chooseSharedCaption } from '../smartContent/telegramContentBridge.service.js'
import { sharedSocialPostContent } from '../smartContent/socialPostContentBridge.service.js'
import { createPromotionStatusSourceV2 } from '../telegramPromotion/statusSourceV2.service.js'
import { adaptSocialPromotionPost } from './platformPostAdapter.service.js'
import { adaptThreadsPromotionPost } from './threadsPostAdapter.service.js'
import { createThreadsPromotionPublisher } from './threadsPromotionPublisher.service.js'
import { createSocialPromotionQueue } from './socialPromotionQueue.service.js'
import { createSocialPromotionWorkerStore } from './socialPromotionWorkerStore.service.js'
import { createSocialPromotionExceptions } from './socialPromotionExceptions.service.js'
import { createSocialPromotionPlanner } from './socialPromotionPlanner.service.js'
import { createSocialPromotionWorker } from './socialPromotionWorker.service.js'
import { createSocialPromotionContentSource } from './socialPromotionContentSource.service.js'
import { createSocialPromotionPostLoader } from './socialPromotionPostLoader.service.js'
import { publishFacebookPromotion } from './facebookPromotionPublisher.service.js'
import { prepareInstagramPromotion, createInstagramCarousel, publishInstagramContainer } from './instagramPromotionPublisher.service.js'

export function createSocialPromotionIntegration({db,decryptToken,prepareMedia,clock=Date.now}={}){
  if(!db?.rpc||typeof decryptToken!=='function'||typeof prepareMedia!=='function'||typeof clock!=='function')throw new TypeError('SOCIAL_INTEGRATION_DEPENDENCIES')
  const source=createSmartContentSource(db)
  const freshSource=createSocialPromotionContentSource(db)
  const queue=createSocialPromotionQueue(db)
  const store=createSocialPromotionWorkerStore(db)
  const statusSource=createPromotionStatusSourceV2(db)
  const loadPost=createSocialPromotionPostLoader({freshSource,sharedSource:source,postContent:sharedSocialPostContent,adaptPost:input=>input.platform==='threads'?adaptThreadsPromotionPost(input):adaptSocialPromotionPost(input),statusSource,clock})
  const planner=createSocialPromotionPlanner({source,selection:sharedSelection,chooseCaption:chooseSharedCaption,queue,updateSource:freshSource,exceptions:createSocialPromotionExceptions(db)})
  const worker=createSocialPromotionWorker({store,loadPost,decryptToken,prepareMedia,publishFacebook:publishFacebookPromotion,prepareInstagram:prepareInstagramPromotion,createInstagramCarousel,publishInstagramContainer,threadsPublisher:createThreadsPromotionPublisher()})
  return {
    plan(options){return planner.plan({...options,now:clock()})},
    runWorker(){return worker.run()},
    clearCache(){source.clearCache()}
  }
}
