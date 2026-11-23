import { SMART_PDF_POLICY } from './smartPdfPolicy.service.js'

function hash(value) {
  let number = 2166136261
  for (const character of String(value)) {
    number = Math.imul(number ^ character.charCodeAt(0), 16777619)
  }
  return number >>> 0
}

export function smartPdfStableHash(value) {
  return hash(value)
}

function number(value) {
  return Math.max(0, Number(value) || 0)
}

function normalizeInterests(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value).slice(0, 24)
  return Object.fromEntries(entries.map(([name, weight]) => [
    String(name).trim().toLowerCase().slice(0, 60),
    Math.min(40, number(weight)),
  ]).filter(([name]) => name))
}

function recentTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : null
}

function readHistory(source, id) {
  return source instanceof Map ? source.get(id) : source?.[id]
}

export function selectSmartPdfCandidates({
  candidates = [], readerKey = 'visitor', slotKey = '', interests = {},
  recentExposure = new Map(), exposureTotals = {}, excludedProductIds = [],
  limit = SMART_PDF_POLICY.maxRecommendations, now = Date.now(),
} = {}) {
  const count = Number(limit)
  if (!Number.isSafeInteger(count) || count < 1 || count > SMART_PDF_POLICY.ownershipBatchSize * SMART_PDF_POLICY.maxOwnershipBatches) {
    throw new RangeError('Invalid PDF recommendation count')
  }
  const excluded = new Set((Array.isArray(excludedProductIds) ? excludedProductIds : []).map(String))
  const distinct = new Map()
  for (const record of Array.isArray(candidates) ? candidates : []) {
    const id = String(record?.product_id || '')
    if (!id || excluded.has(id) || distinct.has(id)) continue
    distinct.set(id, record)
  }
  const preferences = normalizeInterests(interests)
  const seed = `${readerKey}:${slotKey}`
  const scored = [...distinct.values()].map((product) => {
    const id = String(product.product_id)
    const genre = String(product.genre || '').trim().toLowerCase()
    const category = String(product.category || '').trim().toLowerCase()
    const created = Date.parse(String(product.created_at || ''))
    const fresh = Number.isFinite(created) && created <= now && now - created <= SMART_PDF_POLICY.freshProductMs
    const exposure = readHistory(recentExposure, id)
    const lastSeen = recentTimestamp(exposure)
    const recentlySeen = lastSeen !== null && lastSeen <= now && now - lastSeen < SMART_PDF_POLICY.exposureLookbackMs
    const totals = readHistory(exposureTotals, id) || {}
    const impressions = number(totals.impressions)
    const clicks = number(totals.clicks)
    const quality = (clicks + 1) / (impressions + 8)
    const affinity = number(preferences[genre]) * 15 + number(preferences[category]) * 4
    const lowExposure = 35 / (1 + Math.log1p(impressions))
    const randomness = hash(`${seed}:${id}`) / 4294967296 * 6
    const score = affinity + lowExposure + (fresh ? 20 : 0) + quality * 12 + randomness
    return { product, genre, recentlySeen, lastSeen, score }
  })
  const unseen = scored.filter((entry) => !entry.recentlySeen)
  const older = scored.filter((entry) => entry.recentlySeen)
  unseen.sort((a, b) => b.score - a.score || String(a.product.product_id).localeCompare(String(b.product.product_id)))
  older.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0) || b.score - a.score)
  const results = []
  const usedGenres = new Set()
  const take = (items) => {
    while (items.length && results.length < count) {
      let index = items.findIndex((item) => item.genre && !usedGenres.has(item.genre))
      if (index < 0) index = 0
      const [chosen] = items.splice(index, 1)
      results.push(chosen.product)
      if (chosen.genre) usedGenres.add(chosen.genre)
    }
  }
  take(unseen)
  if (results.length < count) take(older)
  return results
}
