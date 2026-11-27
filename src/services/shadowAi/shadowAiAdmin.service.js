import { shadowAiError } from './shadowAiPolicy.js'
import { shadowLocalRuntimeConfig } from './local/shadowLocalRuntimeConfig.js'

export function shadowAiAdminPeriod(raw) {
  if (raw === undefined) return 1
  if (![1,7,30,'1','7','30'].includes(raw)) throw shadowAiError('SHADOW_AI_INVALID_PERIOD','Choose Today, 7 days or 30 days.',400)
  return Number(raw)
}

export function shadowAiAdminSettings(input) {
  const invalid = () => { throw shadowAiError('SHADOW_AI_SETTINGS_INVALID','Invalid AI settings.',400) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  const { enabled,preorder_enabled,daily_request_limit,daily_user_limit,expected_updated_at }=input
  if (typeof enabled!=='boolean' || typeof preorder_enabled!=='boolean' || (preorder_enabled&&!enabled) ||
      !Number.isSafeInteger(daily_request_limit) || daily_request_limit<1 || daily_request_limit>10000 ||
      !Number.isSafeInteger(daily_user_limit) || daily_user_limit<1 || daily_user_limit>200 || daily_user_limit>daily_request_limit ||
      typeof expected_updated_at!=='string' || expected_updated_at.length>64 || !Number.isFinite(Date.parse(expected_updated_at))) invalid()
  return {enabled,preorder_enabled,daily_request_limit,daily_user_limit,expected_updated_at}
}

export function createShadowAiAdminService({db,env=process.env}={}) {
  if (typeof db?.rpc!=='function') throw new TypeError('Admin database required')
  function runtime() {
    try { return { configured:true,engine:'local',model:shadowLocalRuntimeConfig(env).model } }
    catch { return { configured:false,engine:'local',model:null } }
  }
  async function rpc(name,args) {
    const {data,error}=await db.rpc(name,args).abortSignal(AbortSignal.timeout(8000))
    if(error || !data || typeof data!=='object' || Array.isArray(data)) throw shadowAiError('SHADOW_AI_ADMIN_UNAVAILABLE','AI management data is unavailable.',503)
    return data
  }
  return {
    async overview(period) {
      const data=await rpc('shadow_ai_admin_overview_v1',{p_days:shadowAiAdminPeriod(period)})
      if (!data.settings || !data.totals || !Array.isArray(data.daily) || !Array.isArray(data.models) || !Array.isArray(data.errors) || !Array.isArray(data.history)) throw shadowAiError('SHADOW_AI_ADMIN_UNAVAILABLE','AI management data is incomplete.',503)
      return {...data,runtime:runtime(),cost_usd:null,cost_verified:false}
    },
    async update(adminId,input) {
      if (typeof adminId!=='string' || !adminId.trim() || adminId.length>128) throw shadowAiError('SHADOW_AI_ADMIN_DENIED','Admin access required.',403)
      const s=shadowAiAdminSettings(input)
      if(s.enabled && s.preorder_enabled && !runtime().configured) throw shadowAiError('SHADOW_AI_NOT_CONFIGURED','Configure the backend AI environment before enabling the role.',409)
      const result=await rpc('shadow_ai_admin_update_v1',{p_admin_id:adminId,p_expected_updated_at:s.expected_updated_at,p_enabled:s.enabled,p_preorder_enabled:s.preorder_enabled,p_daily_request_limit:s.daily_request_limit,p_daily_user_limit:s.daily_user_limit})
      if(result.ok===true && result.settings) return {settings:result.settings,runtime:runtime()}
      if(result.code==='SHADOW_AI_SETTINGS_CONFLICT') throw shadowAiError(result.code,'Settings changed. Refresh and try again.',409)
      if(result.code==='SHADOW_AI_SETTINGS_INVALID') throw shadowAiError(result.code,'Invalid AI settings.',400)
      throw shadowAiError('SHADOW_AI_ADMIN_UNAVAILABLE','AI settings could not be saved.',503)
    },
  }
}
