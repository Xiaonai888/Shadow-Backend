const DAY=86400000
const HOUR=3600000
const OFFSET=7*HOUR
const TIMES=Object.freeze([{hour:11,expires:14},{hour:18,expires:21},{hour:21,expires:24}])
const TOPICS=Object.freeze(['gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','similar'])
const hash=value=>{let h=2166136261;for(const ch of String(value))h=Math.imul(h^ch.codePointAt(0),16777619);return h>>>0}
function midnight(now){if(!Number.isFinite(now))throw new TypeError('Invalid schedule time');return Math.floor((now+OFFSET)/DAY)*DAY-OFFSET}
export function promotionSlotsV2(now=Date.now(),enabledAt=null){
  const base=midnight(now),day=new Date(base+OFFSET).toISOString().slice(0,10)
  const enabled=enabledAt==null?-Infinity:Date.parse(enabledAt)
  if(Number.isNaN(enabled))return []
  return TIMES.map(({hour,expires})=>({kind:hour===21?'night':'smart',slotKey:`${day}T${String(hour).padStart(2,'0')}:00`,dueAt:base+hour*HOUR,expiresAt:base+expires*HOUR})).filter(s=>s.dueAt>=enabled&&s.dueAt<=now&&now<s.expiresAt)
}
export function nextPromotionSlotV2(now=Date.now()){
  const base=midnight(now)
  return TIMES.map(s=>base+s.hour*HOUR).find(t=>t>now)??base+DAY+11*HOUR
}
export function daytimeBudgetV2(updateCount){
  if(!Number.isSafeInteger(updateCount)||updateCount<0)throw new TypeError('Invalid update count')
  return updateCount<=5?2:updateCount<=15?1:0
}
export function planOptionalSlotV2({slot,language,stats}){
  if(!['km','en'].includes(language)||!/^\d{4}-\d{2}-\d{2}T(?:11|18|21):00$/.test(slot?.slotKey||'')||!stats)throw new TypeError('Invalid optional slot')
  if(stats.existingId)return {existingId:stats.existingId,plans:[]}
  if(slot.slotKey.endsWith('T21:00'))return {plans:[{topic:'night',postType:'group',count:3}]}
  if(!Number.isSafeInteger(stats.daytimeCount)||stats.daytimeCount<0)throw new TypeError('Invalid daytime count')
  if(stats.daytimeCount>=daytimeBudgetV2(stats.updateCount))return {plans:[]}
  const last=new Map()
  for(const row of stats.recentTopics||[]){const time=Date.parse(row.at);if(TOPICS.includes(row.topic)&&Number.isFinite(time))last.set(row.topic,Math.max(last.get(row.topic)??-Infinity,time))}
  const seed=`${language}:${slot.slotKey}`
  const ordered=TOPICS.filter(t=>t!=='similar'||stats.similarTags?.length).sort((a,b)=>{const x=last.get(a)??-Infinity,y=last.get(b)??-Infinity;return (x===y?0:x<y?-1:1)||hash(`${seed}:${a}`)-hash(`${seed}:${b}`)})
  const evening=slot.slotKey.endsWith('T18:00')
  const postType=evening&&hash(seed)%2===0?'solo':'group'
  return {plans:ordered.slice(0,2).map(topic=>({topic,postType,count:topic==='trending'?5:topic==='hidden'||topic==='short'||topic==='new'||topic==='similar'?3:hash(`${seed}:${topic}`)%2===0?3:5}))}
}
