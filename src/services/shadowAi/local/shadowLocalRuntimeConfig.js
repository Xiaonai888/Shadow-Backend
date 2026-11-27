import { shadowAiError } from '../shadowAiPolicy.js'

export const SHADOW_LOCAL_RUNTIME_VERSION='shadow-local-v3'
export function shadowLocalRuntimeConfig(env=process.env) {
  if(env.SHADOW_AI_ENABLED!=='true') throw shadowAiError('SHADOW_AI_DISABLED','AI is disabled')
  if(env.SHADOW_AI_ENGINE!==undefined&&env.SHADOW_AI_ENGINE!=='local') throw shadowAiError('SHADOW_AI_NOT_CONFIGURED','Only the local AI engine is configured')
  return Object.freeze({engine:'local',model:SHADOW_LOCAL_RUNTIME_VERSION,maxConcurrent:2})
}
