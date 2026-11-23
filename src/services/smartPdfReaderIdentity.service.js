import { createHmac } from 'node:crypto'
import jwt from 'jsonwebtoken'

const VISITOR = /^[a-zA-Z0-9._:-]{8,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class SmartPdfRequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'SmartPdfRequestError'
    this.statusCode = statusCode
  }
}

export function getSmartPdfReaderIdentity(req, { secret = process.env.JWT_SECRET } = {}) {
  if (typeof secret !== 'string' || !secret.trim()) throw new Error('JWT_SECRET is missing')
  const authorization = String(req?.headers?.authorization || '').trim()
  let identity = ''
  let readerId = ''
  if (authorization) {
    if (!authorization.startsWith('Bearer ')) throw new SmartPdfRequestError('Invalid reader authorization', 401)
    let payload
    try {
      payload = jwt.verify(authorization.slice(7), secret)
    } catch {
      throw new SmartPdfRequestError('Invalid or expired reader session', 401)
    }
    if (payload?.type !== 'reader' || !UUID.test(String(payload.user_id || ''))) {
      throw new SmartPdfRequestError('Reader authentication required', 403)
    }
    readerId = String(payload.user_id).toLowerCase()
    identity = `reader:${readerId}`
  } else {
    const visitor = String(req?.headers?.['x-shadow-visitor-id'] || '').trim()
    if (!VISITOR.test(visitor)) throw new SmartPdfRequestError('Anonymous visitor ID is required')
    identity = `visitor:${visitor}`
  }
  return {
    readerId,
    readerHash: createHmac('sha256', secret).update(`shadow-smart-pdf:v1:${identity}`).digest('hex'),
  }
}
