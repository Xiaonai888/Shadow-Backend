import express from 'express'
import { supabase } from '../config/supabase.js'
import { createPromotionMonitorReport, PromotionReportInputError } from '../services/telegramPromotion/monitorReport.service.js'
const router=express.Router()
const report=createPromotionMonitorReport(supabase,{runtimeEnabled:()=>process.env.TELEGRAM_PROMOTION_ENABLED==='true'})
function read(operation){
  return async(req,res)=>{
    res.set('Cache-Control','private, no-store')
    try{return res.json({ok:true,...await operation(req)})}
    catch(error){
      if(error instanceof PromotionReportInputError)return res.status(400).json({ok:false,message:error.message})
      console.error('TELEGRAM_PROMOTION_MONITOR_REPORT_FAILED:',String(error?.message||'UNKNOWN').replace(/\b\d+(?::|%3a)[A-Za-z0-9_-]+/gi,'[redacted]').slice(0,300))
      return res.status(503).json({ok:false,code:'TELEGRAM_PROMOTION_MONITOR_UNAVAILABLE',message:'Promotion monitoring data is unavailable'})
    }
  }
}
router.get('/status',read(()=>report.status()))
router.get('/history',read(req=>report.history(req.query)))
export default router
