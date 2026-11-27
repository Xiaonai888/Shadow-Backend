import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { requireCambodianAuthorPreOrderOwner, getOwnedAuthorPreOrder } from '../services/authorPreOrderCampaign.service.js'
import { prepareAuthorPreOrderReview } from '../services/authorPreOrderOrderPreparation.service.js'
import { shadowAiConfig, shadowAiError } from '../services/shadowAi/shadowAiPolicy.js'
import { runShadowAi } from '../services/shadowAi/shadowAiUsage.service.js'
import { shadowAiPreOrderContext as contextService } from '../services/shadowAi/shadowAiPreOrderCatalog.service.js'
import { createShadowPreOrderBooking } from '../services/shadowAi/shadowAiPreOrderBooking.service.js'
import { createShadowAiDraftStore } from '../services/shadowAi/shadowAiPreOrderDraftStore.service.js'
import { createShadowAiPreOrderSession } from '../services/shadowAi/shadowAiPreOrderSession.service.js'
import { createShadowAiCheckoutBridge } from '../services/shadowAi/shadowAiPreOrderCheckoutBridge.service.js'
import { createShadowAiPreOrderAccess } from '../services/shadowAi/shadowAiPreOrderAccess.service.js'
import { createShadowAiRequirementsStore } from '../services/shadowAi/shadowAiPreOrderRequirementsStore.service.js'
import { createShadowAiEligibility } from '../services/shadowAi/shadowAiPreOrderEligibility.service.js'
import { getAuthorCheckoutDeliverySettings } from '../controllers/authorStore.controller.js'

const router=express.Router()
const access=createShadowAiPreOrderAccess({db:supabase})
const eligibility=createShadowAiEligibility({db:supabase,resolve:access.resolve,getDeliverySettings:getAuthorCheckoutDeliverySettings})
const requirements=createShadowAiRequirementsStore({db:supabase,runAi:runShadowAi,requireOwner:requireCambodianAuthorPreOrderOwner,getOwnedCampaign:getOwnedAuthorPreOrder})
const session=createShadowAiPreOrderSession({authorize:access.authorize,contextService,loadConfirmedRules:requirements.loadConfirmedRules,draftStore:createShadowAiDraftStore({db:supabase}),bookingTurn:createShadowPreOrderBooking({contextService,runAi:runShadowAi,loadConfirmedRules:requirements.loadConfirmedRules}),checkoutReview:createShadowAiCheckoutBridge({prepareReview:prepareAuthorPreOrderReview})})
const limiter=(limit,keyGenerator)=>rateLimit({windowMs:60000,limit,keyGenerator,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,code:'SHADOW_AI_RATE_LIMITED',message:'Too many requests'}})
const edge=limiter(60,req=>ipKeyGenerator(req.ip))
const reader=limiter(20,req=>String(req.user.user_id))
const writes=limiter(6,req=>String(req.user.user_id))
const actor=req=>req.user.user_id
async function enabled() {
  shadowAiConfig()
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
router.use(edge,requireUser,reader)
async function scope(req) {
  await enabled()
  const base={actorUserId:actor(req),conversationId:req.params.conversationId}
  return {...base,authorPageId:await access.resolve(base),campaignId:req.params.campaignId}
}
router.get('/conversations/:conversationId/campaigns',handle(req=>eligibility({actorUserId:actor(req),conversationId:req.params.conversationId,offset:Number(req.query.offset??0)})))
router.get('/conversations/:conversationId/campaigns/:campaignId/session',handle(async req=>session.open(await scope(req))))
router.post('/conversations/:conversationId/campaigns/:campaignId/message',writes,handle(async req=>session.message({...await scope(req),message:req.body?.message,revision:req.body?.revision})))
router.post('/conversations/:conversationId/campaigns/:campaignId/review',writes,handle(async req=>session.review({...await scope(req),revision:req.body?.revision})))
router.get('/author/campaigns/:campaignId/requirements',handle(req=>requirements.get(actor(req),req.params.campaignId)))
router.post('/author/campaigns/:campaignId/requirements/preview',writes,handle(req=>requirements.preview(actor(req),req.params.campaignId,req.body?.template_rules??[])))
router.put('/author/campaigns/:campaignId/requirements',writes,handle(req=>requirements.confirm(actor(req),req.params.campaignId,req.body)))
export default router
