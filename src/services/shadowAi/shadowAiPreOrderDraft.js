import { BOOKING_TEXT_LIMITS, normalizeBookingItems, normalizeBookingText } from './shadowAiPreOrderMessage.js'
import { inspectShadowPreOrderAddress } from './shadowAiPreOrderAddress.js'
import { evaluateShadowPreOrderRules } from './shadowAiPreOrderRequirements.js'
import { shadowAiError } from './shadowAiPolicy.js'

const fields = Object.keys(BOOKING_TEXT_LIMITS)
export function mergeShadowBookingDraft(context, previous = {}, patch = {}) {
  const result = { items: [], signature_requested: null, ...Object.fromEntries(fields.map(k => [k,''])) }
  for (const source of [previous,patch]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw shadowAiError('SHADOW_AI_DRAFT_INVALID','Invalid booking draft',400)
    for (const [key,value] of Object.entries(source)) {
      if (key === 'items') result.items = normalizeBookingItems(value,context)
      else if (key === 'signature_requested' && [null,true,false].includes(value)) result[key] = value
      else if (fields.includes(key)) result[key] = normalizeBookingText(key,value)
      else throw shadowAiError('SHADOW_AI_DRAFT_INVALID','Invalid booking draft',400)
    }
  }
  if (!result.delivery_company_key && context.delivery_companies.length === 1) result.delivery_company_key = context.delivery_companies[0].company_key
  if (result.signature_requested === null && !context.signature_enabled) result.signature_requested = false
  for (const item of result.items) {
    const book = context.books.find(b=>b.id===item.book_id)
    if (item.edition === null && book.editions.length === 1) item.edition = book.editions[0].edition
  }
  return result
}
function phone(value) { return /^\+?[0-9][0-9 ()-]*$/.test(value) && value.replace(/\D/g,'').length >= 7 && value.replace(/\D/g,'').length <= 16 }
function english(value) { return /^[a-zA-Z][a-zA-Z .'-]*$/.test(value) }
function telegram(value) { return /^@?[a-zA-Z0-9_]{5,32}$/.test(value) || /^https:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/[a-zA-Z0-9_]{5,32}\/?$/.test(value) }
function facebook(value) { try { const u = new URL(value); return u.protocol==='https:' && !u.username && !u.password && !u.port && ['facebook.com','www.facebook.com','m.facebook.com','web.facebook.com','fb.com','www.fb.com'].includes(u.hostname) } catch { return false } }
export function inspectShadowBookingDraft(context,draft,rules=[]) {
  const missing = [], issues = []
  if (!context.can_book || !context.stock_verified) issues.push('CAMPAIGN_UNAVAILABLE')
  if (!draft.items.length) missing.push('items')
  for (const item of draft.items) {
    if (!item.edition) missing.push(`edition:${item.book_id}`)
    if (item.quantity === null) missing.push(`quantity:${item.book_id}`)
    const edition = context.books.find(b=>b.id===item.book_id)?.editions.find(e=>e.edition===item.edition)
    if (item.edition && (!edition || edition.available < 1 || (item.quantity !== null && item.quantity > edition.available))) issues.push(`STOCK_UNAVAILABLE:${item.book_id}`)
  }
  if (draft.name.length < 2) missing.push('name')
  if (!phone(draft.phone_number)) missing.push('phone_number')
  const address = inspectShadowPreOrderAddress(draft.delivery_address)
  if (!address.ok) missing.push('delivery_address')
  if (!context.delivery_companies.some(c=>c.company_key===draft.delivery_company_key)) missing.push('delivery_company_key')
  if (draft.signature_requested === null) missing.push('signature_requested')
  if (draft.signature_requested === true && !context.signature_enabled) issues.push('SIGNATURE_UNAVAILABLE')
  if (draft.signature_requested === true && !draft.signature_name) missing.push('signature_name')
  const evaluation = evaluateShadowPreOrderRules(rules,{items:draft.items,signature_requested:draft.signature_requested,province_city:address.ok?address.province_city:null})
  const checks = { second_phone:()=>phone(draft.second_phone)&&draft.second_phone.replace(/\D/g,'')!==draft.phone_number.replace(/\D/g,''), telegram_username:()=>telegram(draft.telegram_username), facebook_link:()=>facebook(draft.facebook_link), detailed_address:()=>draft.detailed_address.length>0&&draft.delivery_address.includes(draft.detailed_address)&&!inspectShadowPreOrderAddress(draft.detailed_address).ok, english_buyer_name:()=>english(draft.english_buyer_name||draft.name), english_signature_name:()=>english(draft.english_signature_name||draft.signature_name), buyer_note:()=>!!draft.buyer_note }
  for (const field of evaluation.required) if (!checks[field]?.()) missing.push(field)
  for (const field of ['telegram_username','facebook_link']) if (draft[field]&&!checks[field]()) missing.push(field)
  return { ready:missing.length===0&&issues.length===0&&evaluation.pending.length===0,missing:[...new Set(missing)],issues,pending_requirements:evaluation.pending,province_city:address.ok?address.province_city:null }
}
