const TOPICS = Object.freeze({
  gl: ['🌸 រឿង GL ដែលគួរសាកអាន', '🌸 GL Picks', 'GL'],
  bl: ['💙 រឿង BL ដែលគួរសាកអាន', '💙 BL Picks', 'BL'],
  romance: ['💕 រឿងស្នេហា', '💕 Romance Picks', 'ស្នេហា'],
  fantasy: ['✨ ពិភពស្រមើស្រមៃ', '✨ Fantasy Picks', 'បែបស្រមើស្រមៃ'],
  comedy: ['😄 រឿងកំប្លែង', '😄 Comedy Picks', 'បែបកំប្លែង'],
  trending: ['🔥 រឿងពេញនិយមប្រចាំសប្តាហ៍', '🔥 Top This Week', ''],
  hidden: ['💎 ស្នាដៃដែលអ្នកប្រហែលជាមិនទាន់ស្គាល់', '💎 Hidden Gems', ''],
  completed: ['✅ រឿងចេញចប់', '✅ Completed Stories', ''],
  short: ['📕 រឿងខ្លីដែលចេញចប់', '📕 Short & Completed', ''],
  new: ['🆕 ស្វែងរករឿងថ្មី', '🆕 Discover New Stories', ''],
  similar: ['✨ រឿងប្រភេទស្រដៀងគ្នា', '✨ You May Also Like', ''],
  night: ['🌙 រឿងណែនាំមុនចូលគេង', '🌙 Tonight’s Reading List', ''],
})
const KH = {
  gl: ['ចូលចិត្តរឿង GL មែនទេ? ថ្ងៃនេះមានរឿងមកណែនាំទៀតហើយ។','សម្រាប់អ្នកស្រឡាញ់រឿង GL កុំរំលងបញ្ជីនេះណា៎!','អ្នកអាន GL ទាំងអស់គ្នា តើមានរឿងណាខ្លះដែលអ្នកមិនទាន់បានអាន?','មកស្គាល់រឿង GL ទាំងនេះជាមួយគ្នា ប្រហែលជាមានរឿងដែលត្រូវចិត្តអ្នក។','កំពុងរករឿង GL អានមែនទេ? សាកមើលបញ្ជីនេះសិន។'],
  bl: ['អ្នកគាំទ្ររឿង BL នៅឯណាខ្លះ? មានរឿងមកណែនាំទៀតហើយ!','មិនដឹងអានរឿង BL មួយណាមុនមែនទេ? សាកល្បងរឿងទាំងនេះមើល។','ថ្ងៃនេះ Shadow សូមណែនាំរឿង BL ដែលអ្នកប្រហែលជាមិនទាន់បានអាន។','បើកំពុងស្វែងរករឿង BL អាន កុំភ្លេចមើលបញ្ជីនេះ។','ក្នុងចំណោមរឿង BL ទាំងនេះ តើរឿងមួយណាដែលអ្នកចង់អានជាងគេ?'],
  romance: ['បន្ថែមភាពផ្អែមល្ហែមក្នុងថ្ងៃរបស់អ្នកជាមួយរឿងស្នេហាទាំងនេះ។','សម្រាប់អ្នកដែលចូលចិត្តរឿងស្នេហា ថ្ងៃនេះមានរឿងមកណែនាំ។','តោះស្វែងរករឿងស្នេហាដែលត្រូវនឹងចំណង់ចំណូលចិត្តរបស់អ្នក។','ចង់អានរឿងស្នេហាមួយមែនទេ? មកមើលបញ្ជីនេះ។','ទុកពេលបន្តិចសម្រាប់រឿងស្នេហាដែលអ្នកចូលចិត្ត។'],
  fantasy: ['ចាកចេញពីពិភពធម្មតា ហើយចូលទៅកាន់ពិភពស្រមើស្រមៃតាមរយៈរឿងទាំងនេះ។','សម្រាប់អ្នកដែលចូលចិត្តរឿងបែបស្រមើស្រមៃ ថ្ងៃនេះមានរឿងមកណែនាំ។','តោះស្វែងរកពិភពថ្មីៗតាមរយៈរឿងបែបស្រមើស្រមៃ។','ចង់អានរឿង Fantasy មែនទេ? សាកមើលបញ្ជីនេះ។','សម្រាកពីជីវិតប្រចាំថ្ងៃជាមួយរឿងបែបស្រមើស្រមៃ។'],
  comedy: ['សម្រាកពីភាពតានតឹងជាមួយរឿងបែបកំប្លែង។','ចង់អានរឿងបែបកំប្លែងមែនទេ? ថ្ងៃនេះមានរឿងមកណែនាំ។','ទុកពេលទំនេរបន្តិចសម្រាប់រឿងបែបកំប្លែងទាំងនេះ។','សម្រាប់អ្នកចូលចិត្តរឿងកំប្លែង កុំភ្លេចមើលបញ្ជីនេះ។','តោះជ្រើសរើសរឿងកំប្លែងមួយសម្រាប់ថ្ងៃនេះ។'],
  trending: ['រឿងដែលមានអ្នកអានច្រើនក្នុងសប្តាហ៍នេះ តើអ្នកបានអានរឿងណាខ្លះហើយ?','មកមើលរឿងដែលកំពុងទទួលបានការចាប់អារម្មណ៍ពីអ្នកអាន Shadow។','ក្នុងបញ្ជីរឿងពេញនិយមសប្តាហ៍នេះ តើមានរឿងដែលអ្នកកំពុងតាមដានដែរឬទេ?','បើមិនទាន់ដឹងថាគួរអានរឿងអ្វី សាកមើលរឿងពេញនិយមទាំងនេះសិន។','នេះជារឿងដែលមានអ្នកអានច្រើនក្នុងរយៈពេលប្រាំពីរថ្ងៃចុងក្រោយ។'],
  hidden: ['មានរឿងជាច្រើនដែលអ្នកប្រហែលជាមិនទាន់បានស្គាល់។ ថ្ងៃនេះសាកអានរឿងទាំងនេះមើល។','មកស្វែងរកស្នាដៃដែលអ្នកប្រហែលជាធ្លាប់រំលង។','ភាពពេញនិយមមិនមែនជាអ្វីគ្រប់យ៉ាងទេ។ សាករករឿងដែលត្រូវនឹងចំណង់ចំណូលចិត្តរបស់អ្នក។','ប្រហែលជារឿងដែលអ្នកពេញចិត្តបន្ទាប់ ស្ថិតនៅក្នុងបញ្ជីនេះ។','ថ្ងៃនេះមកស្គាល់ស្នាដៃផ្សេងៗដែលអ្នកប្រហែលជាមិនទាន់បានអាន។'],
  completed: ['មិនចូលចិត្តរង់ចាំភាគថ្មីមែនទេ? រឿងទាំងនេះចេញចប់ហើយ អាចអានរហូតដល់ភាគបញ្ចប់បាន។','សម្រាប់អ្នកដែលចូលចិត្តអានរឿងរហូតដល់ចប់ ថ្ងៃនេះមានរឿងមកណែនាំ។','មិនបាច់រង់ចាំអ្នកនិពន្ធ Update ទៀតទេ ព្រោះរឿងទាំងនេះចេញចប់រួចហើយ។','មានពេលទំនេរ ហើយចង់អានរឿងឱ្យចប់មែនទេ? សាកល្បងរឿងទាំងនេះ។','ជ្រើសរើសរឿងដែលចេញចប់មួយ ហើយអានតាមពេលទំនេររបស់អ្នក។'],
  short: ['មានពេលតិច តែចង់អានរឿងឱ្យចប់មែនទេ? មកសាករឿងខ្លីទាំងនេះ។','មិនចាំបាច់អានរឿងវែងក៏អាចរីករាយនឹងការអានបានដែរ។','សម្រាកបន្តិចជាមួយរឿងខ្លីៗដែលចេញចប់រួចហើយ។','រឿងខ្លីសម្រាប់ថ្ងៃទំនេរ អ្នកអាចជ្រើសរើសអានតាមចំណង់ចំណូលចិត្ត។','ថ្ងៃនេះមានរឿងខ្លីដែលចេញចប់មកណែនាំ ដោយមិនចាំបាច់រង់ចាំភាគថ្មី។'],
  new: ['ចង់ចាប់ផ្តើមអានរឿងថ្មីមែនទេ? សាកមើលបញ្ជីនេះ។','ថ្ងៃនេះមកស្គាល់រឿងដែលទើបចាប់ផ្តើមចេញផ្សាយ។','សម្រាប់អ្នកដែលចូលចិត្តតាមដានរឿងថ្មីៗ មានរឿងមកណែនាំទៀតហើយ។','តើមានរឿងថ្មីមួយណាដែលអ្នកចង់តាមដាន?','មកស្វែងរកស្នាដៃដែលទើបចេញផ្សាយថ្មីៗជាមួយគ្នា។'],
  similar: ['ចង់រករឿងប្រភេទស្រដៀងគ្នាមែនទេ? សាកមើលបញ្ជីនេះ។','មកស្វែងរករឿងដែលមានប្រភេទដូចគ្នាបន្តទៀត។','អានរឿងមួយចប់ហើយមែនទេ? ប្រហែលជាអ្នកចូលចិត្តរឿងទាំងនេះដែរ។','សម្រាប់អ្នកដែលចូលចិត្តរឿងប្រភេទនេះ ថ្ងៃនេះមានជម្រើសបន្ថែម។','ជ្រើសរើសរឿងមួយទៀតពីប្រភេទដែលអ្នកចូលចិត្ត។'],
  night: ['យប់នេះមិនដឹងអានរឿងអីមុនចូលគេងមែនទេ?','មុនចូលគេង កុំភ្លេចទុកពេលបន្តិចសម្រាប់អានរឿងណា៎!','បន្ទាប់ពីនឿយហត់ពេញមួយថ្ងៃ មកសម្រាកជាមួយរឿងទាំងនេះ។','យប់នេះ Shadow មានរឿង {count} មកណែនាំ។ តើអ្នកនឹងជ្រើសរើសរឿងមួយណា?','អានរឿងបន្តិចមុនគេង រួចសម្រាកឱ្យបានគ្រប់គ្រាន់ណា៎។','បញ្ចប់ថ្ងៃនេះជាមួយរឿងដែលអ្នកចូលចិត្ត។','រាត្រីសួស្តី! មុនចូលគេង សាកមើលរឿងដែលយើងបានជ្រើសរើសសម្រាប់អ្នក។','រឿងទាំងនេះសម្រាប់រាត្រីនេះ ប្រហែលជាមានរឿងដែលត្រូវចិត្តអ្នក។','ទុកពេលបន្តិចសម្រាប់ខ្លួនឯង និងរឿងមួយមុនចូលគេង។','យប់នេះមានរឿង {count} សម្រាប់ជ្រើសរើសអានតាមចំណង់ចំណូលចិត្ត។'],
}
const KH_SHARED = ['ថ្ងៃនេះ Shadow មានរឿង {count} មកណែនាំក្នុងប្រភេទនេះ។','តើក្នុងបញ្ជីនេះមានរឿងណាដែលអ្នកមិនទាន់បានអាន?','ចង់រករឿងអានបន្ថែមមែនទេ? សាកជ្រើសរើសពីបញ្ជីនេះ។','រក្សាទុករឿងដែលអ្នកចាប់អារម្មណ៍សម្រាប់ពេលទំនេរ។','មកជ្រើសរើសរឿងដែលត្រូវចិត្តអ្នកពីបញ្ជីថ្ងៃនេះ។']
const EN = {
  gl: 'Looking for your next GL story?', bl: 'In the mood for a BL story?', romance: 'Make a little time for romance.', fantasy: 'Explore a different world through these fantasy stories.', comedy: 'Take a break with these comedy picks.', trending: 'These stories have been among the most read this week.', hidden: 'Discover stories you might have missed.', completed: 'No need to wait for the next episode: these stories are complete.', short: 'Looking for a shorter, completed story?', new: 'Discover stories that have started publishing recently.', similar: 'Explore more stories in a similar genre.', night: 'Looking for something to read before bed?',
}
const EN_SHARED = ['Here are {count} stories to explore today.','Which of these would you read first?','Your next favorite might be on this list.','Save a story for your next reading break.','Explore the collection and see what catches your eye.','Have you read any of these yet?','Find something new for your reading list.','Take a moment to browse today’s selection.','Pick a story that suits your mood.','Here are a few more stories to discover.']
const TAG_LABELS = {gl:['GL','GL'],bl:['BL','BL'],romance:['ស្នេហា','Romance'],comedy:['កំប្លែង','Comedy'],fantasy:['ស្រមើស្រមៃ','Fantasy'],horror:['រន្ធត់','Horror'],mystery:['អាថ៌កំបាំង','Mystery'],drama:['មនោសញ្ចេតនា','Drama'],action:['សកម្មភាព','Action'],'school life':['ជីវិតសាលារៀន','School Life'],historical:['ប្រវត្តិសាស្ត្រ','Historical'],'happy ending':['បញ្ចប់ដោយសុភមង្គល','Happy Ending']}
export const GROUP_TOPICS = Object.freeze(Object.keys(TOPICS))
export function normalizeTag(value) { return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ') }
const ALIASES = {'girls love':'gl',"girls' love":'gl','boys love':'bl',"boys' love":'bl','ស្នេហា':'romance','កំប្លែង':'comedy','ស្រមើស្រមៃ':'fantasy','រន្ធត់':'horror','អាថ៌កំបាំង':'mystery'}
export function storyTags(story) { return [...new Set([story?.main_genre,...(Array.isArray(story?.tags)?story.tags:[])].filter(v=>typeof v==='string').map(normalizeTag).filter(Boolean).map(v=>ALIASES[v]||v))] }
export function sharedStoryTags(stories) { return stories.length ? storyTags(stories[0]).filter(tag=>Object.hasOwn(TAG_LABELS,tag)&&stories.every(s=>storyTags(s).includes(tag))) : [] }
function hash(value) { let h=2166136261; for(const ch of String(value)){h=Math.imul(h^ch.codePointAt(0),16777619)} return h>>>0 }
export function chooseGroupCaption({topic,language,stories,history=[],now=Date.now(),seed=''}) {
  if(!Object.hasOwn(TOPICS,topic)||!['km','en'].includes(language)||!Array.isArray(stories)||!stories.length) throw new TypeError('Invalid group caption input')
  const kh=language==='km'; const count=stories.length
  const variants=kh?[...KH[topic],...(topic==='night'?[]:KH_SHARED)]:[EN[topic],...EN_SHARED]
  const cutoff=now-7*86400000
  const used=new Set(history.filter(h=>h.language===language&&Date.parse(h.sentAt)>=cutoff).map(h=>h.captionId))
  const available=variants.map((text,index)=>({text,id:kh&&topic!=='night'&&index>=KH[topic].length?`km:shared:${index-KH[topic].length}`:!kh&&index>0?`en:shared:${index-1}`:`${language}:${topic}:${index}`})).filter(v=>!used.has(v.id))
  if(!available.length)return null
  const chosen=available[hash(`${seed}:${topic}:${language}`)%available.length]
  const tags=sharedStoryTags(stories).filter(t=>t!==topic).slice(0,2).map(t=>TAG_LABELS[t][kh?0:1])
  const tagLine=tags.length?`${kh?'ប្រភេទរួម៖':'Shared tags:'} ${tags.join(' · ')}`:''
  return {captionId:chosen.id,heading:TOPICS[topic][kh?0:1],intro:chosen.text.replaceAll('{count}',String(count)),tagLine}
}
