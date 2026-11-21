import {
  requireCambodianAuthorPreOrderOwner,
  listOwnedAuthorPreOrders,
  getOwnedAuthorPreOrder,
  saveOwnedAuthorPreOrderDraft,
} from '../services/authorPreOrderCampaign.service.js'

function respondError(res, error, action) {
  const status = Number(error?.statusCode)
  const publicError = Number.isInteger(status) && status >= 400 && status < 600
  if (!publicError) console.error(`AUTHOR_PRE_ORDER_${action}_FAILED:`, String(error?.message || error))
  return res.status(publicError ? status : 503).json({
    ok: false,
    code: publicError ? error.code : 'PRE_ORDER_SERVICE_UNAVAILABLE',
    message: publicError ? error.message : 'Pre-order service is temporarily unavailable',
  })
}

async function owner(req) {
  return requireCambodianAuthorPreOrderOwner(req.user?.user_id)
}

export async function listMyAuthorPreOrders(req, res) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const account = await owner(req)
    const result = await listOwnedAuthorPreOrders(account, req.query)
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    return respondError(res, error, 'LIST')
  }
}

export async function getMyAuthorPreOrder(req, res) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const account = await owner(req)
    const campaign = await getOwnedAuthorPreOrder(account, req.params.campaignId)
    return res.status(200).json({ ok: true, campaign })
  } catch (error) {
    return respondError(res, error, 'DETAIL')
  }
}

export async function createMyAuthorPreOrderDraft(req, res) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const account = await owner(req)
    const campaign = await saveOwnedAuthorPreOrderDraft(account, req.body)
    return res.status(201).json({ ok: true, campaign })
  } catch (error) {
    return respondError(res, error, 'CREATE')
  }
}

export async function updateMyAuthorPreOrderDraft(req, res) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const account = await owner(req)
    const campaign = await saveOwnedAuthorPreOrderDraft(account, req.body, req.params.campaignId)
    return res.status(200).json({ ok: true, campaign })
  } catch (error) {
    return respondError(res, error, 'UPDATE')
  }
}

export async function publishMyAuthorPreOrder(req, res) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const account = await owner(req)
    await getOwnedAuthorPreOrder(account, req.params.campaignId)
    return res.status(503).json({
      ok: false,
      code: 'PRE_ORDER_NOT_READY',
      message: 'Publishing is disabled until pre-order payments, quota reservation and order notifications are verified.',
    })
  } catch (error) {
    return respondError(res, error, 'PUBLISH')
  }
}
