import { preOrderError } from './authorPreOrderValidation.service.js'

const PHONE_CHARACTERS = /^\+?[0-9][0-9 ()-]*$/
const TELEGRAM_HANDLE = /^@?[a-zA-Z0-9_]{5,32}$/
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

function invalid(field, detail = 'is invalid') {
  throw preOrderError('PRE_ORDER_BUYER_INVALID', `${field} ${detail}`, 400)
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value, field, max, min = 0, multiline = false) {
  if (value !== undefined && value !== null && typeof value !== 'string') invalid(field)
  const result = String(value ?? '').trim()
  if (result.length < min || result.length > max || FORBIDDEN.test(result)) invalid(field)
  if (!multiline && /[\r\n\t]/u.test(result)) invalid(field)
  return result
}

function phoneNumber(value) {
  const phone = cleanText(value, 'Phone number', 28, 7)
  const digits = phone.replace(/\D/g, '')
  if (!PHONE_CHARACTERS.test(phone) || digits.length < 7 || digits.length > 16) {
    invalid('Phone number')
  }
  return phone
}

function telegramContact(value) {
  const contact = cleanText(value, 'Telegram contact', 250)
  if (!contact) return ''
  if (TELEGRAM_HANDLE.test(contact)) return contact
  try {
    const url = new URL(contact)
    const host = url.hostname.toLowerCase()
    const handle = url.pathname.replace(/^\//, '').replace(/\/$/, '')
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(host) ||
        !TELEGRAM_HANDLE.test(handle) || url.search || url.hash) invalid('Telegram contact')
    return url.href
  } catch {
    invalid('Telegram contact')
  }
}

function facebookContact(value) {
  const link = cleanText(value, 'Facebook link', 500)
  if (!link) return ''
  try {
    const url = new URL(link)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com', 'www.fb.com'].includes(host)) {
      invalid('Facebook link')
    }
    return url.href
  } catch {
    invalid('Facebook link')
  }
}

export function parseAuthorPreOrderBuyerInput(input, { signatureRequested = false } = {}) {
  if (!isObject(input) || !isObject(input.buyer)) {
    invalid('Buyer information', 'must be provided')
  }
  const buyer = input.buyer
  const name = cleanText(buyer.name, 'Buyer name', 160, 2)
  const phone = phoneNumber(buyer.phone_number)
  const address = cleanText(buyer.delivery_address, 'Delivery address', 800, 6, true)
  const province = cleanText(buyer.province_city, 'Province or city', 120)
  const telegram = telegramContact(buyer.telegram_username)
  const facebook = facebookContact(buyer.facebook_link)
  const signatureName = cleanText(input.signature_name, 'Signature name', 160, signatureRequested ? 1 : 0)
  const buyerNote = cleanText(input.buyer_note, 'Buyer note', 1000, 0, true)

  return {
    buyer: {
      name,
      phone_number: phone,
      delivery_address: address,
      province_city: province,
      telegram_username: telegram,
      facebook_link: facebook,
    },
    signature_name: signatureRequested ? signatureName : '',
    buyer_note: buyerNote,
  }
}
