import { randomUUID } from 'node:crypto'
import { prepareShadowAiTask, shadowAiError } from '../shadowAiPolicy.js'
import { shadowLocalRuntimeConfig } from './shadowLocalRuntimeConfig.js'
import { interpretShadowLocalFollowup } from './shadowLocalFollowup.js'
import { interpretShadowLocalRequirements } from './shadowLocalRequirements.js'

const safeError=e=>typeof e?.code==='string'&&/^SHADOW_AI_[A-Z0-9_]{1,80}$/u.test(e.code)&&Number.isInteger(e.statusCode)&&e.statusCode>=400&&e.statusCode<600?e:shadowAiError('SHADOW_AI_LOCAL_UNAVAILABLE','Local AI is temporarily unavailable')
export function createShadowLocalRuntime({reserve,finish,knowledgeStore,env=process.env}={}) {
  if(typeof reserve!=='function'||typeof finish!=='function'||typeof knowledgeStore?.getDictionary!=='function') throw new TypeError('Local runtime dependencies required')
  const actors=new Set()
  let active=0
  return async function runShadowLocal(request) {
    const config=shadowLocalRuntimeConfig(env),task=prepareShadowAiTask(request)
    if(active>=config.maxConcurrent||actors.has(task.actorUserId)) throw shadowAiError('SHADOW_AI_BUSY','AI is busy. Please try again.',429)
    const requestId=randomUUID()
    active++;actors.add(task.actorUserId)
    let reserved=false,result,failure
    try {
      await reserve({requestId,actorUserId:task.actorUserId,role:task.role,task:task.task,model:config.model})
      reserved=true
      const dictionary=await knowledgeStore.getDictionary()
      const input=JSON.parse(task.serialized),start=performance.now()
      const data=task.task==='reader_message'?interpretShadowLocalFollowup(input,dictionary):interpretShadowLocalRequirements(input)
      result={requestId,data,engine:'local',model:config.model,dictionaryVersion:dictionary.version,usage:{inputTokens:null,outputTokens:null,processingMs:Math.max(0,Math.round(performance.now()-start))}}
    } catch(e) { failure=safeError(e) }
    finally {
      try {
        if(reserved) await finish({requestId,status:failure?'error':'ok',inputTokens:null,outputTokens:null,errorCode:failure?.code??null})
      } catch { if(!failure) failure=shadowAiError('SHADOW_AI_USAGE_UNAVAILABLE','AI usage could not be recorded') }
      finally { active--;actors.delete(task.actorUserId) }
    }
    if(failure) throw failure
    return result
  }
}
