const LANGUAGES=new Set(['km','en'])
const MIN=1000
const RETRY=60000
const SLOT=/^\d{4}-\d{2}-\d{2}T(?:11|18|21):00$/
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATES=new Set(['queued','retry','skipped','failed'])
const STAGES=new Set(['main','retry','fallback'])
const safe=value=>String(value?.message??value??'UNKNOWN').replace(/\b\d+(?::|%3a)[A-Za-z0-9_-]+/gi,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,500)
const date=value=>value==null?Infinity:Date.parse(value)
function result(response){if(response?.error)throw new Error(safe(response.error.message));return response?.data}
function validateClaim(claim,language){
  if(!claim||claim.language!==language||!SLOT.test(claim.slotKey)||!UUID.test(claim.claimId)||!Number.isInteger(claim.attempt)||claim.attempt<1||claim.attempt>32||!STAGES.has(claim.stage))throw new TypeError('Invalid slot claim')
  const dueAt=date(claim.dueAt),expiresAt=date(claim.expiresAt)
  if(!Number.isFinite(dueAt)||expiresAt!==dueAt+3*3600000)throw new TypeError('Invalid slot window')
  return {kind:claim.slotKey.endsWith('T21:00')?'night':'smart',slotKey:claim.slotKey,dueAt,expiresAt}
}
function normalize(value){
  if(value==null)return {state:'retry',reason:'NO_QUEUE_CREATED'}
  if(typeof value==='string'&&UUID.test(value))return {state:'queued',reason:null}
  if(!STATES.has(value?.state))throw new TypeError('Invalid preparation result')
  return {state:value.state,reason:value.reason==null?null:safe(value.reason)}
}
export function createPromotionReliabilityV2({db,execute,clock=Date.now,onError=()=>{}}){
  if(!db?.rpc||typeof execute!=='function'||typeof clock!=='function')throw new TypeError('Missing promotion reliability dependencies')
  const nextChecks=new Map(),running=new Map()
  const report=(language,code,error,slotKey=null)=>{try{onError({code,language,slot_key:slotKey,message:safe(error)})}catch{}}
  async function process(settings){
    const language=settings.language
    try{
      const pulse=result(await db.rpc('telegram_promotion_v2_slot_pulse',{p_language:language}))
      if(!pulse||typeof pulse.disabled!=='boolean'||!Object.hasOwn(pulse,'claim')||!Object.hasOwn(pulse,'nextAt'))throw new TypeError('Invalid slot pulse')
      if(pulse.disabled){nextChecks.delete(language);return {state:'disabled',nextAt:Infinity}}
      const nextAt=date(pulse.nextAt)
      if(!Number.isFinite(nextAt))throw new TypeError('Missing next slot time')
      if(!pulse.claim){const next=Math.max(clock()+MIN,nextAt);nextChecks.set(language,{enabledAt:settings.enabled_at,nextAt:next});return {state:'idle',nextAt:next}}
      const claim=pulse.claim
      const slot=validateClaim(claim,language)
      let outcome
      try{
        outcome=clock()>=slot.expiresAt?{state:'retry',reason:'SLOT_EXPIRED_DURING_CLAIM'}:normalize(await execute({settings,slot,stage:claim.stage,attempt:claim.attempt,now:clock()}))
      }catch(error){outcome={state:'retry',reason:safe(error)};report(language,'TELEGRAM_PROMOTION_SLOT_PREPARE_FAILED',error,slot.slotKey)}
      const saved=result(await db.rpc('telegram_promotion_v2_slot_finish',{p_language:language,p_slot_key:slot.slotKey,p_claim_id:claim.claimId,p_outcome:outcome.state,p_reason:outcome.reason}))
      if(typeof saved!=='boolean')throw new TypeError('Invalid slot finish response')
      if(!saved)report(language,'TELEGRAM_PROMOTION_SLOT_CLAIM_LOST','Slot lease expired or claim changed',slot.slotKey)
      const next=clock()+MIN
      nextChecks.set(language,{enabledAt:settings.enabled_at,nextAt:next})
      return {state:saved?outcome.state:'claim_lost',nextAt:next,slotKey:slot.slotKey}
    }catch(error){
      report(language,'TELEGRAM_PROMOTION_SLOT_RECOVERY_FAILED',error)
      const next=clock()+RETRY
      nextChecks.set(language,{enabledAt:settings.enabled_at,nextAt:next})
      return {state:'error',nextAt:next}
    }
  }
  return {
    async run(settings){
      if(!settings?.enabled||!LANGUAGES.has(settings.language))return {state:'disabled',nextAt:Infinity}
      const language=settings.language
      if(running.has(language))return running.get(language)
      const cached=nextChecks.get(language)
      if(cached?.enabledAt===settings.enabled_at&&cached.nextAt>clock())return {state:'idle',nextAt:cached.nextAt}
      const task=process(settings).finally(()=>running.delete(language))
      running.set(language,task)
      return task
    },
    nextDue(language){return nextChecks.get(language)?.nextAt??0},
    invalidate(language){nextChecks.delete(language)}
  }
}
