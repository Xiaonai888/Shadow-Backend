import express from 'express'
import { rateLimit,ipKeyGenerator } from 'express-rate-limit'
import { requireAdminSession } from '../middleware/adminPermission.middleware.js'
import { listSocialConnections,connectSocialAccount,revokeSocialAccount,listSocialRules,createSocialRule,replaceSocialRule,listSocialJobs,cancelSocialJob } from '../controllers/adminSocialPromotion.controller.js'

const router=express.Router()
const identity=req=>String(req.admin?.admin_id||ipKeyGenerator(req.ip))
const reads=rateLimit({windowMs:60000,limit:60,keyGenerator:identity,standardHeaders:'draft-8',legacyHeaders:false})
const writes=rateLimit({windowMs:60000,limit:10,keyGenerator:identity,standardHeaders:'draft-8',legacyHeaders:false})
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
router.use(rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}))
router.use(requireAdminSession)
router.use((req,res,next)=>{
  if(req.admin?.has_all_permissions!==true)return res.status(403).json({ok:false,code:'SOCIAL_ADMIN_PERMISSION_REQUIRED'})
  if(process.env.SOCIAL_PROMOTION_ADMIN_ENABLED!=='true')return res.status(503).json({ok:false,code:'SOCIAL_ADMIN_DISABLED'})
  return next()
})
router.get('/connections',reads,listSocialConnections)
router.post('/connections',writes,connectSocialAccount)
router.post('/connections/:id/revoke',writes,revokeSocialAccount)
router.get('/rules',reads,listSocialRules)
router.post('/rules',writes,createSocialRule)
router.put('/rules/:id',writes,replaceSocialRule)
router.get('/jobs',reads,listSocialJobs)
router.post('/jobs/:id/cancel',writes,cancelSocialJob)
export default router
