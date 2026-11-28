import { shadowGeminiConfig, geminiError, SHADOW_GEMINI_MODEL, SHADOW_GEMINI_MAX_DAILY_LIMIT } from './shadowGeminiConfig.js'
import { listShadowGeminiExamples, getShadowGeminiExample, SHADOW_GEMINI_QUESTION_TYPES } from './shadowGeminiExamples.js'
import { createShadowGeminiTeacher } from './shadowGeminiTeacher.service.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'
import { normalizeShadowLocalKnowledge } from '../local/shadowLocalKnowledge.js'

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
function quotaDay(ms) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(ms).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
function requireAdultTool(env) {
  if (env.SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED !== 'true') throw geminiError('SHADOW_AI_GEMINI_ADULT_TOOL_REQUIRED')
}
export function createShadowGeminiManagement({ db, knowledgeStore, env = process.env, now = Date.now, fetchImpl = globalThis.fetch } = {}) {
  if (typeof db?.rpc !== 'function' || typeof db?.from !== 'function' || typeof knowledgeStore?.getDictionary !== 'function' || typeof now !== 'function') throw new TypeError('Gemini management dependencies required')
  const teacher = createShadowGeminiTeacher({ env, now, fetchImpl, reserve: async ({ dailyLimit }) => {
    requireAdultTool(env)
    const { data, error } = await db.rpc('shadow_ai_gemini_reserve_v1', { p_daily_limit: dailyLimit }).abortSignal(AbortSignal.timeout(5000))
    if (error || typeof data !== 'boolean') throw geminiError('SHADOW_AI_GEMINI_QUOTA_UNAVAILABLE')
    return data
  } })
  async function status() {
    let config = null, reason = null
    try { requireAdultTool(env); config = shadowGeminiConfig(env) }
    catch (e) { reason = e.code || 'SHADOW_AI_GEMINI_NOT_CONFIGURED' }
    let quota = null
    try {
      const { data, error } = await db.from('shadow_ai_gemini_quota').select('quota_day,day_count,minute_started_at,minute_count').eq('id', 1).maybeSingle().abortSignal(AbortSignal.timeout(5000))
      const ms = now(), day = quotaDay(ms), start = Date.parse(data?.minute_started_at)
      if (!error && data && /^\d{4}-\d{2}-\d{2}$/u.test(data.quota_day) && data.quota_day <= day && Number.isInteger(data.day_count) && data.day_count >= 0 && data.day_count <= SHADOW_GEMINI_MAX_DAILY_LIMIT && Number.isInteger(data.minute_count) && data.minute_count >= 0 && data.minute_count <= 5 && Number.isFinite(start) && start <= ms) {
        const used = data.quota_day === day ? data.day_count : 0
        quota = { day, reserved_today: used, daily_limit: config?.dailyLimit ?? null, remaining_local: config ? Math.max(0, config.dailyLimit - used) : null, minute_limit: 5, reserved_this_window: ms - start < 60000 ? data.minute_count : 0, timezone: 'America/Los_Angeles' }
      }
    } catch {}
    return { configured: Boolean(config), available: Boolean(config && quota), reason: reason ?? (quota ? null : 'SHADOW_AI_GEMINI_QUOTA_UNAVAILABLE'), model: SHADOW_GEMINI_MODEL, mode: 'synthetic_admin_only', reader_fallback_enabled: false, quota, provider_quota_verified: false, examples: listShadowGeminiExamples() }
  }
  async function testExample(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'example_id')) throw geminiError('SHADOW_AI_GEMINI_EXAMPLE_INVALID', 400)
    const text = getShadowGeminiExample(input.example_id)
    if (!text) throw geminiError('SHADOW_AI_GEMINI_EXAMPLE_INVALID', 400)
    const dictionary = await knowledgeStore.getDictionary()
    const alias = shadowMatchKey(text).replace(/[?？។!！]+$/u, '').trim()
    const localQuestion = dictionary.lookup('questions', alias)
    const base = { example_id: input.example_id, test_only: true, knowledge_published: false, reader_fallback_enabled: false, dictionary_version: dictionary.version }
    if (SHADOW_GEMINI_QUESTION_TYPES.includes(localQuestion) && localQuestion !== 'unclear') return { ...base, engine: 'local', question: localQuestion, external_requests: 0, candidate: null }
    requireAdultTool(env)
    const result = await teacher(input.example_id)
    let candidate = null
    if (result.question !== 'unclear') {
      try { candidate = normalizeShadowLocalKnowledge([{ group: 'questions', alias, canonical: result.question }])[0] ?? null }
      catch {}
    }
    return { ...base, engine: 'gemini', model: result.model, question: result.question, external_requests: result.external_requests, candidate }
  }
  return Object.freeze({ status, testExample })
}
