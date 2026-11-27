export const SHADOW_GEMINI_MODEL = 'gemini-3.5-flash-lite'
export function geminiError(code, statusCode = 503) {
  return Object.assign(new Error(code), { code, statusCode })
}
export function shadowGeminiConfig(env = process.env) {
  if (env.SHADOW_GEMINI_ENABLED !== 'true') throw geminiError('SHADOW_AI_GEMINI_DISABLED')
  if (env.SHADOW_GEMINI_FREE_PROJECT_CONFIRMED !== 'true') throw geminiError('SHADOW_AI_GEMINI_FREE_PROJECT_REQUIRED')
  const apiKey = env.GEMINI_API_KEY
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/u.test(apiKey)) throw geminiError('SHADOW_AI_GEMINI_NOT_CONFIGURED')
  const raw = env.SHADOW_GEMINI_DAILY_LIMIT ?? '450'
  if (typeof raw !== 'string' || !/^\d{1,3}$/u.test(raw) || Number(raw) < 1 || Number(raw) > 450) throw geminiError('SHADOW_AI_GEMINI_LIMIT_INVALID')
  return Object.freeze({ model: SHADOW_GEMINI_MODEL, apiKey, dailyLimit: Number(raw), timeoutMs: 8000 })
}
