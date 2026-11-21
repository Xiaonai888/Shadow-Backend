import { requireCambodianAuthorPreOrderOwner } from '../services/authorPreOrderCampaign.service.js'
import {
  listPaidAuthorPreOrderOrders,
  exportPaidAuthorPreOrderOrders,
} from '../services/authorPreOrderPaidOrders.service.js'
import { buildAuthorPreOrderExcel } from '../services/authorPreOrderXlsx.service.js'

function privateResponse(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('X-Content-Type-Options', 'nosniff')
}

function handleFailure(res, error) {
  const status = Number(error?.statusCode)
  const isPublic = Number.isInteger(status) && status >= 400 && status < 600
  if (!isPublic) console.error('AUTHOR_PRE_ORDER_REPORT_FAILED:', String(error?.message || error))
  return res.status(isPublic ? status : 503).json({
    ok: false,
    code: isPublic ? error.code : 'PRE_ORDER_REPORT_UNAVAILABLE',
    message: isPublic ? error.message : 'Pre-order reports are temporarily unavailable',
  })
}

export async function getMyAuthorPreOrderPaidOrders(req, res) {
  privateResponse(res)
  try {
    const owner = await requireCambodianAuthorPreOrderOwner(req.user?.user_id)
    const result = await listPaidAuthorPreOrderOrders(owner, req.query)
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    return handleFailure(res, error)
  }
}

export async function downloadMyAuthorPreOrderPaidOrdersExcel(req, res) {
  privateResponse(res)
  try {
    const owner = await requireCambodianAuthorPreOrderOwner(req.user?.user_id)
    const report = await exportPaidAuthorPreOrderOrders(owner, req.query)
    const excel = buildAuthorPreOrderExcel(report)
    const day = new Date().toISOString().slice(0, 10)
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.set('Content-Disposition', `attachment; filename="author-preorder-paid-orders-${day}.xlsx"`)
    res.set('Content-Length', String(excel.length))
    return res.status(200).end(excel)
  } catch (error) {
    return handleFailure(res, error)
  }
}
