import express from 'express'
import {rateLimit,ipKeyGenerator} from 'express-rate-limit'
import {requireAdminSession} from '../middleware/adminPermission.middleware.js'
import {supabase} from '../config/supabase.js'
import {createSocialOAuthStateStore} from '../services/socialMedia/socialOAuthState.service.js'
import {createFacebookOAuth} from '../services/socialMedia/facebookOAuth.service.js'
import {createFacebookOAuthGrants} from '../services/socialMedia/facebookOAuthGrants.service.js'
import {createSocialOAuthAccountStore} from '../services/socialMedia/socialOAuthAccountStore.service.js'
import {createSocialOAuthReconnect} from '../services/socialMedia/socialOAuthReconnect.service.js'
import {createSocialOAuthAdminFlow,createSocialOAuthAdminHandlers,wrapSocialOAuthAdminOperation} from '../services/socialMedia/socialOAuthAdminFlow.service.js'
import {createThreadsOAuth} from '../services/socialMedia/threadsOAuth.service.js'
import {createThreadsOAuthAdmin} from '../services/socialMedia/threadsOAuthAdmin.service.js'
import {createSocialBotAssignments} from '../services/socialMedia/socialBotAssignments.service.js'

const router=express.Router()
const stateStore=createSocialOAuthStateStore(supabase)
const accountStore=createSocialOAuthAccountStore({db:supabase})
const reconnect=createSocialOAuthReconnect({db:supabase})
const options={onError:code=>console.error('SOCIAL_OAUTH_ADMIN_ERROR',code)}
const flow=createSocialOAuthAdminFlow({stateStore,facebook:createFacebookOAuth(),grantedPermissions:createFacebookOAuthGrants(),accountStore,reconnect})
const handlers=createSocialOAuthAdminHandlers(flow,options)
const threadsHandlers=createSocialOAuthAdminHandlers(createThreadsOAuthAdmin({stateStore,threads:createThreadsOAuth(),accountStore,reconnect}),options)
const assignments=createSocialBotAssignments(supabase)
const listAssignments=wrapSocialOAuthAdminOperation(async req=>({items:await assignments.list(req.body?.connectionIds)}),options)
const setAssignment=wrapSocialOAuthAdminOperation(req=>assignments.set(req.params.id,req.body?.bot,req.body?.assigned),options)
const identity=req=>String(req.admin?.admin_id||ipKeyGenerator(req.ip))
const limit=rateLimit({windowMs:60000,limit:6,keyGenerator:identity,standardHeaders:'draft-8',legacyHeaders:false})
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('Referrer-Policy','no-referrer');return next()})
router.use(rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}))
router.use(requireAdminSession)
router.use((req,res,next)=>{
  if(req.admin?.has_all_permissions!==true)return res.status(403).json({ok:false,code:'SOCIAL_ADMIN_PERMISSION_REQUIRED'})
  if(process.env.SOCIAL_PROMOTION_ADMIN_ENABLED!=='true'||process.env.SOCIAL_OAUTH_ADMIN_ENABLED!=='true')return res.status(503).json({ok:false,code:'SOCIAL_OAUTH_ADMIN_DISABLED'})
  return next()
})
router.post('/start',limit,handlers.start)
router.post('/complete',limit,handlers.complete)
router.post('/threads/start',limit,threadsHandlers.start)
router.post('/threads/complete',limit,threadsHandlers.complete)
router.post('/assignments/list',limit,listAssignments)
router.put('/assignments/:id',limit,setAssignment)
export default router
