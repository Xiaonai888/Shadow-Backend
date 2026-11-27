const PLACES = [
  ['ភ្នំពេញ','Phnom Penh','ភ្នំពេញ|ភ្នំ​ពេញ|phnom penh|phnompenh|pp'],
  ['បន្ទាយមានជ័យ','Banteay Meanchey','បន្ទាយមានជ័យ|ប៉ោយប៉ែត|សិរីសោភ័ណ|banteay meanchey|poipet|serei saophoan|sisophon'],
  ['បាត់ដំបង','Battambang','បាត់ដំបង|battambang|bat dambang'],
  ['កំពង់ចាម','Kampong Cham','កំពង់ចាម|kampong cham|kompong cham'],
  ['កំពង់ឆ្នាំង','Kampong Chhnang','កំពង់ឆ្នាំង|kampong chhnang|kompong chhnang'],
  ['កំពង់ស្ពឺ','Kampong Speu','កំពង់ស្ពឺ|ច្បារមន|kampong speu|kompong speu|chbar mon'],
  ['កំពង់ធំ','Kampong Thom','កំពង់ធំ|ស្ទឹងសែន|kampong thom|kompong thom|stung sen'],
  ['កំពត','Kampot','កំពត|kampot'],
  ['កណ្ដាល','Kandal','កណ្ដាល|កណ្តាល|តាខ្មៅ|kandal|ta khmau|takhmao|ta khmao'],
  ['កោះកុង','Koh Kong','កោះកុង|ខេមរភូមិន្ទ|koh kong|kohkong|khemarak phoumin'],
  ['ក្រចេះ','Kratie','ក្រចេះ|kratie|kracheh'],
  ['មណ្ឌលគិរី','Mondulkiri','មណ្ឌលគិរី|សែនមនោរម្យ|mondulkiri|mondul kiri|sen monorom'],
  ['ឧត្តរមានជ័យ','Oddar Meanchey','ឧត្តរមានជ័យ|សំរោង|oddar meanchey|oddar meanchey'],
  ['ប៉ៃលិន','Pailin','ប៉ៃលិន|pailin'],
  ['ព្រះសីហនុ','Preah Sihanouk','ព្រះសីហនុ|កំពង់សោម|sihanoukville|preah sihanouk|kampong som'],
  ['ព្រះវិហារ','Preah Vihear','ព្រះវិហារ|preah vihear'],
  ['ពោធិ៍សាត់','Pursat','ពោធិ៍សាត់|ពោធិសាត់|pursat|pouthisat'],
  ['ព្រៃវែង','Prey Veng','ព្រៃវែង|prey veng|preyveng'],
  ['រតនគិរី','Ratanakiri','រតនគិរី|បានលុង|ratanakiri|ratanak kiri|banlung'],
  ['សៀមរាប','Siem Reap','សៀមរាប|siem reap|siemreap'],
  ['ស្ទឹងត្រែង','Stung Treng','ស្ទឹងត្រែង|stung treng|stoeng treng'],
  ['ស្វាយរៀង','Svay Rieng','ស្វាយរៀង|បាវិត|svay rieng|bavet'],
  ['តាកែវ','Takeo','តាកែវ|ដូនកែវ|takeo|ta keo|doun kaev'],
  ['កែប','Kep','កែប|kep'],
  ['ត្បូងឃ្មុំ','Tboung Khmum','ត្បូងឃ្មុំ|សួង|tboung khmum|tbuong khmum|suong'],
]

function normalized(value) {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '').trim().toLowerCase()
}

function contains(text, alias) {
  const key = normalized(alias)
  if (/[\u1780-\u17ff]/u.test(key)) return text.replace(/\s/gu, '').includes(key.replace(/\s/gu, ''))
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text)
}

export function inspectShadowPreOrderAddress(value) {
  if (typeof value !== 'string' || value.length > 800 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return { ok: false, code: 'ADDRESS_INVALID' }
  const address = value.trim()
  if (!address) return { ok: false, code: 'ADDRESS_REQUIRED' }
  const text = normalized(address)
  const matches = PLACES.filter(([, , aliases]) => aliases.split('|').some(alias => contains(text, alias)))
  if (!matches.length) return { ok: false, code: 'PROVINCE_OR_CITY_REQUIRED' }
  if (matches.length !== 1) return { ok: false, code: 'PROVINCE_OR_CITY_AMBIGUOUS', candidates: matches.map(([km]) => km) }
  const [province, english] = matches[0]
  return { ok: true, delivery_address: address, province_city: province, province_city_en: english }
}
