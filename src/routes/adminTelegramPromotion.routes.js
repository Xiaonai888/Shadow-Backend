import express from 'express'
import { rateLimit,ipKeyGenerator } from 'express-rate-limit'
import { requireAdminSession } from '../middleware/adminPermission.middleware.js'
import { getTelegramPromotionSettings,updateTelegramPromotionSettings,listTelegramPromotionQueue,cancelTelegramPromotionJob } from '../controllers/adminTelegramPromotion.controller.js'

const router=express.Router()
const identity=req=>String(req.admin?.admin_id || ipKeyGenerator(req.ip))
const reads=rateLimit({windowMs:60000,limit:60,keyGenerator:identity,standardHeaders:'draft-8',legacyHeaders:false})
const writes=rateLimit({windowMs:60000,limit:10,keyGenerator:identity,standardHeaders:'draft-8',legacyHeaders:false})
router.use(rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}))
router.use(requireAdminSession)
router.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store')
  if(!req.admin?.has_all_permissions) return res.status(403).json({ok:false,message:'Owner or Admin access required'})
  return next()
})
router.get('/settings',reads,getTelegramPromotionSettings)
router.patch('/settings/:language',writes,updateTelegramPromotionSettings)
router.get('/queue',reads,listTelegramPromotionQueue)
router.post('/queue/:id/cancel',writes,cancelTelegramPromotionJob)
export default router
