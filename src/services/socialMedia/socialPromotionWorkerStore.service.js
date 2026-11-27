import { normalizeSocialId } from './socialPromotionRules.service.js'

const statuses = new Set(['published','failed','needs_review','cancelled'])
export function createSocialPromotionWorkerStore(db) {
  if (!db?.rpc) throw new TypeError('SOCIAL_WORKER_DB_REQUIRED')
  async function call(name, params={}) {
    const {data,error}=await db.rpc(name,params)
    if(error) throw new Error('SOCIAL_WORKER_STORE_FAILED')
    return data
  }
  function key(job) {
    return {p_job_id:normalizeSocialId(job?.id),p_claim_id:normalizeSocialId(job?.worker_claim_id)}
  }
  return {
    async claim() {
      const data=await call('social_promotion_claim_v3')
      if(data===null) return null
      const job=data?.job
      key(job)
      if(job.owner_type!=='admin'||job.owner_id!=='shadow'||job.status!=='publishing'||job.content_mode!=='short'||!Array.isArray(data.items)) throw new Error('SOCIAL_WORKER_CLAIM_INVALID')
      return {job,items:data.items}
    },
    async context(job) {
      const data=await call('social_promotion_worker_context_v3',key(job))
      if(data===null) return null
      if(data?.rule?.id!==job.rule_id||data?.connection?.id!==job.connection_id||data.connection.owner_type!=='admin'||data.connection.owner_id!=='shadow'||!['facebook','instagram'].includes(data.connection.platform)||!data.connection.token_ciphertext) throw new Error('SOCIAL_WORKER_CONTEXT_INVALID')
      return data
    },
    async finish(job,status,{postId=null,errorCode=null}={}) {
      if(!statuses.has(status)|| (status==='published'?typeof postId!=='string'||!/^\d{1,40}(?:_\d{1,40})?$/.test(postId)||errorCode!==null:postId!==null||typeof errorCode!=='string'||!(/^[A-Z0-9_]{1,100}$/).test(errorCode))) throw new TypeError('SOCIAL_WORKER_FINISH_INVALID')
      const result=await call('social_promotion_finish_v3',{...key(job),p_status:status,p_post_id:postId,p_error_code:errorCode})
      if(result!==true) throw new Error('SOCIAL_WORKER_CLAIM_LOST')
      return true
    }
  }
}
