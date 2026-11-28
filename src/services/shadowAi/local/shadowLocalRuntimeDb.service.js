import { shadowAiError } from '../shadowAiPolicy.js'
import { createShadowLocalKnowledgeStore } from './shadowLocalKnowledgeStore.service.js'
import { createShadowLocalKnowledgeAdmin } from './shadowLocalKnowledgeAdmin.service.js'
import { createShadowLocalRuntime } from './shadowLocalRuntime.service.js'
import { createShadowLocalPreOrderBridge } from './shadowLocalPreOrderBridge.js'

const denial=Object.freeze({SHADOW_AI_DISABLED:[503,'AI is disabled'],SHADOW_AI_DAILY_LIMIT:[429,'Daily AI limit reached'],SHADOW_AI_USER_LIMIT:[429,'Daily AI user limit reached'],SHADOW_AI_INVALID_REQUEST:[400,'Invalid AI request'],SHADOW_AI_DUPLICATE_REQUEST:[409,'Duplicate AI request']})
const unavailable=()=>shadowAiError('SHADOW_AI_USAGE_UNAVAILABLE','AI usage service is unavailable')
export function createShadowLocalRuntimeDb({db,env=process.env,now=Date.now}={}) {
  if(typeof db?.rpc!=='function') throw new TypeError('Local runtime database required')
  async function rpc(name,args) {
    const {data,error}=await db.rpc(name,args).abortSignal(AbortSignal.timeout(5000))
    if(error) throw unavailable()
    return data
  }
  const knowledgeStore=createShadowLocalKnowledgeStore({now,readSnapshot:()=>rpc('shadow_ai_local_knowledge_read_v1',{p_version:null})})
  const knowledgeAdmin=createShadowLocalKnowledgeAdmin({db,invalidate:()=>knowledgeStore.invalidate()})
  async function reserve({requestId,actorUserId,role,task,model}) {
    const data=await rpc('shadow_ai_reserve_request_v1',{p_request_id:requestId,p_actor_user_id:actorUserId,p_role:role,p_task:task,p_model:model})
    if(data?.ok===true&&data.request_id===requestId) return
    const known=Object.hasOwn(denial,data?.code)?denial[data.code]:null
    if(known) throw shadowAiError(data.code,known[1],known[0])
    throw unavailable()
  }
  async function finish({requestId,status,inputTokens,outputTokens,errorCode}) {
    const data=await rpc('shadow_ai_finish_request_v1',{p_request_id:requestId,p_status:status,p_input_tokens:inputTokens,p_output_tokens:outputTokens,p_error_code:errorCode})
    if(data!==true) throw unavailable()
  }
  const preOrderBridge=createShadowLocalPreOrderBridge({now})
  return Object.freeze({runShadowAi:createShadowLocalRuntime({reserve,finish,knowledgeStore,env,interpretReader:preOrderBridge.interpretReader}),knowledgeAdmin,knowledgeStore,preOrderBridge})
}
