import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { createShadowLocalKnowledgeDictionary } from './shadowLocalKnowledge.js'

export function createShadowLocalKnowledgeStore({readSnapshot,now=Date.now,ttlMs=30000,retryMs=15000}={}) {
  if(typeof readSnapshot!=='function'||typeof now!=='function'||!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>60000||!Number.isInteger(retryMs)||retryMs<1000||retryMs>60000) throw new TypeError('Invalid knowledge cache configuration')
  const fallback=createShadowLocalDictionary()
  let dictionary=fallback,expiresAt=0,pending=null,generation=0
  return Object.freeze({
    invalidate() { generation++;dictionary=fallback;expiresAt=0;pending=null },
    async getDictionary() {
      if(now()<expiresAt) return dictionary
      if(pending) return pending
      const revision=generation
      const operation=Promise.resolve().then(readSnapshot).then(snapshot=>({value:createShadowLocalKnowledgeDictionary(snapshot),duration:ttlMs})).catch(()=>({value:fallback,duration:retryMs})).then(({value,duration})=>{
        if(revision!==generation) return fallback
        dictionary=value;expiresAt=now()+duration;return dictionary
      }).finally(()=>{if(pending===operation) pending=null})
      pending=operation
      return operation
    },
  })
}
