import { BOOKING_TEXT_LIMITS } from '../shadowAiPreOrderMessage.js'
import { inspectShadowPreOrderAddress } from '../shadowAiPreOrderAddress.js'
import { cleanShadowText, readShadowLabeledLine, shadowAsciiDigits, shadowMatchKey, splitShadowLabels } from './shadowLocalText.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'

const defaultDictionary = createShadowLocalDictionary()
const blank = () => ({ intent:'unclear', question:null, items:null, signature_requested:null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key,null])) })
const phone = value => /^\+?[0-9][0-9 ()-]*$/u.test(value) && value.replace(/\D/gu,'').length >= 7 && value.replace(/\D/gu,'').length <= 16
const keyOfQuestion = value => shadowMatchKey(value).replace(/[?？។!！]+$/u,'').trim()
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)

function matchUnique(value, list, aliases) {
  const key = shadowMatchKey(value)
  const matches = list.filter(item => aliases(item).some(alias => typeof alias === 'string' && shadowMatchKey(alias) === key))
  return matches.length === 1 ? matches[0] : null
}

function validText(field, value) {
  if (!value || value.length > BOOKING_TEXT_LIMITS[field]) return null
  if (['phone_number','second_phone'].includes(field)) {
    const digits = shadowAsciiDigits(value)
    return phone(digits) ? digits : null
  }
  if (field === 'delivery_address') return inspectShadowPreOrderAddress(value).ok ? value : null
  if (['name','signature_name','english_buyer_name','english_signature_name'].includes(field)) {
    if (value.length < 2 || !/\p{L}/u.test(value) || /[\d០-៩@:/]/u.test(value)) return null
  }
  if (field === 'telegram_username' && !/^@?[a-zA-Z0-9_]{5,32}$|^https:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/[a-zA-Z0-9_]{5,32}\/?$/u.test(value)) return null
  if (field === 'facebook_link') {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !['facebook.com','www.facebook.com','m.facebook.com','web.facebook.com','fb.com','www.fb.com'].includes(url.hostname)) return null
    } catch { return null }
  }
  return value
}

export function interpretShadowLocalBooking(input, dictionary = defaultDictionary) {
  const message = cleanShadowText(input?.message)
  const output = blank()
  const catalog = input?.catalog
  const books = catalog?.books
  const carriers = catalog?.delivery_companies
  const previous = input?.current_draft?.items ?? []
  if (!message || !Array.isArray(books) || books.length>10 || !Array.isArray(carriers) || carriers.length>32 || !Array.isArray(previous) || previous.length>10) return output
  if (books.some(book => !validId(book?.id) || typeof book.title!=='string' || !Array.isArray(book.editions) || book.editions.length>2 || book.editions.some(e=>!['standard','limited'].includes(e))) || carriers.some(c=>typeof c?.key!=='string' || typeof c.name!=='string')) return output
  if (previous.some(item=>!books.some(book=>book.id===item?.book_id) || ![null,'standard','limited'].includes(item.edition) || (item.quantity!==null && (!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>99))) || new Set(previous.map(item=>item.book_id)).size!==previous.length) return output
  const question = dictionary.lookup('questions',keyOfQuestion(message))
  if (question) return {...output,intent:'question',question}
  const lines = splitShadowLabels(message)
  const entries = []
  for (const line of lines) {
    const labeled = readShadowLabeledLine(line)
    if (labeled) {
      const field = dictionary.lookup('fields', labeled.label)
      if (!field) return blank()
      entries.push([field,labeled.value])
    } else {
      const normalized = shadowMatchKey(line)
      const prefix = dictionary.aliases('bookingPrefixes').find(alias => normalized.startsWith(alias+' ') || (/[\u1780-\u17ff]/u.test(alias) && normalized.startsWith(alias)))
      if (!prefix || !normalized.slice(prefix.length).trim()) return blank()
      entries.push(['book',normalized.slice(prefix.length).trim()])
    }
  }
  if (!entries.length || new Set(entries.map(([field])=>field)).size !== entries.length) return blank()
  const values = Object.fromEntries(entries)
  let selected = null
  if (values.book !== undefined) {
    selected = matchUnique(values.book,books,b=>[b.title])
    if (!selected) return blank()
  } else if (values.edition !== undefined || values.quantity !== undefined) {
    if (previous.length !== 1) return blank()
    selected = books.find(book => book.id===previous[0].book_id)
    if (!selected) return blank()
  }
  if (selected) {
    const current = previous.find(item=>item.book_id===selected.id)
    const edition = values.edition !== undefined ? dictionary.lookup('editions',values.edition) : current?.edition ?? null
    const quantityText = values.quantity !== undefined ? shadowMatchKey(values.quantity) : null
    const quantity = quantityText === null ? current?.quantity ?? null : /^\d{1,2}(?:\s*(?:ក្បាល|ច្បាប់|copies|copy))?$/u.test(quantityText) ? Number(quantityText.match(/^\d+/u)[0]) : NaN
    if ((values.edition !== undefined && !edition) || (edition!==null&&!selected.editions.includes(edition)) || (quantity!==null&&(!Number.isInteger(quantity)||quantity<1||quantity>99))) return blank()
    const next = {book_id:selected.id,edition,quantity}
    output.items = previous.some(item=>item.book_id===selected.id) ? previous.map(item=>item.book_id===selected.id?next:{...item}) : [...previous.map(item=>({...item})),next]
    if (output.items.length>10) return blank()
  }
  for (const [field,value] of entries) {
    if (['book','edition','quantity'].includes(field)) continue
    if (field==='signature_requested') {
      const answer=dictionary.lookup('answers',value)
      if (!answer || (answer==='yes' && catalog.signature_enabled!==true)) return blank()
      output.signature_requested=answer==='yes'
    } else if (field==='delivery_company_key') {
      const carrier=matchUnique(value,carriers,c=>[c.key,c.name])
      if (!carrier || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(carrier.key)) return blank()
      output[field]=carrier.key
    } else {
      const parsed=validText(field,value)
      if (parsed===null) return blank()
      output[field]=parsed
    }
  }
  output.intent='booking'
  return output
}
