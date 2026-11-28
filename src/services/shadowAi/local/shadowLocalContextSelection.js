import { cleanShadowText, shadowMatchKey } from './shadowLocalText.js'

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const editions = new Set(['standard', 'limited'])
const units = '(?:ក្បាល|ច្បាប់|copies|copy)'
const quantityOnly = new RegExp(`^([1-9][0-9]?)\\s*${units}$`, 'u')
const editionAndQuantity = new RegExp(`^(.+?)\\s*([1-9][0-9]?)\\s*${units}$`, 'u')
const actionPrefix = /^(?:(?:i (?:want|would like) to take|i(?:'ll| will) take|take)\s+|(?:សូមយក|ខ្ញុំយក|ចង់យក|យក)\s*)/u
const validQuantity = value => value === null || Number.isSafeInteger(value) && value >= 1 && value <= 99

export function matchShadowLocalContextSelection(input, dictionary) {
  if (typeof dictionary?.lookup !== 'function') throw new TypeError('Context dictionary required')
  const cleaned = cleanShadowText(input?.message)
  if (!cleaned || cleaned.length > 160 || /[\r\n:：;?？]/u.test(cleaned)) return null
  const items = input?.current_draft?.items, books = input?.catalog?.books
  if (!Array.isArray(items) || items.length !== 1 || !Array.isArray(books) || books.length < 1 || books.length > 10) return null
  const item = items[0]
  if (typeof item?.book_id !== 'string' || !idPattern.test(item.book_id) || !(item.edition === null || editions.has(item.edition)) || !validQuantity(item.quantity)) return null
  const matches = books.filter(book => book?.id === item.book_id)
  if (matches.length !== 1) return null
  const available = matches[0].editions
  if (!Array.isArray(available) || available.length < 1 || available.length > 2 || new Set(available).size !== available.length || available.some(value => !editions.has(value)) || (item.edition !== null && !available.includes(item.edition))) return null
  const key = shadowMatchKey(cleaned).replace(/[។.!！]+$/u, '').trim()
  const body = key.replace(actionPrefix, '').trim()
  if (!body || /[?？។.!！,，]/u.test(body)) return null
  let edition = null, quantity = null
  const exact = dictionary.lookup('editions', body)
  const justQuantity = quantityOnly.exec(body)
  const combined = editionAndQuantity.exec(body)
  if (editions.has(exact)) edition = exact
  else if (justQuantity) quantity = Number(justQuantity[1])
  else if (combined) {
    const alias = combined[1].trim()
    if (!alias || /\p{N}/u.test(alias)) return null
    edition = dictionary.lookup('editions', alias)
    if (!editions.has(edition)) return null
    quantity = Number(combined[2])
  } else return null
  if (edition !== null && (!available.includes(edition) || item.edition !== null && item.edition !== edition)) return null
  if (quantity !== null && item.quantity !== null && item.quantity !== quantity) return null
  const setEdition = edition !== null && item.edition === null
  const setQuantity = quantity !== null && item.quantity === null
  if (!setEdition && !setQuantity) return null
  const expected = { book_id: item.book_id, edition: setEdition ? edition : item.edition, quantity: setQuantity ? quantity : item.quantity }
  const message = [setEdition ? `edition: ${edition}` : null, setQuantity ? `quantity: ${quantity}` : null].filter(Boolean).join('\n')
  return { message, expected }
}
