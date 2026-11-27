import { shadowAiError } from '../shadowAiPolicy.js'
import { normalizeShadowLocalKnowledge } from './shadowLocalKnowledge.js'

const invalid=()=>shadowAiError('SHADOW_AI_KNOWLEDGE_INVALID','Invalid knowledge request',400)
const unavailable=()=>shadowAiError('SHADOW_AI_KNOWLEDGE_UNAVAILABLE','Knowledge data is unavailable',503)
const validVersion=v=>Number.isInteger(v)&&v>=1&&v<=2147483647
export function createShadowLocalKnowledgeAdmin({db,invalidate=()=>{}}={}) {
  if(typeof db?.rpc!=='function'||typeof invalidate!=='function') throw new TypeError('Knowledge database required')
  async function rpc(name,args) {
    const {data,error}=await db.rpc(name,args).abortSignal(AbortSignal.timeout(5000))
    if(error) throw unavailable()
    return data
  }
  async function read(version=null) {
    if(version!==null&&!validVersion(version)) throw invalid()
    const data=await rpc('shadow_ai_local_knowledge_read_v1',{p_version:version})
    if(!data) {
      if(version!==null) throw shadowAiError('SHADOW_AI_KNOWLEDGE_NOT_FOUND','Knowledge version was not found',404)
      throw unavailable()
    }
    if(!validVersion(data.version)||(version!==null&&data.version!==version)) throw unavailable()
    return {...data,aliases:normalizeShadowLocalKnowledge(data.aliases)}
  }
  async function publish(adminId,expectedVersion,aliases,sourceVersion=null) {
    if(typeof adminId!=='string'||!adminId.trim()||adminId.length>128||!validVersion(expectedVersion)) throw invalid()
    const normalized=normalizeShadowLocalKnowledge(aliases)
    const result=await rpc('shadow_ai_local_knowledge_publish_v1',{p_expected_version:expectedVersion,p_aliases:normalized,p_admin_id:adminId.trim(),p_source_version:sourceVersion})
    if(result?.code==='SHADOW_AI_KNOWLEDGE_CONFLICT') throw shadowAiError(result.code,'Knowledge changed. Refresh and try again.',409)
    if(result?.code==='SHADOW_AI_KNOWLEDGE_INVALID') throw invalid()
    if(result?.ok!==true||typeof result.changed!=='boolean'||!validVersion(result.version)||result.version!==(result.changed?expectedVersion+1:expectedVersion)) throw unavailable()
    invalidate()
    return {version:result.version,changed:result.changed}
  }
  return Object.freeze({
    read,
    publish(adminId,input) {
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'aliases')||!Object.hasOwn(input,'expected_version')) throw invalid()
      return publish(adminId,input.expected_version,input.aliases)
    },
    async rollback(adminId,input) {
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!validVersion(input.expected_version)||!validVersion(input.source_version)||input.source_version>=input.expected_version) throw invalid()
      const snapshot=await read(input.source_version)
      return publish(adminId,input.expected_version,snapshot.aliases,input.source_version)
    },
  })
}
