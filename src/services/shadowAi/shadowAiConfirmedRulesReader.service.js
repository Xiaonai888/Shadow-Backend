import { shadowAiError } from './shadowAiPolicy.js'
import { shadowAiId } from './shadowAiPreOrderAccess.service.js'

const unavailable = () => shadowAiError('SHADOW_AI_REQUIREMENTS_STORAGE_UNAVAILABLE', 'Buyer requirements are temporarily unavailable', 503)
const fields = 'id,owner_user_id,buyer_note_instruction,requirements:shadow_ai_preorder_requirements!shadow_ai_preorder_requirements_campaign_id_fkey(campaign_id,source_instruction,rules,confirmed_by,confirmed_at)'

export function createShadowAiConfirmedRulesReader({ db, readConfirmedRules } = {}) {
  if (typeof db?.from !== 'function' || typeof readConfirmedRules !== 'function') throw new TypeError('Confirmed rules reader dependencies required')
  return async function loadConfirmedRules({ authorPageId, campaignId }) {
    const id = shadowAiId(campaignId), author = shadowAiId(authorPageId)
    const { data, error } = await db.from('author_preorder_campaigns')
      .select(fields).eq('id', id).eq('author_page_id', author).maybeSingle()
      .abortSignal(AbortSignal.timeout(5000))
    if (error) throw unavailable()
    if (data === null) return { confirmed: false, rules: [] }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== id || typeof data.owner_user_id !== 'string' || !Object.hasOwn(data, 'buyer_note_instruction') || !Object.hasOwn(data, 'requirements')) throw unavailable()
    const related = data.requirements
    if (Array.isArray(related) && related.length > 1) throw unavailable()
    const row = Array.isArray(related) ? related[0] ?? null : related
    if (row !== null && (!row || typeof row !== 'object' || Array.isArray(row) || row.campaign_id !== id || !Object.hasOwn(row, 'source_instruction') || !Object.hasOwn(row, 'confirmed_by') || !Object.hasOwn(row, 'rules') || !Object.hasOwn(row, 'confirmed_at'))) throw unavailable()
    return readConfirmedRules(data, row)
  }
}
