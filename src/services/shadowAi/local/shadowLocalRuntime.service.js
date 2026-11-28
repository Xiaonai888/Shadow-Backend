import { randomUUID } from 'node:crypto'
import { prepareShadowAiTask, shadowAiError } from '../shadowAiPolicy.js'
import { shadowLocalRuntimeConfig } from './shadowLocalRuntimeConfig.js'
import { interpretShadowLocalFollowup } from './shadowLocalFollowup.js'
import { interpretShadowLocalBooking } from './shadowLocalBooking.js'
import { createShadowLocalReaderUnderstanding } from './shadowLocalReaderUnderstanding.js'
import { createShadowLocalTaskRouter } from './shadowLocalTaskRouter.js'

const understandReader=createShadowLocalReaderUnderstanding({interpretReader:interpretShadowLocalFollowup,interpretSelection:interpretShadowLocalBooking})
const defaultReader=(input,dictionary)=>understandReader(input,dictionary)
const scopeFields=['actorUserId','authorPageId','campaignId','conversationId']
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
function normalizeReaderContext(value,task) {
  if(value===undefined) return undefined
  if(task.task!=='reader_message'||!scopeFields.every(key=>typeof value?.scope?.[key]==='string'&&uuid.test(value.scope[key]))||value.scope.actorUserId.toLowerCase()!==task.actorUserId||!(value.revision===null||Number.isSafeInteger(value.revision)&&value.revision>=0)) throw shadowAiError('SHADOW_AI_INVALID_REQUEST','Invalid AI reader context',400)
  return {scope:Object.fromEntries(scopeFields.map(key=>[key,value.scope[key].toLowerCase()])),revision:value.revision}
}

const safeError=e=>typeof e?.code==='string'&&/^SHADOW_AI_[A-Z0-9_]{1,80}$/u.test(e.code)&&Number.isInteger(e.statusCode)&&e.statusCode>=400&&e.statusCode<600?e:shadowAiError('SHADOW_AI_LOCAL_UNAVAILABLE','Local AI is temporarily unavailable')
export function createShadowLocalRuntime({reserve,finish,knowledgeStore,interpretReader=defaultReader,env=process.env}={}) {
  if(typeof reserve!=='function'||typeof finish!=='function'||typeof knowledgeStore?.getDictionary!=='function'||typeof interpretReader!=='function') throw new TypeError('Local runtime dependencies required')
  const runTask=createShadowLocalTaskRouter({knowledgeStore,interpretReader})
  const actors=new Set()
  let active=0
  return async function runShadowLocal(request,readerContext) {
    const config=shadowLocalRuntimeConfig(env),task=prepareShadowAiTask(request)
    const context=normalizeReaderContext(readerContext,task)
    if(active>=config.maxConcurrent||actors.has(task.actorUserId)) throw shadowAiError('SHADOW_AI_BUSY','AI is busy. Please try again.',429)
    const requestId=randomUUID()
    active++;actors.add(task.actorUserId)
    let reserved=false,result,failure
    try {
      await reserve({requestId,actorUserId:task.actorUserId,role:task.role,task:task.task,model:config.model})
      reserved=true
      const input=JSON.parse(task.serialized),start=performance.now()
      const {data,dictionaryVersion}=await runTask(task.task,input,context)
      result={requestId,data,engine:'local',model:config.model,dictionaryVersion,usage:{inputTokens:null,outputTokens:null,processingMs:Math.max(0,Math.round(performance.now()-start))}}
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
