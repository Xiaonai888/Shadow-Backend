import { cleanShadowText, shadowMatchKey, splitShadowLabels, readShadowLabeledLine } from './shadowLocalText.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { interpretShadowLocalBooking } from './shadowLocalBooking.js'

const defaultDictionary=createShadowLocalDictionary()
const phrases=[
  ['name',/^(?:my name is\s+|ខ្ញុំឈ្មោះ\s*|ឈ្មោះខ្ញុំ\s*)(.+)$/iu],
  ['phone',/^(?:my phone number is\s+|my phone is\s+|លេខទូរសព្ទខ្ញុំ\s*|លេខទូរស័ព្ទខ្ញុំ\s*|លេខទូរសព្ទ\s+|លេខទូរស័ព្ទ\s+)(.+)$/iu],
  ['address',/^(?:deliver to\s+|ship to\s+|my address is\s+|ដឹកទៅ\s*|ផ្ញើទៅ\s*)(.+)$/iu],
  ['delivery company',/^(?:ship via\s+|deliver via\s+|ដឹកតាម\s*)(.+)$/iu],
  ['edition',/^(?:edition\s+|ប្រភេទ\s*)(.+)$/iu],
  ['quantity',/^(?:quantity\s+|qty\s+|ចំនួន\s*)(.+)$/iu],
  ['signature name',/^(?:sign as\s+|ឈ្មោះស៊ីញ៉េ\s*)(.+)$/iu],
]
const signatureAnswers=new Map([['ចង់បានស៊ីញ៉េ','yes'],['យកស៊ីញ៉េ','yes'],['មិនយកស៊ីញ៉េ','no'],['អត់យកស៊ីញ៉េ','no'],['i want a signed copy','yes'],['no signature','no'],['without signature','no']])
function expandLine(line,input,dictionary) {
  if(readShadowLabeledLine(line)) return line
  const key=shadowMatchKey(line)
  if(signatureAnswers.has(key)) return `signature: ${signatureAnswers.get(key)}`
  for(const [field,pattern] of phrases) {
    const match=pattern.exec(line)
    if(match?.[1]?.trim()) return `${field}: ${match[1].trim()}`
  }
  const prefix=dictionary.aliases('bookingPrefixes').find(a=>key.startsWith(a+' ')||(/[\u1780-\u17ff]/u.test(a)&&key.startsWith(a)))
  if(!prefix) return null
  const rest=key.slice(prefix.length).trim()
  const matches=[]
  for(const book of input.catalog?.books??[]) {
    const title=shadowMatchKey(book.title)
    if(!title||!rest.startsWith(title)) continue
    const suffix=rest.slice(title.length).trim()
    if(!suffix) {matches.push(`book: ${book.title}`);continue}
    const m=/^(?:(normal|standard|limited|ធម្មតា|មានកំណត់)\s*)?(\d{1,2})\s*(?:ក្បាល|ច្បាប់|copies|copy)$/u.exec(suffix)
    if(m&&Number(m[2])>=1&&Number(m[2])<=99) matches.push([`book: ${book.title}`,m[1]?`edition: ${m[1]}`:null,`quantity: ${m[2]}`].filter(Boolean).join('\n'))
  }
  return matches.length===1?matches[0]:null
}
export function interpretShadowLocalConversation(input,dictionary=defaultDictionary) {
  const original=interpretShadowLocalBooking(input,dictionary)
  if(original.intent!=='unclear') return original
  const message=cleanShadowText(input?.message)
  if(!message||!Array.isArray(input?.catalog?.books)||input.catalog.books.length>10||input.catalog.books.some(b=>typeof b?.title!=='string'||/[\r\n:：]/u.test(b.title))) return original
  const lines=splitShadowLabels(message)
  if(lines.length>16) return original
  const expanded=lines.map(line=>expandLine(line,input,dictionary))
  if(expanded.some(line=>!line)) return original
  const combined=expanded.join('\n')
  if(combined.length>2000) return original
  return interpretShadowLocalBooking({...input,message:combined},dictionary)
}
