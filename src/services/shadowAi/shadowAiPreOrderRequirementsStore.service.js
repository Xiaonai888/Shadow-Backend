import { shadowAiError } from './shadowAiPolicy.js'
import { shadowAiId } from './shadowAiPreOrderAccess.service.js'
import { normalizeShadowPreOrderRules, previewShadowPreOrderRequirements } from './shadowAiPreOrderRequirements.js'

const unavailable=()=>shadowAiError('SHADOW_AI_REQUIREMENTS_STORAGE_UNAVAILABLE','Buyer requirements are temporarily unavailable',503)
const stale=()=>shadowAiError('SHADOW_AI_REQUIREMENTS_STALE','Save the current draft and review its requirements again',409)
export function readShadowAiConfirmedRules(campaign,row) {
  if (!campaign || !row || row.source_instruction!==campaign.buyer_note_instruction || row.confirmed_by!==campaign.owner_user_id) return {confirmed:false,rules:[]}
  return {confirmed:true,rules:normalizeShadowPreOrderRules(row.rules),source_instruction:row.source_instruction,confirmed_at:row.confirmed_at}
}
export function createShadowAiRequirementsStore({db,runAi,requireOwner,getOwnedCampaign}) {
  async function read(query) {
    const {data,error}=await query.abortSignal(AbortSignal.timeout(5000))
    if(error) throw unavailable()
    return data
  }
  async function rowFor(id) {
    return read(db.from('shadow_ai_preorder_requirements').select('source_instruction,rules,confirmed_by,confirmed_at').eq('campaign_id',id).maybeSingle())
  }
  async function owned(actor,campaignId) {
    const owner=await requireOwner(shadowAiId(actor))
    const campaign=await getOwnedCampaign(owner,shadowAiId(campaignId))
    return {owner,campaign}
  }
  async function loadConfirmedRules({authorPageId,campaignId}) {
    const id=shadowAiId(campaignId), author=shadowAiId(authorPageId)
    const campaign=await read(db.from('author_preorder_campaigns').select('id,owner_user_id,buyer_note_instruction').eq('id',id).eq('author_page_id',author).maybeSingle())
    if(!campaign) return {confirmed:false,rules:[]}
    return readShadowAiConfirmedRules(campaign,await rowFor(id))
  }
  return {loadConfirmedRules,
    async listConfirmedCampaignIds(authorPageId, campaignIds) {
      const author=shadowAiId(authorPageId)
      if(!Array.isArray(campaignIds)||campaignIds.length>10) throw stale()
      const ids=[...new Set(campaignIds.map(shadowAiId))]
      if(!ids.length) return []
      const [campaigns,rows]=await Promise.all([
        read(db.from('author_preorder_campaigns').select('id,owner_user_id,buyer_note_instruction').eq('author_page_id',author).in('id',ids)),
        read(db.from('shadow_ai_preorder_requirements').select('campaign_id,source_instruction,rules,confirmed_by,confirmed_at').in('campaign_id',ids)),
      ])
      const byId=new Map((rows||[]).map(row=>[row.campaign_id,row]))
      return (campaigns||[]).filter(c=>readShadowAiConfirmedRules(c,byId.get(c.id)).confirmed).map(c=>c.id)
    },
    async get(actor,id) {
      const {campaign}=await owned(actor,id)
      return {...readShadowAiConfirmedRules(campaign,await rowFor(campaign.id)),source_instruction:campaign.buyer_note_instruction,editable:campaign.status==='draft'}
    },
    async preview(actor,id,templateRules) {
      const {campaign}=await owned(actor,id)
      if(campaign.status!=='draft') throw stale()
      const preview=await previewShadowPreOrderRequirements({actorUserId:actor,templateRules,instruction:campaign.buyer_note_instruction,runAi})
      return {...preview,source_instruction:campaign.buyer_note_instruction}
    },
    async confirm(actor,id,input) {
      const {owner,campaign}=await owned(actor,id)
      if(campaign.status!=='draft' || input?.confirmed!==true || input.source_instruction!==campaign.buyer_note_instruction) throw stale()
      const rules=normalizeShadowPreOrderRules(input.rules)
      const {data,error}=await db.rpc('shadow_ai_confirm_requirements_v1',{p_campaign_id:campaign.id,p_author_page_id:owner.authorPageId,p_owner_user_id:owner.userId,p_source_instruction:input.source_instruction,p_rules:rules}).abortSignal(AbortSignal.timeout(5000))
      if(error) throw unavailable()
      if(data!==true) throw stale()
      return {confirmed:true,rules,source_instruction:input.source_instruction}
    },
  }
}
