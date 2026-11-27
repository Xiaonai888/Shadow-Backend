import { shadowGeminiConfig, geminiError } from './shadowGeminiConfig.js'
import { getShadowGeminiExample, SHADOW_GEMINI_QUESTION_TYPES } from './shadowGeminiExamples.js'

async function readBounded(response) {
  if (!response.body || Number(response.headers.get('content-length') || 0) > 32768) throw geminiError('SHADOW_AI_GEMINI_INVALID_RESPONSE')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 32768) throw geminiError('SHADOW_AI_GEMINI_INVALID_RESPONSE')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw geminiError('SHADOW_AI_GEMINI_INVALID_RESPONSE')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function classify(body) {
  const candidates = body?.candidates
  if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0]?.finishReason !== 'STOP') throw geminiError('SHADOW_AI_GEMINI_INVALID_RESPONSE')
  const parts = candidates[0]?.content?.parts
  if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0]?.text !== 'string' || parts[0].thought === true || parts[0].text.length > 256) throw geminiError('SHADOW_AI_GEMINI_INVALID_RESPONSE')
  let result
  try { result = JSON.parse(parts[0].text) } catch { throw geminiError('SHADOW_AI_GEMINI_INVALID_RESPONSE') }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || !SHADOW_GEMINI_QUESTION_TYPES.includes(result.question)) throw geminiError('SHADOW_AI_GEMINI_INVALID_RESPONSE')
  return result.question
}
export function createShadowGeminiTeacher({ reserve, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  if (typeof reserve !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('Gemini teacher dependencies required')
  let busy = false, cooldownUntil = 0
  return async function testExample(exampleId) {
    const text = getShadowGeminiExample(exampleId)
    if (!text) throw geminiError('SHADOW_AI_GEMINI_EXAMPLE_INVALID', 400)
    const config = shadowGeminiConfig(env)
    if (busy || now() < cooldownUntil) throw geminiError('SHADOW_AI_GEMINI_BUSY', 429)
    busy = true
    try {
      const allowed = await reserve({ dailyLimit: config.dailyLimit })
      if (allowed !== true) throw geminiError('SHADOW_AI_GEMINI_QUOTA', 429)
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Classify a synthetic book preorder question. Return only the category. Do not answer the question or infer actual prices, stock, personal details, or payment information. Use unclear if ambiguous.' }] },
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { candidateCount: 1, maxOutputTokens: 256, temperature: 0, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { question: { type: 'STRING', enum: SHADOW_GEMINI_QUESTION_TYPES } }, required: ['question'] } },
        }),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        cooldownUntil = now() + 60000
        throw geminiError(response.status === 429 ? 'SHADOW_AI_GEMINI_PROVIDER_LIMIT' : 'SHADOW_AI_GEMINI_PROVIDER_ERROR', response.status === 429 ? 429 : 503)
      }
      const question = classify(await readBounded(response))
      return { example_id: exampleId, model: config.model, question, test_only: true, external_requests: 1, knowledge_published: false }
    } catch (error) {
      if (typeof error?.code === 'string' && /^SHADOW_AI_GEMINI_[A-Z_]+$/u.test(error.code)) throw error
      cooldownUntil = now() + 60000
      throw geminiError('SHADOW_AI_GEMINI_UNAVAILABLE')
    } finally { busy = false }
  }
}
