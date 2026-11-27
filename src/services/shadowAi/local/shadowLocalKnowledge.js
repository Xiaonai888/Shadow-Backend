import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { cleanShadowText, shadowMatchKey } from './shadowLocalText.js'
import { shadowAiError } from '../shadowAiPolicy.js'

export const SHADOW_LOCAL_KNOWLEDGE_LIMIT=250
const allowed=Object.freeze({
  fields:Object.freeze(['name','phone_number','delivery_address','second_phone','telegram_username','facebook_link','signature_name','english_buyer_name','english_signature_name','detailed_address','buyer_note','delivery_company_key','signature_requested','book','edition','quantity']),
  editions:Object.freeze(['standard','limited']),
  questions:Object.freeze(['books','price','stock','delivery','signature','schedule','requirements']),
})
const invalid=()=>shadowAiError('SHADOW_AI_KNOWLEDGE_INVALID','Invalid or conflicting knowledge alias',400)
const base=createShadowLocalDictionary()

export function normalizeShadowLocalKnowledge(rows) {
  if(!Array.isArray(rows)||rows.length>SHADOW_LOCAL_KNOWLEDGE_LIMIT) throw invalid()
  const entries=new Map()
  for(const row of rows) {
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==3||!Object.hasOwn(allowed,row.group)||!allowed[row.group].includes(row.canonical)||typeof row.alias!=='string') throw invalid()
    const alias=shadowMatchKey(cleanShadowText(row.alias,80))
    if(alias.length<2||alias.length>80||!/[\p{L}]/u.test(alias)||!/^\p{L}[\p{L}\p{M} ]*$/u.test(alias)) throw invalid()
    const prior=base.lookup(row.group,alias)
    if(prior&&prior!==row.canonical) throw invalid()
    const key=`${row.group}:${alias}`
    if(entries.has(key)&&entries.get(key).canonical!==row.canonical) throw invalid()
    if(!prior) entries.set(key,{group:row.group,alias,canonical:row.canonical})
  }
  const result=[...entries.values()].sort((a,b)=>a.group<b.group?-1:a.group>b.group?1:a.alias<b.alias?-1:a.alias>b.alias?1:0)
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>30000) throw invalid()
  return result
}

export function createShadowLocalKnowledgeDictionary(snapshot) {
  if(!Number.isSafeInteger(snapshot?.version)||snapshot.version<1) throw invalid()
  const rows=normalizeShadowLocalKnowledge(snapshot.aliases),groups=new Map()
  for(const row of rows) {
    if(!groups.has(row.group)) groups.set(row.group,new Map())
    groups.get(row.group).set(row.alias,row.canonical)
  }
  return Object.freeze({
    version:`${base.version}-knowledge-${snapshot.version}`,
    lookup(group,value) {
      if(typeof value!=='string') return null
      return base.lookup(group,value)??groups.get(group)?.get(shadowMatchKey(value))??null
    },
    aliases(group) {
      return [...new Set([...base.aliases(group),...(groups.get(group)?.keys()??[])])].sort((a,b)=>b.length-a.length)
    },
  })
}
