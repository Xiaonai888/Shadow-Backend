import { normalizePromotionLanguage } from './policy.service.js'
const DAY=86400000
const fresh=(v,now)=>{const t=Date.parse(v||'');return Number.isFinite(t)&&t<=now&&t>=now-30*DAY}
const past=(v,now)=>{const t=Date.parse(v||'');return Number.isFinite(t)&&t<=now}
const fail=reason=>({eligible:false,reason})
const pass={eligible:true,reason:null}
const sameEntities=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((e,i)=>['type','offset','length','url'].every(k=>e[k]===b[i]?.[k]))
function data(r){if(r?.error)throw new Error(`Promotion V2 validation: ${String(r.error.message||'Database error').slice(0,300)}`);return r?.data}
export function validatePromotionContextV2({context,language,postType,topic=null,now=Date.now()}){
  const s=context?.story,e=context?.episode
  if(!s?.id||!e?.id||String(e.story_id)!==String(s.id))return fail('not_public')
  if(!normalizePromotionLanguage(language)||normalizePromotionLanguage(s.story_language)!==normalizePromotionLanguage(language))return fail('language_mismatch')
  if(s.status!=='published'||e.status!=='published'||s.deleted_at||e.deleted_at||!['','active'].includes(String(s.admin_visibility_status||'').toLowerCase())||(s.is_shadow_exclusive&&s.exclusive_status!=='approved'))return fail('not_public')
  if(!past(e.first_published_at,now)||!past(e.published_at||e.first_published_at,now)||(e.scheduled_at&&!past(e.scheduled_at,now)))return fail('not_yet_published')
  if(postType==='update')return pass
  if(s.is_adult||e.is_adult||!s.cover_url)return fail('restricted_optional')
  const count=Number(context.publishedEpisodeCount),completed=String(s.story_status||'').toLowerCase()==='completed'
  if(!Number.isInteger(count)||count<5)return fail('episode_count')
  if(!completed&&(!fresh(context.authorLastActiveAt,now)||!fresh(context.lastEpisodePublishedAt,now)))return fail('inactive')
  if(['completed','short'].includes(topic)&&!completed)return fail('not_completed')
  if(topic==='short'&&!(['short','short_story','short_novel'].includes(String(s.story_type).toLowerCase())||(String(s.story_type||'novel').toLowerCase()==='novel'&&count<=9)))return fail('not_short')
  return pass
}
export function createPromotionValidatorV2({db,legacy,source=null,messageBuilder=null,safeCoverUrl=null}){
  if(!db?.from||!legacy?.context||!legacy?.validate)throw new TypeError('Missing validation dependencies')
  return {async validate(job,now=Date.now(),settings={}){
    const type=job.kind==='update'&&Number.isInteger(job.payload?.v2_revision)?'update':['solo','group'].includes(job.kind)?job.kind:null
    if(!type)return legacy.validate(job,now)
    const meta=data(await db.from('telegram_promotion_v2_message_meta').select('post_type,topic').eq('queue_id',job.id).maybeSingle())
    if(meta?.post_type!==type)return fail('missing_v2_metadata')
    const items=type==='group'?data(await db.from('telegram_promotion_v2_group_stories').select('story_id,episode_id,position').eq('queue_id',job.id).order('position')):[{story_id:job.story_id,episode_id:job.episode_id}]
    if(!Array.isArray(items)||!items.length||(type==='group'&&(items.length<3||items.length>5||items.length!==job.payload?.media?.length||items[0].story_id!==job.story_id||items[0].episode_id!==job.episode_id)))return fail('invalid_group')
    for(const [index,item] of items.entries()){
      const context=await legacy.context(item.story_id,item.episode_id,type)
      const decision=validatePromotionContextV2({context,language:job.language,postType:type,topic:meta.topic,now})
      if(!decision.eligible)return decision
      if(type==='group'){
        let cover;try{cover=new URL(context.story.cover_url,'https://www.shadowerabook.site').href}catch{return fail('invalid_cover')}
        if(cover!==job.payload.media[index]?.media)return fail('group_cover_changed')
      }
      if(type==='update'&&(context.story.is_adult||context.episode.is_adult)){
        if(!safeCoverUrl||job.payload.photo!==safeCoverUrl||Array.isArray(job.payload.media))return fail('restricted_preview_requires_safe_cover')
        if(!source?.load||!messageBuilder?.build)return fail('restricted_preview_requires_fresh_validation')
        const loaded=await source.load(item.story_id,item.episode_id)
        if(!loaded?.story||!loaded?.episode)return fail('restricted_preview_missing')
        const freshMessage=await messageBuilder.build({...loaded,language:job.language,postType:'update',links:settings.links,authorName:await source.authorName(loaded.story.author_id)})
        if(!freshMessage||freshMessage.photo!==safeCoverUrl||freshMessage.caption!==job.payload.v2_base_caption||!sameEntities(freshMessage.caption_entities,job.payload.caption_entities))return fail('restricted_preview_changed')
      }
    }
    return pass
  }}
}
