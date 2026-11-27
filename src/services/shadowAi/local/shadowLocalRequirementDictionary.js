import { shadowMatchKey } from './shadowLocalText.js'

const fields = {
  name:['name','buyer name','ឈ្មោះ','ឈ្មោះអ្នកទិញ'],
  phone_number:['phone','phone number','លេខទូរសព្ទ','លេខទូរស័ព្ទ'],
  delivery_address:['address','delivery address','province','city','អាសយដ្ឋាន','ខេត្ត','ក្រុង'],
  second_phone:['second phone','second phone number','លេខទូរសព្ទទី២','លេខទូរស័ព្ទទី២','លេខទូរសព្ទទី ២'],
  telegram_username:['telegram','telegram username','តេឡេក្រាម'],
  facebook_link:['facebook link','facebook','ហ្វេសប៊ុក'],
  detailed_address:['detailed address','full address','អាសយដ្ឋានលម្អិត'],
  english_buyer_name:['english name','english buyer name','ឈ្មោះជាអង់គ្លេស','ឈ្មោះអង់គ្លេស','ឈ្មោះអ្នកទិញជាអង់គ្លេស'],
  english_signature_name:['english signature name','ឈ្មោះស៊ីញ៉េជាអង់គ្លេស'],
  buyer_note:['buyer note','note for author','ចំណាំអ្នកទិញ','សារទៅអ្នកនិពន្ធ'],
}
const conditions = {
  always:['always','all orders','គ្រប់ការកក់','គ្រប់គ្នា'],
  limited:['limited','limited edition','ប្រភេទ limited'],
  standard:['standard','normal','ប្រភេទ normal','ប្រភេទធម្មតា'],
  signed:['signed','signed copy','មានស៊ីញ៉េ','កក់មានស៊ីញ៉េ'],
  outside_phnom_penh:['outside phnom penh','outside pp','ក្រៅភ្នំពេញ','ក្រៅរាជធានីភ្នំពេញ'],
}
function index(source) {
  const map=new Map()
  for(const [key,aliases] of Object.entries(source)) for(const alias of aliases) {
    const normalized=shadowMatchKey(alias)
    if(map.has(normalized)&&map.get(normalized)!==key) throw new Error('Ambiguous requirement alias')
    map.set(normalized,key)
  }
  return map
}
const fieldMap=index(fields), conditionMap=index(conditions)
export const SHADOW_LOCAL_REQUIREMENTS_VERSION='shadow-local-requirements-km-en-v1'
export const localRequirementField=value=>fieldMap.get(shadowMatchKey(value))??null
export const localRequirementCondition=value=>conditionMap.get(shadowMatchKey(value))??null
