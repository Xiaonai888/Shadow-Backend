import { shadowMatchKey } from './shadowLocalText.js'

const seed = {
  fields: {
    name: ['name','buyer name','ឈ្មោះ','ឈ្មោះអ្នកទិញ'],
    phone_number: ['phone','phone number','លេខទូរសព្ទ','លេខទូរស័ព្ទ','លេខទូរសព្ទទី១'],
    delivery_address: ['address','delivery address','អាសយដ្ឋាន','អាសយដ្ឋានដឹកជញ្ជូន','ខេត្ត','ក្រុង'],
    second_phone: ['second phone','លេខទូរសព្ទទី២','លេខទូរស័ព្ទទី២'],
    telegram_username: ['telegram','telegram username','តេឡេក្រាម'],
    facebook_link: ['facebook','facebook link','ហ្វេសប៊ុក'],
    signature_name: ['signature name','ឈ្មោះស៊ីញ៉េ','ឈ្មោះសម្រាប់ស៊ីញ៉េ'],
    english_buyer_name: ['english name','english buyer name','ឈ្មោះអង់គ្លេស'],
    english_signature_name: ['english signature name','ឈ្មោះស៊ីញ៉េជាអង់គ្លេស'],
    detailed_address: ['detailed address','អាសយដ្ឋានលម្អិត'],
    buyer_note: ['note','buyer note','ចំណាំ','សារទៅអ្នកនិពន្ធ'],
    delivery_company_key: ['delivery company','carrier','ក្រុមហ៊ុនដឹកជញ្ជូន','ដឹកតាម'],
    signature_requested: ['signature','signed copy','ស៊ីញ៉េ','ហត្ថលេខា'],
    book: ['book','book title','សៀវភៅ','ឈ្មោះសៀវភៅ'],
    edition: ['edition','version','ប្រភេទ','កញ្ចប់'],
    quantity: ['quantity','qty','ចំនួន'],
  },
  editions: { standard: ['normal','standard','ធម្មតា'], limited: ['limited','limited edition','មានកំណត់'] },
  answers: { yes: ['yes','true','ចង់បាន','យក','មាន','បាទ','ចាស'], no: ['no','false','អត់','មិនយក','មិនចង់បាន','មិនបាច់','អត់ទេ'] },
  questions: {
    books: ['មានសៀវភៅអីខ្លះ','មានសៀវភៅអ្វីខ្លះ','what books','which books are available'],
    price: ['តម្លៃប៉ុន្មាន','ថ្លៃប៉ុន្មាន','តម្លៃ','how much','price','what is the price'],
    stock: ['នៅមានស្តុកអត់','នៅសល់ប៉ុន្មាន','អស់ស្តុកនៅ','in stock','is it available','stock'],
    delivery: ['ដឹកប៉ុន្មាន','ថ្លៃដឹកប៉ុន្មាន','ដឹកតាមអី','delivery fee','shipping cost'],
    signature: ['មានស៊ីញ៉េអត់','ស៊ីញ៉េថ្លៃប៉ុន្មាន','signed copy available','signature fee'],
    schedule: ['បិទកក់ថ្ងៃណា','ដឹកថ្ងៃណា','ចេញថ្ងៃណា','when does preorder close','when will it ship'],
    requirements: ['ត្រូវការព័ត៌មានអីខ្លះ','ត្រូវការអ្វីខ្លះ','what information is needed','requirements'],
  },
  bookingPrefixes: { book: ['ចង់កក់','សុំកក់','កក់','i want to reserve','i want to preorder','reserve','preorder','pre-order'] },
}

export const SHADOW_LOCAL_DICTIONARY_VERSION = 'shadow-local-km-en-v1'

export function createShadowLocalDictionary() {
  const groups = new Map()
  for (const [group, entries] of Object.entries(seed)) {
    const values = new Map()
    for (const [canonical, aliases] of Object.entries(entries)) {
      for (const alias of aliases) {
        const key = shadowMatchKey(alias)
        if (values.has(key) && values.get(key) !== canonical) throw new Error('Ambiguous dictionary alias')
        values.set(key, canonical)
      }
    }
    groups.set(group, values)
  }
  return Object.freeze({
    version: SHADOW_LOCAL_DICTIONARY_VERSION,
    lookup(group, value) { return typeof value === 'string' ? groups.get(group)?.get(shadowMatchKey(value)) ?? null : null },
    aliases(group) { return Array.from(groups.get(group)?.keys() || []).sort((a,b) => b.length-a.length) },
  })
}
