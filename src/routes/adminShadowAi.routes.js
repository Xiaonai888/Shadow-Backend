import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { adminHasPermission, requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createShadowAiAdminService } from '../services/shadowAi/shadowAiAdmin.service.js'

const router=express.Router()
const service=createShadowAiAdminService({db:supabase})
const guard=(limit,keyGenerator)=>rateLimit({windowMs:60000,limit,keyGenerator,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,code:'SHADOW_AI_ADMIN_RATE_LIMITED',message:'Too many AI management requests.'}})
const edge=guard(60,req=>ipKeyGenerator(req.ip))
const reads=guard(20,req=>String(req.admin.admin_id))
const writes=guard(6,req=>String(req.admin.admin_id))
const handle=fn=>async(req,res)=>{
  try { return res.json({ok:true,...await fn(req)}) }
  catch(e) {
    const known=/^SHADOW_AI_[A-Z0-9_]{1,80}$/.test(String(e?.code||'')) && Number.isInteger(e?.statusCode) && e.statusCode>=400 && e.statusCode<600
    if(!known) console.error('SHADOW_AI_ADMIN_FAILED',String(e?.name||'Error'))
    return res.status(known?e.statusCode:503).json({ok:false,code:known?e.code:'SHADOW_AI_ADMIN_UNAVAILABLE',message:known?e.message:'AI management is unavailable.'})
  }
}
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('Vary','Authorization');next()})
router.get('/overview',edge,requireAdminPermission('system_control.view'),reads,handle(async req=>({...await service.overview(req.query.days),can_manage:adminHasPermission(req.admin,'system_control.manage')})))
router.put('/settings',edge,requireAdminPermission('system_control.manage'),writes,handle(req=>service.update(req.admin.admin_id,req.body)))
export default router
