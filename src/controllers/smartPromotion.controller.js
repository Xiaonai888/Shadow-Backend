import jwt from 'jsonwebtoken'
import { getSmartAdReaderHash, SmartAdRequestError } from '../services/smartAdTracking.service.js'
import { parseSmartPromotionRequest, SmartPromotionInputError } from '../services/smartPromotionRequest.service.js'
import { getSmartPromotionRotation } from '../services/smartPromotionDelivery.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getReaderIdentity(req) {
  const readerHash = getSmartAdReaderHash(req)
  const authorization = String(req.headers?.authorization || '')
  if (!authorization) return { readerHash, readerId: null }
  const secret = String(process.env.JWT_SECRET || '')
  try {
    const claims = jwt.verify(authorization.slice(7), secret)
    const readerId = String(claims?.user_id || '').toLowerCase()
    if (claims?.type !== 'reader' || !UUID.test(readerId)) {
      throw new SmartAdRequestError('Reader authentication required', 403)
    }
    return { readerHash, readerId }
  } catch (error) {
    if (error instanceof SmartAdRequestError) throw error
    throw new SmartAdRequestError('Invalid reader authentication', 401)
  }
}

export async function postSmartPromotionActive(req, res) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const request = parseSmartPromotionRequest(req.body)
    const identity = getReaderIdentity(req)
    const rotation = await getSmartPromotionRotation({
      ...request,
      ...identity,
    })
    return res.status(200).json(rotation)
  } catch (error) {
    if (error instanceof SmartPromotionInputError || error instanceof SmartAdRequestError) {
      return res.status(error.status || 400).json({ ok: false, message: error.message })
    }
    console.error('SMART_PROMOTION_ACTIVE_ERROR:', error)
    return res.status(503).json({ ok: false, message: 'Special Promotion is temporarily unavailable' })
  }
}
