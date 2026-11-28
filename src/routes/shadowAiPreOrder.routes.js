import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { requireCambodianAuthorPreOrderOwner, getOwnedAuthorPreOrder } from '../services/authorPreOrderCampaign.service.js'
import { prepareAuthorPreOrderReview } from '../services/authorPreOrderOrderPreparation.service.js'
import { shadowAiError } from '../services/shadowAi/shadowAiPolicy.js'
import { shadowLocalRuntimeConfig } from '../services/shadowAi/local/shadowLocalRuntimeConfig.js'
import { runShadowAi } from '../services/shadowAi/shadowAiUsage.service.js'
import { shadowLocalInstance } from '../services/shadowAi/local/shadowLocalInstance.service.js'
import { shadowAiPreOrderContext as contextService } from '../services/shadowAi/shadowAiPreOrderCatalog.service.js'
import { createShadowPreOrderBooking } from '../services/shadowAi/shadowAiPreOrderBooking.service.js'
import { createShadowAiDraftStore } from '../services/shadowAi/shadowAiPreOrderDraftStore.service.js'
import { createShadowAiPreOrderSession } from '../services/shadowAi/shadowAiPreOrderSession.service.js'
import { createShadowAiCheckoutBridge } from '../services/shadowAi/shadowAiPreOrderCheckoutBridge.service.js'
import { createShadowAiPreOrderAccess } from '../services/shadowAi/shadowAiPreOrderAccess.service.js'
import { createShadowAiPreOrderInitialAccess } from '../services/shadowAi/shadowAiPreOrderInitialAccess.service.js'
import { createShadowAiRequirementsStore } from '../services/shadowAi/shadowAiPreOrderRequirementsStore.service.js'
import { createShadowAiEligibility } from '../services/shadowAi/shadowAiPreOrderEligibility.service.js'
import { getAuthorCheckoutDeliverySettings } from '../controllers/authorStore.controller.js'

const router=express.Router()
const access=createShadowAiPreOrderAccess({db:supabase})
const initialAccess=createShadowAiPreOrderInitialAccess({access})
const eligibility=createShadowAiEligibility({db:supabase,resolve:access.resolve,getDeliverySettings:getAuthorCheckoutDeliverySettings})
const requirements=createShadowAiRequirementsStore({db:supabase,runAi:runShadowAi,requireOwner:requireCambodianAuthorPreOrderOwner,getOwnedCampaign:getOwnedAuthorPreOrder})
const preOrderBridge=shadowLocalInstance.preOrderBridge
const session=createShadowAiPreOrderSession({authorize:access.authorize,authorizeInitial:initialAccess.authorizeInitial,contextService,loadConfirmedRules:requirements.loadConfirmedRules,draftStore:createShadowAiDraftStore({db:supabase}),bookingTurn:createShadowPreOrderBooking({contextService,runAi:runShadowAi,loadConfirmedRules:requirements.loadConfirmedRules,preOrderBridge}),commitTurn:preOrderBridge.commitTurn,checkoutReview:createShadowAiCheckoutBridge({prepareReview:prepareAuthorPreOrderReview})})
const limiterOptions={windowMs:60000,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,code:'SHADOW_AI_RATE_LIMITED',message:'Too many requests'}}
const edge=rateLimit({...limiterOptions,limit:60,keyGenerator:req=>ipKeyGenerator(req.ip)})
const reader=rateLimit({...limiterOptions,limit:20,keyGenerator:req=>String(req.user.user_id)})
const writes=rateLimit({...limiterOptions,limit:6,keyGenerator:req=>String(req.user.user_id)})
const actor=req=>req.user.user_id
async function enabled() {
  shadowLocalRuntimeConfig()
  const {data,error}=await supabase.from('shadow_ai_settings').select('enabled,preorder_enabled').eq('id',1).maybeSingle().abortSignal(AbortSignal.timeout(5000))
  if(error) throw shadowAiError('SHADOW_AI_SETTINGS_UNAVAILABLE','AI settings are unavailable')
  if(data?.enabled!==true || data?.preorder_enabled!==true) throw shadowAiError('SHADOW_AI_DISABLED','AI is disabled')
}
const handle=(fn)=>async(req,res)=>{
  res.set('Cache-Control','private, no-store, max-age=0')
  res.set('Vary','Authorization')
  try { return res.json({ok:true,...await fn(req)}) }
  catch(e) {
    const known=/^(SHADOW_AI|PRE_ORDER)_[A-Z0-9_]{1,100}$/.test(String(e?.code||'')) && Number.isInteger(e?.statusCode) && e.statusCode>=400 && e.statusCode<600
    if(!known) console.error('SHADOW_AI_ROUTE_FAILED',String(e?.name||'Error'))
    return res.status(known?e.statusCode:503).json({ok:false,code:known?e.code:'SHADOW_AI_UNAVAILABLE',message:known?e.message:'AI booking is temporarily unavailable'})
  }
}
async function scope(req) {
  await enabled()
  return initialAccess.prepare({actorUserId:actor(req),conversationId:req.params.conversationId,campaignId:req.params.campaignId})
}
router.get('/conversations/:conversationId/campaigns',edge,requireUser,reader,handle(req=>eligibility({actorUserId:actor(req),conversationId:req.params.conversationId,offset:Number(req.query.offset??0)})))
router.get('/conversations/:conversationId/campaigns/:campaignId/session',edge,requireUser,reader,handle(async req=>session.open(await scope(req))))
router.post('/conversations/:conversationId/campaigns/:campaignId/message',edge,requireUser,reader,writes,handle(async req=>session.message({...await scope(req),message:req.body?.message,revision:req.body?.revision,locale:typeof req.body?.locale==='string'&&req.body.locale.length<=32?req.body.locale:undefined})))
router.post('/conversations/:conversationId/campaigns/:campaignId/review',edge,requireUser,reader,writes,handle(async req=>session.review({...await scope(req),revision:req.body?.revision})))
router.get('/author/campaigns/:campaignId/requirements',edge,requireUser,reader,handle(req=>requirements.get(actor(req),req.params.campaignId)))
router.post('/author/campaigns/:campaignId/requirements/preview',edge,requireUser,reader,writes,handle(req=>requirements.preview(actor(req),req.params.campaignId,req.body?.template_rules??[])))
router.put('/author/campaigns/:campaignId/requirements',edge,requireUser,reader,writes,handle(req=>requirements.confirm(actor(req),req.params.campaignId,req.body)))
export default router
