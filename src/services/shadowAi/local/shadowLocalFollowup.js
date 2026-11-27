import { cleanShadowText, shadowMatchKey } from './shadowLocalText.js'
import { interpretShadowLocalConversation } from './shadowLocalConversation.js'

export function interpretShadowLocalFollowup(input,dictionary) {
  const original=interpretShadowLocalConversation(input,dictionary)
  if(original.intent!=='unclear') return original
  const key=shadowMatchKey(cleanShadowText(input.message))
  const items=input.current_draft?.items
  if(!Array.isArray(items)||items.length!==1) return original
  const item=items[0]
  if(!item||typeof item.book_id!=='string'||!Array.isArray(input.catalog?.books)||input.catalog.books.length>10) return original
  const book=input.catalog.books.find(b=>b?.id===item.book_id)
  if(!book||!Array.isArray(book.editions)) return original
  const edition=dictionary.lookup('editions',key)
  if(item.edition===null&&edition&&book.editions.includes(edition)) {
    return interpretShadowLocalConversation({...input,message:`edition: ${key}`},dictionary)
  }
  const quantity=/^([1-9][0-9]?)\s*(?:ក្បាល|ច្បាប់|copy|copies)$/u.exec(key)
  if(item.quantity===null&&quantity) {
    return interpretShadowLocalConversation({...input,message:`quantity: ${quantity[1]}`},dictionary)
  }
  return original
}
