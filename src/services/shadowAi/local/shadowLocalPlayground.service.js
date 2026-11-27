import { shadowAiError } from '../shadowAiPolicy.js'
import { parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'
import { mergeShadowBookingDraft, inspectShadowBookingDraft } from '../shadowAiPreOrderDraft.js'
import { previewShadowPreOrderRequirements, normalizeShadowPreOrderRules } from '../shadowAiPreOrderRequirements.js'
import { createShadowLocalKnowledgeDictionary } from './shadowLocalKnowledge.js'
import { interpretShadowLocalFollowup } from './shadowLocalFollowup.js'
import { interpretShadowLocalRequirements } from './shadowLocalRequirements.js'
import { SHADOW_LOCAL_RUNTIME_VERSION } from './shadowLocalRuntimeConfig.js'

const id='11111111-1111-4111-8111-111111111111'
const other='22222222-2222-4222-8222-222222222222'
const context={can_book:true,stock_verified:true,signature_enabled:true,books:[{id,title:'Moon',editions:[{edition:'standard',available:10,price_usd:10},{edition:'limited',available:2,price_usd:15}]},{id:other,title:'រឿងព្រេង',editions:[{edition:'standard',available:5,price_usd:8}]}],delivery_companies:[{company_key:'jnt',company_name:'J&T',fee_usd:1},{company_key:'vet',company_name:'VET',fee_usd:2}]}
const scenarios=Object.freeze({empty:[],book_selected:[{book_id:id,edition:null,quantity:null}],edition_selected:[{book_id:id,edition:'limited',quantity:null}]})
const invalid=()=>shadowAiError('SHADOW_AI_PLAYGROUND_INVALID','Invalid playground request',400)
export function createShadowLocalPlayground({knowledgeStore}={}) {
  if(typeof knowledgeStore?.getDictionary!=='function') throw new TypeError('Knowledge store required')
  return async function testLocal(input) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['task','text','scenario','aliases','rules'].includes(k))||!['reader_message','author_requirements'].includes(input.task)||typeof input.text!=='string'||!input.text.trim()||input.text.length>(input.task==='reader_message'?2000:300)) throw invalid()
    const scenario=input.scenario??'empty'
    if(!Object.hasOwn(scenarios,scenario)) throw invalid()
    const rules=normalizeShadowPreOrderRules(input.rules??[])
    const dictionary=Object.hasOwn(input,'aliases')?createShadowLocalKnowledgeDictionary({version:1,aliases:input.aliases}):await knowledgeStore.getDictionary()
    const start=performance.now()
    const runAi=async req=>({data:req.task==='reader_message'?interpretShadowLocalFollowup(req.input,dictionary):interpretShadowLocalRequirements(req.input)})
    let result
    if(input.task==='author_requirements') result=await previewShadowPreOrderRequirements({actorUserId:id,instruction:input.text,templateRules:rules,runAi})
    else {
      const before=mergeShadowBookingDraft(context,{items:scenarios[scenario]})
      const parsed=await parseShadowPreOrderMessage({actorUserId:id,message:input.text,context,draft:before,rules,runAi})
      const draft=mergeShadowBookingDraft(context,before,parsed.patch)
      result={intent:parsed.intent,question:parsed.question,draft,validation:inspectShadowBookingDraft(context,draft,rules)}
    }
    return {engine:'local',model:SHADOW_LOCAL_RUNTIME_VERSION,dictionary_version:Object.hasOwn(input,'aliases')?'preview':dictionary.version,processing_ms:Math.max(0,Math.round(performance.now()-start)),test_only:true,external_requests:0,order_created:false,payment_created:false,inventory_reserved:false,result}
  }
}

export function createShadowLocalKnowledgeHistory({db}={}) {
  if(typeof db?.rpc!=='function') throw new TypeError('Knowledge database required')
  return async function history({before,limit}={}) {
    const parse=(raw,min,max,fallback)=>{if(raw===undefined)return fallback;if(!['number','string'].includes(typeof raw)||!/^\d{1,10}$/u.test(String(raw)))throw invalid();const n=Number(raw);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid();return n}
    const cursor=parse(before,1,2147483647,null),size=parse(limit,1,30,20)
    const {data,error}=await db.rpc('shadow_ai_local_knowledge_history_v1',{p_before:cursor,p_limit:size}).abortSignal(AbortSignal.timeout(5000))
    if(error||!data||!Array.isArray(data.versions)||data.versions.length>size||typeof data.has_more!=='boolean'||(data.has_more?(!Number.isInteger(data.next_before)||data.next_before<1):data.next_before!==null))throw shadowAiError('SHADOW_AI_KNOWLEDGE_UNAVAILABLE','Knowledge history is unavailable',503)
    return data
  }
}
