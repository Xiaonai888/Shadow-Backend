import { createHmac, randomBytes } from 'node:crypto'

const fields = ['actorUserId', 'authorPageId', 'campaignId', 'conversationId']
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const validRevision = value => value === null || Number.isSafeInteger(value) && value >= 0
const questions = new Set(['books', 'price', 'stock', 'delivery', 'signature', 'schedule', 'requirements'])

export function createShadowLocalShortMemory({ now = Date.now, ttlMs = 600000, maxEntries = 512 } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600000 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 512) throw new TypeError('Invalid short memory configuration')
  const secret = randomBytes(32), entries = new Map()
  const keyFor = scope => fields.every(field => typeof scope?.[field] === 'string' && uuid.test(scope[field])) ? createHmac('sha256', secret).update(fields.map(field => scope[field].toLowerCase()).join(':')).digest('hex') : null
  function prune(time) {
    for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key)
  }
  return Object.freeze({
    remember({ scope, revision, intent, question } = {}) {
      const key = keyFor(scope), time = now()
      if (!key || !validRevision(revision) || !Number.isFinite(time)) return false
      entries.delete(key)
      if (intent !== 'question' || !questions.has(question)) return false
      if (entries.size >= maxEntries) prune(time)
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value)
      entries.set(key, { revision, question, expiresAt: time + ttlMs })
      return true
    },
    read({ scope, revision } = {}) {
      const key = keyFor(scope), time = now()
      if (!key || !validRevision(revision) || !Number.isFinite(time)) return null
      const entry = entries.get(key)
      if (!entry) return null
      if (entry.expiresAt <= time || entry.revision !== revision) { entries.delete(key); return null }
      return { question: entry.question }
    },
    clear(scope) { const key = keyFor(scope); return key !== null && entries.delete(key) },
    size() { const time = now(); if (Number.isFinite(time)) prune(time); return entries.size },
  })
}
