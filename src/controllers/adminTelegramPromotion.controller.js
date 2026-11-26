import { supabase } from '../config/supabase.js'
import { createPromotionAdmin, PromotionAdminError } from '../services/telegramPromotion/admin.service.js'
import { wakeTelegramPromotionScheduler } from '../services/telegramPromotion/runtime.service.js'

const admin=createPromotionAdmin(supabase,{
  tokenConfigured:language=>/^\d+:[A-Za-z0-9_-]+$/.test(String(process.env[`TELEGRAM_PROMOTION_BOT_TOKEN_${language.toUpperCase()}`] || process.env.TELEGRAM_PROMOTION_BOT_TOKEN || '').trim()),
  runtimeEnabled:()=>process.env.TELEGRAM_PROMOTION_ENABLED==='true',
  wake:wakeTelegramPromotionScheduler,
})
function handle(operation) {
  return async (req,res)=>{
    try { return res.json({ok:true,...await operation(req)}) }
    catch(error) {
      if(error instanceof PromotionAdminError) return res.status(error.status).json({ok:false,message:error.message})
      console.error('TELEGRAM_PROMOTION_ADMIN_ERROR',String(error?.message || 'UNKNOWN').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,200))
      return res.status(500).json({ok:false,message:'Telegram Promotion request failed'})
    }
  }
}
export const getTelegramPromotionSettings=handle(()=>admin.settings())
export const updateTelegramPromotionSettings=handle(async req=>({setting:await admin.update(req.params.language,req.body)}))
export const listTelegramPromotionQueue=handle(req=>admin.list(req.query))
export const cancelTelegramPromotionJob=handle(async req=>({item:await admin.cancel(req.params.id)}))
