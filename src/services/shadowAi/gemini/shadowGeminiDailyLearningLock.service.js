import { geminiError } from './shadowGeminiConfig.js'

const validDay = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
}

export function createShadowGeminiDailyLearningLock({ db } = {}) {
  if (typeof db?.rpc !== 'function') throw new TypeError('Daily learning lock database required')
  return async function claimDay({ day } = {}) {
    if (!validDay(day)) throw geminiError('SHADOW_AI_GEMINI_LEARNING_DAY_INVALID', 400)
    let response
    try {
      response = await db.rpc('shadow_ai_gemini_claim_learning_day_v1', { p_day: day }).abortSignal(AbortSignal.timeout(5000))
    } catch {
      throw geminiError('SHADOW_AI_GEMINI_LEARNING_LOCK_UNAVAILABLE')
    }
    if (response?.error || typeof response?.data !== 'boolean') throw geminiError('SHADOW_AI_GEMINI_LEARNING_LOCK_UNAVAILABLE')
    return response.data
  }
}
