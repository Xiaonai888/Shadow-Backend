export const AUTHOR_AUTO_POST_PLATFORMS = Object.freeze(['telegram','facebook','instagram','tiktok','threads'])
export const AUTHOR_AUTO_POST_DEFAULTS = Object.freeze({enabled:false,header_text:'',footer_text:'',content_percent:30,episode_filter:'all',selection_mode:'all',story_ids:Object.freeze([]),posting_mode:'update',include_cover:true,locked_content_confirmed:false})
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validText=v=>typeof v==='string'&&Array.from(v).length<=300&&!v.includes('\0')
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status})

export function normalizeAuthorAutoPostSettings(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('AUTHOR_AUTO_POST_SETTINGS_INVALID')
  const {enabled,header_text,footer_text,content_percent,episode_filter,selection_mode,story_ids,posting_mode,include_cover,locked_content_confirmed}=input
  if(![enabled,include_cover,locked_content_confirmed].every(v=>typeof v==='boolean')||!validText(header_text)||!validText(footer_text)||!Number.isInteger(content_percent)||content_percent<10||content_percent>100||content_percent%10!==0||!['all','locked','free'].includes(episode_filter)||!['all','selected'].includes(selection_mode)||!['update','promotion','both'].includes(posting_mode)||!Array.isArray(story_ids)||story_ids.length>1000||!story_ids.every(v=>typeof v==='string'&&uuid.test(v)))throw fail('AUTHOR_AUTO_POST_SETTINGS_INVALID')
  const ids=[...new Set(story_ids.map(v=>v.toLowerCase()))]
  if((selection_mode==='selected'&&!ids.length)||(selection_mode==='all'&&ids.length))throw fail('AUTHOR_AUTO_POST_STORY_SELECTION_INVALID')
  if(content_percent>30&&episode_filter!=='free'&&!locked_content_confirmed)throw fail('AUTHOR_AUTO_POST_LOCKED_CONFIRMATION_REQUIRED',409)
  return {enabled,header_text,footer_text,content_percent,episode_filter,selection_mode,story_ids:ids,posting_mode,include_cover,locked_content_confirmed:content_percent>30&&episode_filter!=='free'&&locked_content_confirmed}
}

export function createAuthorAutoPostSettingsService({db}={}){
  if(typeof db?.rpc!=='function')throw new TypeError('AUTHOR_AUTO_POST_SETTINGS_DEPENDENCIES')
  const actor=id=>{if(typeof id!=='string'||!id.trim()||id.length>128)throw fail('AUTHOR_AUTO_POST_UNAUTHORIZED',401);return id}
  async function call(name,args){
    const {data,error}=await db.rpc(name,args)
    if(error||!data||typeof data.state!=='string')throw fail('AUTHOR_AUTO_POST_DATABASE_ERROR',503)
    if(data.state==='ok')return data
    const codes={not_found:404,invalid:400,invalid_story:400,confirmation_required:409,stale_settings:409,suspended:403}
    throw fail('AUTHOR_AUTO_POST_'+(Object.hasOwn(codes,data.state)?data.state.toUpperCase():'DATABASE_ERROR'),Object.hasOwn(codes,data.state)?codes[data.state]:503)
  }
  return {
    get(userId){return call('author_auto_post_get_settings_v1',{p_user_id:actor(userId)})},
    save(userId,input,expectedRevision=null){
      const id=actor(userId)
      if(expectedRevision!==null&&(typeof expectedRevision!=='string'||!Number.isFinite(Date.parse(expectedRevision))))throw fail('AUTHOR_AUTO_POST_REVISION_INVALID')
      return call('author_auto_post_save_settings_v1',{p_user_id:id,p_settings:normalizeAuthorAutoPostSettings(input),p_expected_revision:expectedRevision})
    }
  }
}
