import { shadowAiError, prepareShadowAiTask } from '../shadowAiPolicy.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { interpretShadowLocalBooking } from './shadowLocalBooking.js'

export function createShadowLocalCore({ dictionary = createShadowLocalDictionary() } = {}) {
  return async function runShadowLocal(request) {
    const task = prepareShadowAiTask(request)
    if (task.task !== 'reader_message') throw shadowAiError('SHADOW_AI_LOCAL_TASK_NOT_READY','Local task is not available yet',503)
    const start = performance.now()
    const data = interpretShadowLocalBooking(JSON.parse(task.serialized),dictionary)
    return {
      data,
      engine:'local',
      model:dictionary.version,
      usage:{inputTokens:null,outputTokens:null,processingMs:Math.max(0,Math.round(performance.now()-start))},
    }
  }
}
