export const SHADOW_GEMINI_QUESTION_TYPES = Object.freeze(['books','price','stock','delivery','signature','schedule','requirements','unclear'])
const samples = Object.freeze({
  price_km: 'បើខ្ញុំយកតែមួយក្បាល តើត្រូវចំណាយប៉ុន្មានដែរ?',
  stock_km: 'សៀវភៅប្រភេទមានកំណត់នៅអាចរកបានទៀតទេ?',
  delivery_km: 'គិតថ្លៃផ្ញើសៀវភៅដល់ខេត្តយ៉ាងម៉េចដែរ?',
  signature_km: 'អាចឱ្យអ្នកនិពន្ធចុះហត្ថលេខាលើសៀវភៅបានទេ?',
  schedule_km: 'តើនៅសល់ពេលប៉ុន្មានទៀតមុនបិទការកក់?',
  requirements_km: 'ពេលកក់ត្រូវផ្តល់ព័ត៌មានអ្វីទៅអ្នកលក់?',
  books_km: 'មានចំណងជើងសៀវភៅណាខ្លះដែលអាចជ្រើសបាន?',
  price_en: 'What would one copy cost me?',
  stock_en: 'Are there any limited copies left to reserve?',
  delivery_en: 'How much would the courier charge?',
  unclear_en: 'Could you tell me more?',
})
export function listShadowGeminiExamples() {
  return Object.entries(samples).map(([id, text]) => ({ id, text }))
}
export function getShadowGeminiExample(id) {
  return typeof id === 'string' && Object.hasOwn(samples, id) ? samples[id] : null
}
