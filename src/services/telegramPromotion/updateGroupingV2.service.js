const HOUR=3600000
const DAY=86400000
export const UPDATE_GROUP_POLICY=Object.freeze({windowMs:HOUR,maxPostsPerDay:3})
export function promotionLocalDay(ms){
  if(!Number.isFinite(ms))throw new TypeError('Invalid publication timestamp')
  return new Date(ms+7*HOUR).toISOString().slice(0,10)
}
export function planDailyStoryUpdates({events,language,storyId,day,now=Date.now()}){
  if(!Array.isArray(events)||!language||!storyId||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(now))throw new TypeError('Invalid update grouping input')
  const start=Date.parse(`${day}T00:00:00+07:00`)
  if(!Number.isFinite(start)||promotionLocalDay(start)!==day)throw new TypeError('Invalid local day')
  const dedup=new Map()
  for(const event of events){
    if(event?.language!==language||String(event?.story_id)!==String(storyId)||!event?.episode_id)continue
    const at=Date.parse(event.first_published_at)
    if(!Number.isFinite(at)||at<start||at>=start+DAY||at>now)continue
    const id=String(event.episode_id)
    const existing=dedup.get(id)
    if(!existing||at<existing.at)dedup.set(id,{id,at})
  }
  const sorted=[...dedup.values()].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))
  const groups=[]
  for(const [i,event] of sorted.entries()){
    let group=groups.at(-1)
    if(!group||(groups.length<UPDATE_GROUP_POLICY.maxPostsPerDay&&event.at-group.firstPublishedAt>=UPDATE_GROUP_POLICY.windowMs)){
      group={key:`${language}:${storyId}:${day}:${groups.length+1}`,firstEpisodeId:event.id,firstPublishedAt:event.at,episodeIds:[],upCount:0,totalToday:0}
      groups.push(group)
    }
    group.episodeIds.push(event.id)
    group.totalToday=i+1
    group.upCount=i
  }
  return {day,storyId,language,totalToday:sorted.length,groups}
}
