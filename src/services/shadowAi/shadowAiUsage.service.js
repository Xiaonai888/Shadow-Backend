import { supabase } from '../../config/supabase.js'
import { createShadowAiCore } from './shadowAiCore.service.js'
import { shadowAiError } from './shadowAiPolicy.js'

const DENIAL = Object.freeze({
  SHADOW_AI_DISABLED: [503, 'AI is disabled'],
  SHADOW_AI_DAILY_LIMIT: [429, 'Daily AI limit reached'],
  SHADOW_AI_USER_LIMIT: [429, 'Daily AI user limit reached'],
  SHADOW_AI_INVALID_REQUEST: [400, 'Invalid AI request'],
  SHADOW_AI_DUPLICATE_REQUEST: [409, 'Duplicate AI request'],
})

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args).abortSignal(AbortSignal.timeout(5000))
  if (error) throw shadowAiError('SHADOW_AI_USAGE_UNAVAILABLE', 'AI usage service is unavailable')
  return data
}

async function reserve({ requestId, actorUserId, role, task, model }) {
  const data = await rpc('shadow_ai_reserve_request_v1', {
    p_request_id: requestId, p_actor_user_id: actorUserId,
    p_role: role, p_task: task, p_model: model,
  })
  if (data?.ok === true && data.request_id === requestId) return
  const denied = Object.hasOwn(DENIAL, data?.code) ? DENIAL[data.code] : null
  if (denied) throw shadowAiError(data.code, denied[1], denied[0])
  throw shadowAiError('SHADOW_AI_USAGE_UNAVAILABLE', 'AI usage reservation failed')
}

async function finish({ requestId, status, inputTokens, outputTokens, errorCode }) {
  const data = await rpc('shadow_ai_finish_request_v1', {
    p_request_id: requestId, p_status: status,
    p_input_tokens: inputTokens, p_output_tokens: outputTokens, p_error_code: errorCode,
  })
  if (data !== true) throw shadowAiError('SHADOW_AI_USAGE_UNAVAILABLE', 'AI usage completion failed')
}

export const runShadowAi = createShadowAiCore({ reserve, finish })
