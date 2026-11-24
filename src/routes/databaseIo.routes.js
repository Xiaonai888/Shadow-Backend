import express from 'express'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getDatabaseIoView, normalizeDatabaseIoViewRange } from '../services/databaseIoView.service.js'

const router = express.Router()
const limiter = createRateLimit({key:'admin-database-io-view',windowMs:60000,max:20,message:'Too many Database IO requests. Please try again later.'})
const view = requireAdminPermission('system_control.view')
router.get('/', limiter, (req,res,next)=>{
  res.set('Cache-Control','no-store, private')
  if (!req.admin) return res.status(401).json({ok:false,message:'Admin authentication required.'})
  next()
}, view, (req,res)=>{
  const range = normalizeDatabaseIoViewRange(req.query.from,req.query.to)
  if (!range) return res.status(400).json({ok:false,message:'Choose a valid date range of up to 30 days.'})
  try { return res.json({ok:true,database_io:getDatabaseIoView(range)}) }
  catch { return res.status(503).json({ok:false,message:'Database IO history is temporarily unavailable.'}) }
})
export default router
