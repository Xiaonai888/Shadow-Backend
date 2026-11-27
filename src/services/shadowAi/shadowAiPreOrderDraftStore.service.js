import { shadowAiError } from './shadowAiPolicy.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const invalid = () => shadowAiError('SHADOW_AI_DRAFT_INVALID','Invalid booking draft',400)
const unavailable = () => shadowAiError('SHADOW_AI_DRAFT_STORAGE_UNAVAILABLE','Booking draft is temporarily unavailable',503)
export function normalizeShadowDraftScope(scope) {
  if (!scope || !['actorUserId','authorPageId','campaignId'].every(k => typeof scope[k] === 'string' && UUID.test(scope[k]))) throw invalid()
  return Object.fromEntries(['actorUserId','authorPageId','campaignId'].map(k=>[k,scope[k].toLowerCase()]))
}
function validRevision(value) { return Number.isSafeInteger(value) && value >= 0 }
export function createShadowAiDraftStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.from !== 'function' || typeof db.rpc !== 'function') throw new TypeError('Draft database required')
  return {
    async load(scope) {
      const s = normalizeShadowDraftScope(scope)
      const { data,error } = await db.from('shadow_ai_booking_drafts').select('draft,revision,expires_at')
        .eq('reader_user_id',s.actorUserId).eq('author_page_id',s.authorPageId).eq('campaign_id',s.campaignId)
        .gt('expires_at',new Date(now()).toISOString()).maybeSingle().abortSignal(AbortSignal.timeout(5000))
      if (error) throw unavailable()
      if (!data) return { draft:{},revision:null,expires_at:null }
      if (!validRevision(data.revision) || !data.draft || typeof data.draft !== 'object' || Array.isArray(data.draft) || !Number.isFinite(Date.parse(data.expires_at))) throw unavailable()
      if (Date.parse(data.expires_at) <= now()) return { draft:{},revision:null,expires_at:null }
      return { draft:data.draft,revision:data.revision,expires_at:data.expires_at }
    },
    async save(scope,expectedRevision,draft) {
      const s = normalizeShadowDraftScope(scope)
      if (expectedRevision !== null && !validRevision(expectedRevision) || !draft || typeof draft !== 'object' || Array.isArray(draft) || Buffer.byteLength(JSON.stringify(draft)) > 16000) throw invalid()
      const { data,error } = await db.rpc('shadow_ai_save_booking_draft_v1',{
        p_reader_user_id:s.actorUserId,p_author_page_id:s.authorPageId,p_campaign_id:s.campaignId,
        p_expected_revision:expectedRevision,p_draft:draft,
      }).abortSignal(AbortSignal.timeout(5000))
      if (error) throw unavailable()
      if (data?.ok !== true) {
        if (data?.code === 'SHADOW_AI_DRAFT_CONFLICT') throw shadowAiError(data.code,'Booking draft changed. Reopen and try again.',409)
        if (data?.code === 'SHADOW_AI_CAMPAIGN_UNAVAILABLE') throw shadowAiError(data.code,'Pre-order is unavailable',409)
        if (data?.code === 'SHADOW_AI_DRAFT_INVALID') throw invalid()
        throw unavailable()
      }
      if (!validRevision(data.revision) || !Number.isFinite(Date.parse(data.expires_at))) throw unavailable()
      return { revision:data.revision,expires_at:data.expires_at }
    },
  }
}
