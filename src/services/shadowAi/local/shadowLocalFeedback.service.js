import { createHmac, randomBytes } from 'node:crypto'

const scopeKeys = ['actorUserId', 'conversationId', 'campaignId']
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const tokenPattern = /^[a-f0-9]{48}$/
const maxCount = 2147483647
const ratings = new Set(['correct', 'incorrect'])

export function createShadowLocalFeedback({ now = Date.now, ttlMs = 900000, maxPending = 512 } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 1800000 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 2048) throw new TypeError('Invalid feedback configuration')
  const secret = randomBytes(32)
  const receipts = new Map()
  const counts = { correct: 0, incorrect: 0 }
  function scopeDigest(scope) {
    if (!scopeKeys.every(key => typeof scope?.[key] === 'string' && uuid.test(scope[key]))) return null
    return createHmac('sha256', secret).update(scopeKeys.map(key => scope[key].toLowerCase()).join(':')).digest('hex')
  }
  function prune(time) {
    for (const [token, receipt] of receipts) if (receipt.expiresAt <= time) receipts.delete(token)
  }
  return Object.freeze({
    issue(scope) {
      const digest = scopeDigest(scope), time = now()
      if (!digest || !Number.isFinite(time)) return null
      if (receipts.size >= maxPending) prune(time)
      if (receipts.size >= maxPending) return null
      const token = randomBytes(24).toString('hex')
      if (receipts.has(token)) return null
      receipts.set(token, { digest, expiresAt: time + ttlMs })
      return token
    },
    submit({ token, scope, rating } = {}) {
      if (typeof token !== 'string' || !tokenPattern.test(token) || !ratings.has(rating)) return { accepted: false }
      const digest = scopeDigest(scope), receipt = receipts.get(token), time = now()
      if (!digest || !receipt || !Number.isFinite(time)) return { accepted: false }
      if (receipt.expiresAt <= time) { receipts.delete(token); return { accepted: false } }
      if (receipt.digest !== digest) return { accepted: false }
      receipts.delete(token)
      counts[rating] = Math.min(maxCount, counts[rating] + 1)
      return { accepted: true }
    },
    snapshot() { return { counts: { ...counts }, accuracy_verified: false, persistence: 'process_memory' } },
  })
}
