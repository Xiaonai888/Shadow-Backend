import { normalizeSocialId } from './socialPromotionRules.service.js'

const kinds=new Set(['story','author'])
const languages=new Set(['all','km','en','zh','ja','ko'])
export class SocialExceptionError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status}
}
function id(value){try{return normalizeSocialId(value)}catch{throw new SocialExceptionError('SOCIAL_EXCEPTION_ID_INVALID')}}
function kind(value){if(!kinds.has(value))throw new SocialExceptionError('SOCIAL_EXCEPTION_KIND_INVALID');return value}
function pageNumber(value){const s=String(value??'1');if(!/^[1-9]\d{0,4}$/.test(s)||Number(s)>10000)throw new SocialExceptionError('SOCIAL_EXCEPTION_PAGE_INVALID');return Number(s)}
export function createSocialPromotionExceptions(db){
  if(!db?.rpc)throw new TypeError('SOCIAL_EXCEPTION_DB_REQUIRED')
  async function call(name,args){const {data,error}=await db.rpc(name,args);if(error)throw new SocialExceptionError('SOCIAL_EXCEPTION_DATABASE_FAILED',500);return data}
  return {
    async list(query={},blockedOnly=true){
      const k=kind(query.kind??'story'),language=query.language??'all',search=query.q??'',page=pageNumber(query.page)
      if(!languages.has(language)||(k==='author'&&language!=='all')||typeof search!=='string'||search.length>120||typeof blockedOnly!=='boolean')throw new SocialExceptionError('SOCIAL_EXCEPTION_LIST_INVALID')
      const result=await call('social_promotion_exception_list_v6',{p_kind:k,p_language:language,p_search:search.trim(),p_page:page,p_blocked_only:blockedOnly})
      if(!result||result.page!==page||!Array.isArray(result.items)||result.items.length>10||typeof result.hasMore!=='boolean')throw new SocialExceptionError('SOCIAL_EXCEPTION_RESPONSE_INVALID',500)
      const items=result.items.map(row=>{
        if(row?.kind!==k||typeof row.name!=='string'||typeof row.blocked!=='boolean'||(blockedOnly&&!row.blocked)||(k==='story'&&language!=='all'&&row.language!==language)||(k==='author'&&row.language!==null))throw new SocialExceptionError('SOCIAL_EXCEPTION_RESPONSE_INVALID',500)
        return {id:id(row.id),kind:k,name:row.name,language:row.language??null,image_url:typeof row.image_url==='string'?row.image_url:null,author_name:typeof row.author_name==='string'?row.author_name:'',blocked:row.blocked}
      })
      return {items,page,hasMore:result.hasMore}
    },
    async change(input={},block){
      if(typeof block!=='boolean')throw new SocialExceptionError('SOCIAL_EXCEPTION_INPUT_INVALID')
      const result=await call('social_promotion_exception_change_v6',{p_kind:kind(input.kind),p_target_id:id(input.id),p_block:block})
      if(result?.state==='not_found')throw new SocialExceptionError('SOCIAL_EXCEPTION_NOT_FOUND',404)
      if(result?.state!==(block?'blocked':'removed')||typeof result.changed!=='boolean'||!Number.isSafeInteger(result.cancelled)||result.cancelled<0)throw new SocialExceptionError('SOCIAL_EXCEPTION_RESPONSE_INVALID',500)
      return {state:result.state,changed:result.changed,cancelled:result.cancelled}
    },
    async allowedStoryIds(values){
      if(!Array.isArray(values)||values.length>1000)throw new SocialExceptionError('SOCIAL_EXCEPTION_FILTER_INVALID')
      const ids=[...new Set(values.map(id))]
      if(!ids.length)return new Set()
      const result=await call('social_promotion_allowed_stories_v6',{p_story_ids:ids})
      if(!Array.isArray(result)||result.length>ids.length||result.some(v=>!ids.includes(v)))throw new SocialExceptionError('SOCIAL_EXCEPTION_RESPONSE_INVALID',500)
      return new Set(result)
    }
  }
}
