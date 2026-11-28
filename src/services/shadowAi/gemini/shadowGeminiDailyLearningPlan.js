import { listShadowGeminiExamples } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'
import { createShadowLocalKnowledgeDictionary, normalizeShadowLocalKnowledge } from '../local/shadowLocalKnowledge.js'

export const SHADOW_GEMINI_BATCH_DAILY_LIMIT = 20
export const SHADOW_GEMINI_BATCH_RUN_LIMIT = 5
export const SHADOW_GEMINI_BATCH_TIMEZONE = 'Asia/Phnom_Penh'
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: SHADOW_GEMINI_BATCH_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })

export function shadowGeminiLearningWindow(ms) {
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) throw new TypeError('Invalid learning time')
  const parts = Object.fromEntries(clock.formatToParts(ms).map(part => [part.type, part.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, due: parts.hour === '02' }
}

export function planShadowGeminiDailyLearning({ snapshot, pending = [], budget = SHADOW_GEMINI_BATCH_DAILY_LIMIT } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > SHADOW_GEMINI_BATCH_DAILY_LIMIT || !Array.isArray(pending) || pending.length > 128) throw new TypeError('Invalid learning plan')
  const dictionary = createShadowLocalKnowledgeDictionary(snapshot)
  const rows = normalizeShadowLocalKnowledge(snapshot.aliases)
  const pendingKeys = new Set(pending.filter(row => row?.status === 'pending_review' && typeof row.key === 'string' && row.key.length <= 100).map(row => row.key))
  const lessons = [], seen = new Set()
  for (const { id, text } of listShadowGeminiExamples()) {
    const category = id.split('_')[0]
    if (category === 'unclear') continue
    const alias = shadowMatchKey(text).replace(/[?？។!！]+$/u, '').trim()
    const key = `questions:${alias}`
    if (seen.has(key) || pendingKeys.has(key) || dictionary.lookup('questions', alias)) continue
    try {
      const normalized = normalizeShadowLocalKnowledge([{ group: 'questions', alias, canonical: category }])
      if (normalized.length !== 1) continue
      normalizeShadowLocalKnowledge([...rows, ...normalized])
    } catch { continue }
    seen.add(key)
    lessons.push(id)
    if (lessons.length >= Math.min(budget, SHADOW_GEMINI_BATCH_RUN_LIMIT)) break
  }
  return budget === 0 ? [] : lessons
}
