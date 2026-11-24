import express from 'express'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { normalizeDatabaseIoViewRange } from '../services/databaseIoView.service.js'
import { buildDatabaseIoDownload } from '../services/databaseIoDownload.service.js'
import { formatDatabaseIoReport } from '../services/databaseIoReportFormat.service.js'

const router=express.Router()
const limiter=createRateLimit({key:'admin-database-io-download',windowMs:60000,max:4,message:'Too many Database IO downloads. Please try again later.'})
const view=requireAdminPermission('system_control.view')
router.get('/',limiter,(req,res,next)=>{
  res.set('Cache-Control','no-store, private')
  if(!req.admin)return res.status(401).json({ok:false,message:'Admin authentication required.'})
  next()
},view,async(req,res)=>{
  const range=normalizeDatabaseIoViewRange(req.query.from,req.query.to)
  const format=req.query.format??'md'
  if(!range||!['md','json'].includes(format))return res.status(400).json({ok:false,message:'Choose a valid date range of up to 30 days and a supported format.'})
  try {
    const report=await buildDatabaseIoDownload(range)
    if(!report)return res.status(503).json({ok:false,message:'Another Database IO report is being prepared.'})
    const body=format==='json'?JSON.stringify(report,null,2):formatDatabaseIoReport(report)
    res.set('Content-Type',format==='json'?'application/json; charset=utf-8':'text/plain; charset=utf-8')
    res.set('Content-Disposition',`attachment; filename="shadow-database-io.${format}"`)
    return res.status(200).send(body)
  }catch{return res.status(503).json({ok:false,message:'Database IO report is temporarily unavailable.'})}
})
export default router
