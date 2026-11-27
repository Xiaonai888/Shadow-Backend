import { prepareShadowAiTask, shadowAiError } from '../shadowAiPolicy.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { interpretShadowLocalConversation } from './shadowLocalConversation.js'
import { interpretShadowLocalRequirements } from './shadowLocalRequirements.js'

export const SHADOW_LOCAL_ENGINE_VERSION='shadow-local-v2'
export function createShadowLocalCoreV2({dictionary=createShadowLocalDictionary()}={}) {
  return async function runShadowLocal(request) {
    const task=prepareShadowAiTask(request)
    const start=performance.now(),input=JSON.parse(task.serialized)
    let data
    if(task.task==='reader_message') data=interpretShadowLocalConversation(input,dictionary)
    else if(task.task==='author_requirements') data=interpretShadowLocalRequirements(input)
    else throw shadowAiError('SHADOW_AI_LOCAL_TASK_NOT_READY','Local task is not available',503)
    return {data,engine:'local',model:SHADOW_LOCAL_ENGINE_VERSION,dictionaryVersion:dictionary.version,usage:{inputTokens:null,outputTokens:null,processingMs:Math.max(0,Math.round(performance.now()-start))}}
  }
}
