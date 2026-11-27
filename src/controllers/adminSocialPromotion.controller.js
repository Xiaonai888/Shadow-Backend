import { supabase } from '../config/supabase.js'
import { createSocialPromotionRules } from '../services/socialMedia/socialPromotionRules.service.js'
import { createSocialPromotionAdmin } from '../services/socialMedia/socialPromotionAdmin.service.js'
import { createSocialPromotionConnectionStore, SocialAdminError } from '../services/socialMedia/socialPromotionConnectionStore.service.js'
import { verifyMetaFacebookConnection, verifyMetaInstagramConnection } from '../services/socialMedia/metaConnection.service.js'
import { encryptSocialToken } from '../services/socialMedia/tokenVault.service.js'

const admin=createSocialPromotionAdmin({db:supabase,rules:createSocialPromotionRules(supabase)})
const connections=createSocialPromotionConnectionStore({db:supabase,verifyFacebook:verifyMetaFacebookConnection,verifyInstagram:verifyMetaInstagramConnection,encryptToken:encryptSocialToken})
const safeCode=v=>typeof v==='string'&&/^SOCIAL_[A-Z0-9_]{1,90}$/.test(v)?v:'SOCIAL_ADMIN_REQUEST_FAILED'
function handle(operation){
  return async(req,res)=>{
    try{return res.json({ok:true,...await operation(req)})}
    catch(error){
      const status=error instanceof SocialAdminError?error.status:error instanceof TypeError?400:500
      const code=safeCode(error instanceof SocialAdminError?error.code:error?.message)
      if(status>=500)console.error('SOCIAL_PROMOTION_ADMIN_ERROR',code)
      return res.status(status).json({ok:false,code,message:code})
    }
  }
}
export const listSocialConnections=handle(req=>admin.listConnections(req.query))
export const connectSocialAccount=handle(async req=>{
  if(!req.body||Array.isArray(req.body)||typeof req.body!=='object')throw new SocialAdminError('SOCIAL_CONNECTION_INPUT_INVALID')
  const {platform,pageId,instagramId,token,expiresAt}=req.body
  delete req.body.token
  return {item:await connections.connect({platform,pageId,instagramId,token,expiresAt})}
})
export const revokeSocialAccount=handle(async req=>({item:await connections.revoke(req.params.id)}))
export const listSocialRules=handle(req=>admin.listRules(req.query))
export const createSocialRule=handle(async req=>({item:await admin.createRule(req.body)}))
export const replaceSocialRule=handle(async req=>({item:await admin.replaceRule(req.params.id,req.body?.rule,req.body?.revision)}))
export const listSocialJobs=handle(req=>admin.listJobs(req.query))
export const cancelSocialJob=handle(async req=>({item:await admin.cancelJob(req.params.id)}))
