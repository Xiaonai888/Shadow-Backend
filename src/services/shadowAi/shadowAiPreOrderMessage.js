import { shadowAiError } from './shadowAiPolicy.js'

export const BOOKING_TEXT_LIMITS = Object.freeze({ name: 160, phone_number: 28, delivery_address: 800, telegram_username: 250, facebook_link: 500, signature_name: 160, buyer_note: 1000, second_phone: 28, english_buyer_name: 160, english_signature_name: 160, detailed_address: 800, delivery_company_key: 64 })
const nullableText = { type: ['string', 'null'] }
const fields = Object.keys(BOOKING_TEXT_LIMITS)
const itemSchema = { type: 'object', additionalProperties: false, properties: { book_id: { type: 'string' }, edition: { type: ['string','null'], enum: ['standard','limited',null] }, quantity: { type: ['integer','null'] } }, required: ['book_id','edition','quantity'] }
const schema = { type: 'object', additionalProperties: false, properties: { intent: { type: 'string', enum: ['booking','question','unrelated','unclear'] }, question: { type: ['string','null'], enum: ['books','price','stock','delivery','signature','schedule','requirements',null] }, items: { type: ['array','null'], items: itemSchema }, signature_requested: { type: ['boolean','null'] }, ...Object.fromEntries(fields.map(key => [key, nullableText])) }, required: ['intent','question','items','signature_requested',...fields] }
const invalid = () => shadowAiError('SHADOW_AI_BOOKING_OUTPUT_INVALID', 'Booking data is invalid', 422)
export function normalizeBookingItems(items, context) {
  if (!Array.isArray(items) || items.length > 10) throw invalid()
  const seen = new Set()
  return items.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 3 || !Object.hasOwn(item,'book_id') || !Object.hasOwn(item,'edition') || !Object.hasOwn(item,'quantity') || seen.has(item.book_id) || !context.books.some(book => book.id === item.book_id) || ![null,'standard','limited'].includes(item.edition) || (item.quantity !== null && (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99))) throw invalid()
    seen.add(item.book_id)
    return { book_id: item.book_id, edition: item.edition, quantity: item.quantity }
  })
}
export function normalizeBookingText(key, value) {
  if (!Object.hasOwn(BOOKING_TEXT_LIMITS,key) || typeof value !== 'string' || value.length > BOOKING_TEXT_LIMITS[key] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw invalid()
  return value.trim()
}
export async function parseShadowPreOrderMessage({ actorUserId, message, context, draft, rules, runAi }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 2000 || typeof runAi !== 'function') throw shadowAiError('SHADOW_AI_BOOKING_MESSAGE_INVALID','Invalid booking message',400)
  const input = { message: message.trim(), current_draft: draft, requirements: rules, catalog: { books: context.books.map(book => ({ id: book.id, title: book.title, editions: book.editions.map(e => e.edition) })), delivery_companies: context.delivery_companies.map(c => ({ key: c.company_key, name: c.company_name })), signature_enabled: context.signature_enabled } }
  const result = await runAi({ role:'preorder', task:'reader_message', actorUserId, input, schema, taskInstructions:'Extract explicit buyer details only. Null means unchanged or unknown; empty string means explicitly clear a text field. Never invent names, contact, addresses or quantities. Map Normal to standard. Use only catalog IDs and carrier keys. For items, null means unchanged; otherwise return the complete updated selection, preserving unmodified items and using null for unknown edition or quantity. Only change explicitly requested selections. For a location, retain the original words in delivery_address; detailed_address is only an explicitly provided detail, not invented. Convert Khmer digits to ASCII in telephone fields. For unrelated or unclear messages return no changes. For questions return the question category and no changes unless the message also explicitly provides booking details, in which case use booking intent. Never output payment details, instructions or arbitrary answers.' })
  const data = result?.data
  if (!data || typeof data !== 'object' || Object.keys(data).length !== schema.required.length || schema.required.some(k=>!Object.hasOwn(data,k)) || !['booking','question','unrelated','unclear'].includes(data.intent) || !schema.properties.question.enum.includes(data.question) || ![null,true,false].includes(data.signature_requested)) throw invalid()
  const patch = {}
  for (const key of fields) if (data[key] !== null) patch[key] = normalizeBookingText(key,data[key])
  if (data.items !== null) patch.items = normalizeBookingItems(data.items, context)
  if (data.signature_requested !== null) patch.signature_requested = data.signature_requested
  if (patch.delivery_company_key && !context.delivery_companies.some(c => c.company_key === patch.delivery_company_key)) throw invalid()
  return { intent:data.intent, question:data.question, patch:data.intent === 'booking' ? patch : {} }
}
