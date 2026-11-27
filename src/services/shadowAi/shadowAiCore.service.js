import { randomUUID } from 'node:crypto'
import { prepareShadowAiTask, shadowAiConfig, shadowAiError } from './shadowAiPolicy.js'

function tokens(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null
}

function providerUsage(body) {
  return { inputTokens: tokens(body?.usage?.input_tokens), outputTokens: tokens(body?.usage?.output_tokens) }
}

function parseOutput(body) {
  if (body?.status !== 'completed' || !Array.isArray(body.output)) {
    throw shadowAiError('SHADOW_AI_INCOMPLETE', 'AI response was incomplete')
  }
  const messages = body.output.filter(item => item?.type === 'message' && item.role === 'assistant')
  const parts = messages.flatMap(item => Array.isArray(item.content) ? item.content : [])
  if (parts.some(part => part?.type === 'refusal')) throw shadowAiError('SHADOW_AI_REFUSED', 'AI could not process this request')
  const text = parts.filter(part => part?.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('')
  let data
  try { data = JSON.parse(text) } catch { throw shadowAiError('SHADOW_AI_INVALID_OUTPUT', 'AI response was invalid') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw shadowAiError('SHADOW_AI_INVALID_OUTPUT', 'AI response was invalid')
  return data
}

export function createShadowAiCore({ reserve, finish, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (typeof reserve !== 'function' || typeof finish !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('AI dependencies are required')
  const actors = new Set()
  let active = 0
  return async function runShadowAi(request) {
    const config = shadowAiConfig(env)
    const job = prepareShadowAiTask(request)
    if (active >= config.maxConcurrent || actors.has(job.actorUserId)) {
      throw shadowAiError('SHADOW_AI_BUSY', 'AI is busy. Please try again.', 429)
    }
    const requestId = randomUUID()
    active++
    actors.add(job.actorUserId)
    let reserved = false
    let usage = { inputTokens: null, outputTokens: null }
    let result
    let failure
    try {
      await reserve({ requestId, actorUserId: job.actorUserId, role: job.role, task: job.task, model: config.model })
      reserved = true
      const signal = AbortSignal.timeout(config.timeoutMs)
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal,
        body: JSON.stringify({
          model: config.model,
          store: false,
          instructions: job.instructions,
          input: [{ role: 'user', content: job.serialized }],
          max_output_tokens: config.maxOutputTokens,
          text: { format: { type: 'json_schema', name: `shadow_${job.task}`, strict: true, schema: job.schema } },
        }),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw shadowAiError(response.status === 429 ? 'SHADOW_AI_PROVIDER_LIMIT' : 'SHADOW_AI_PROVIDER_ERROR', 'AI provider is temporarily unavailable')
      }
      const body = await response.json()
      usage = providerUsage(body)
      result = parseOutput(body)
    } catch (error) {
      failure = typeof error?.code === 'string' && /^SHADOW_AI_[A-Z0-9_]{1,80}$/.test(error.code)
        ? error : shadowAiError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'SHADOW_AI_TIMEOUT' : 'SHADOW_AI_UNAVAILABLE', 'AI is temporarily unavailable')
    } finally {
      try {
        if (reserved) await finish({ requestId, status: failure ? 'error' : 'ok', ...usage, errorCode: failure?.code || null })
      } catch {
        if (!failure) failure = shadowAiError('SHADOW_AI_USAGE_UNAVAILABLE', 'AI usage could not be recorded')
      } finally {
        active--
        actors.delete(job.actorUserId)
      }
    }
    if (failure) throw failure
    return { requestId, data: result, usage }
  }
}
