import { supabase } from '../config/supabase.js'
import { createSocialPromotionExceptions, SocialExceptionError } from '../services/socialMedia/socialPromotionExceptions.service.js'

const exceptions=createSocialPromotionExceptions(supabase)
function handle(operation){
  return async(req,res)=>{
    try{return res.json({ok:true,...await operation(req)})}
    catch(error){
      const known=error instanceof SocialExceptionError
      const status=known?error.status:500,code=known?error.code:'SOCIAL_EXCEPTION_REQUEST_FAILED'
      if(status>=500)console.error('SOCIAL_PROMOTION_EXCEPTION_ERROR',code)
      return res.status(status).json({ok:false,code,message:code})
    }
  }
}
export const listSocialExceptions=handle(req=>exceptions.list(req.query,true))
export const searchSocialExceptions=handle(req=>exceptions.list(req.query,false))
export const addSocialException=handle(req=>exceptions.change(req.body??{},true))
export const removeSocialException=handle(req=>exceptions.change({kind:req.params.kind,id:req.params.id},false))
