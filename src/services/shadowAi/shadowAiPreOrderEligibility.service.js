import { shadowAiConfig, shadowAiError } from './shadowAiPolicy.js'
import { shadowAiId } from './shadowAiPreOrderAccess.service.js'

const unavailable = () => shadowAiError('SHADOW_AI_ELIGIBILITY_UNAVAILABLE','AI booking availability could not be verified',503)

export function createShadowAiEligibility({ db, resolve, getDeliverySettings, env = process.env, now = Date.now } = {}) {
  if (typeof db?.from !== 'function' || typeof db?.rpc !== 'function' || typeof resolve !== 'function' || typeof getDeliverySettings !== 'function') throw new TypeError('Eligibility dependencies required')
  return async function eligibility({ actorUserId, conversationId, offset = 0 }) {
    const actor = shadowAiId(actorUserId), chat = shadowAiId(conversationId)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw shadowAiError('SHADOW_AI_INVALID_REQUEST','Invalid campaign offset',400)
    const empty = { conversation_id:chat, enabled:false, stock_verified:false, campaigns:[], has_more:false, next_offset:null }
    try { shadowAiConfig(env) } catch { return empty }
    const {data:settings,error} = await db.from('shadow_ai_settings').select('enabled,preorder_enabled').eq('id',1).maybeSingle().abortSignal(AbortSignal.timeout(5000))
    if (error || !settings) throw unavailable()
    if (settings.enabled !== true || settings.preorder_enabled !== true) return empty
    const author = shadowAiId(await resolve({actorUserId:actor,conversationId:chat}))
    let delivery
    try { delivery = await getDeliverySettings(author) } catch { throw unavailable() }
    if (!Array.isArray(delivery) || delivery.length > 32) throw unavailable()
    const keys = [...new Set(delivery.filter(c=>c?.is_active !== false).map(c=>c?.company_key))]
    if (keys.some(k=>typeof k !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(k))) throw unavailable()
    if (!keys.length) return {...empty,enabled:true,stock_verified:true}
    const result = await db.rpc('shadow_ai_eligible_campaigns_v1',{p_author_page_id:author,p_active_delivery_keys:keys,p_offset:offset}).abortSignal(AbortSignal.timeout(5000))
    const data = result.data
    if (result.error || !data || !Array.isArray(data.campaigns) || data.campaigns.length>10 || typeof data.has_more!=='boolean' || (data.next_offset!==null && data.next_offset!==offset+10)) throw unavailable()
    const seen = new Set()
    const campaigns = data.campaigns.map(c=>{
      if (!c || typeof c.title!=='string' || c.can_book!==true || !Number.isFinite(Date.parse(c.close_at))) throw unavailable()
      const id=shadowAiId(c.id)
      if (seen.has(id)) throw unavailable()
      seen.add(id)
      return {id,title:c.title,close_at:c.close_at,can_book:true}
    }).filter(c=>Date.parse(c.close_at)>now())
    return {conversation_id:chat,enabled:true,stock_verified:true,campaigns,has_more:data.next_offset!==null && data.has_more,next_offset:data.next_offset}
  }
}
