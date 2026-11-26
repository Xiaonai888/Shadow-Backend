import { evaluatePromotion, PROMOTION_POLICY } from './policy.service.js'
import { buildPromotionMessage } from './message.service.js'
const DAY=86400000
export function eligibleScheduledCandidates({candidates,kind,language,history=[],now=Date.now()}) {
  if (!['completed','short','trending','author'].includes(kind)) throw new TypeError('Invalid scheduled promotion kind')
  const storyHistory=new Set(),authorHistory=new Set()
  for(const row of history) {
    if (row.kind==='update' || !['ready','sending','sent','uncertain'].includes(row.status)) continue
    const pending=['ready','sending'].includes(row.status)
    const when=Date.parse(row.sent_at || row.updated_at || '')
    if(pending || when>=now-PROMOTION_POLICY.storyCooldownDays*DAY) storyHistory.add(String(row.story_id))
    if(row.kind==='author' && (pending || when>=now-PROMOTION_POLICY.authorCooldownDays*DAY)) authorHistory.add(String(row.author_id))
  }
  const rows=candidates.filter(row=>{
    const story=row.story
    if (!story || !story.cover_url || storyHistory.has(String(story.id))) return false
    if(kind==='author' && (Number(row.authorStoryCount)<3 || authorHistory.has(String(story.author_id)))) return false
    if(kind==='trending' && !(Number(row.activity7)>0)) return false
    return evaluatePromotion({...row,kind,language,now}).eligible
  })
  return rows.sort((a,b)=>kind==='trending' ? Number(b.activity7)-Number(a.activity7) || String(a.story.id).localeCompare(String(b.story.id)) : Number(a.lastPromotedAt || 0)-Number(b.lastPromotedAt || 0) || String(a.story.id).localeCompare(String(b.story.id)))
}
export function duePromotionSlots(schedule,now=Date.now()) {
  const local=new Date(now+7*3600000)
  const day=local.getUTCDay(),date=local.toISOString().slice(0,10)
  const seen=new Set()
  return (Array.isArray(schedule)?schedule:[]).flatMap(slot=>{
    if(slot?.day!==day || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.time) || !['completed','short','trending','author'].includes(slot.kind)) return []
    const slotKey=`${date}T${slot.time}`
    const dueAt=Date.parse(`${slotKey}:00+07:00`)
    if(seen.has(slotKey) || dueAt>now) return []
    seen.add(slotKey)
    return [{kind:slot.kind,slotKey,dueAt,expiresAt:Math.min(dueAt+3*3600000,Date.parse(`${date}T00:00:00+07:00`)+DAY)}]
  }).filter(slot=>slot.expiresAt>now).sort((a,b)=>a.dueAt-b.dueAt)
}
export async function enqueueScheduledCandidate({queue,settings,slot,candidates,history,now=Date.now()}) {
  if(!settings?.enabled || slot.dueAt>now || slot.expiresAt<=now) return null
  for(const row of eligibleScheduledCandidates({candidates,kind:slot.kind,language:settings.language,history,now})) {
    const {story,episode}=row
    const message=buildPromotionMessage({story,episode,kind:slot.kind,language:settings.language,authorName:row.authorName,links:settings.links})
    const id=await queue.enqueue({language:settings.language,kind:slot.kind,storyId:story.id,episodeId:episode.id,authorId:story.author_id,slotKey:slot.slotKey,message,dueAt:slot.dueAt,expiresAt:slot.expiresAt})
    if(id) return id
  }
  return null
}
