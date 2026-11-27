import express from 'express'
import { rateLimit,ipKeyGenerator } from 'express-rate-limit'
import { requireAdminSession } from '../middleware/adminPermission.middleware.js'
import { telegramEventAdmin as admin, telegramEventPostNow } from '../services/telegramEvent/integration.service.js'
import { EventAdminError } from '../services/telegramEvent/validation.service.js'

const router=express.Router()
const identity=req=>String(req.admin?.admin_id||ipKeyGenerator(req.ip))
const reads=rateLimit({windowMs:60000,limit:60,keyGenerator:identity,standardHeaders:'draft-8',legacyHeaders:false})
const writes=rateLimit({windowMs:60000,limit:15,keyGenerator:identity,standardHeaders:'draft-8',legacyHeaders:false})
router.use(rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}))
router.use(requireAdminSession)
router.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store')
  if (!req.admin?.has_all_permissions) return res.status(403).json({ok:false,message:'Owner or Admin access required'})
  return next()
})
function handle(fn,status=200) {
  return async(req,res)=>{
    try { return res.status(status).json({ok:true,...await fn(req)}) }
    catch(error) {
      if (error instanceof EventAdminError) return res.status(error.status).json({ok:false,code:error.code,message:error.message})
      console.error('TELEGRAM_EVENT_ADMIN_ERROR',String(error?.message||'UNKNOWN').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,200))
      return res.status(500).json({ok:false,code:'TELEGRAM_EVENT_ADMIN_ERROR',message:'Telegram Event request failed'})
    }
  }
}
router.get('/',reads,handle(req=>admin.list(req.query)))
router.get('/channels',reads,handle(()=>admin.channels()))
router.patch('/channels/:language',writes,handle(async req=>({item:await admin.updateChannel(req.params.language,req.body)})))
router.get('/history',reads,handle(req=>admin.history(req.query)))
router.get('/:id',reads,handle(async req=>({item:await admin.detail(req.params.id)})))
router.post('/',writes,handle(req=>admin.create(req.body),201))
router.put('/:id',writes,handle(req=>admin.update(req.params.id,req.body)))
router.post('/:id/duplicate',writes,handle(req=>admin.duplicate(req.params.id,req.body?.revision),201))
router.post('/:id/archive',writes,handle(req=>admin.archive(req.params.id,req.body?.revision)))
router.post('/:id/post-now',writes,handle(req=>telegramEventPostNow(req.params.id,req.body),202))
export default router
