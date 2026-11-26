const DAY=86400000
const OFFSET=7*3600000
const HOUR=3600000
export const RECOVERY_HOURS=Object.freeze([7,11,18])
function midnight(now) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid recovery time')
  return Math.floor((now+OFFSET)/DAY)*DAY-OFFSET
}
export function latestRecoveryCheckpoint(now=Date.now()) {
  const base=midnight(now)
  return [...RECOVERY_HOURS].reverse().map(h=>base+h*HOUR).find(t=>t<=now) ?? base-DAY+18*HOUR
}
export function nextRecoveryCheckpoint(now=Date.now()) {
  const base=midnight(now)
  return RECOVERY_HOURS.map(h=>base+h*HOUR).find(t=>t>now) ?? base+DAY+7*HOUR
}
export function recoveryCheckpointDue(completedThrough,enabledAt,now=Date.now()) {
  const enabled=Date.parse(enabledAt ?? '')
  const completed=Date.parse(completedThrough ?? '')
  if(!Number.isFinite(enabled)||enabled>now)return false
  if(!Number.isFinite(completed)||completed<enabled)return true
  return latestRecoveryCheckpoint(now)>completed
}
export function optionalRecoveryExpiry(dueAt) {
  if(!Number.isFinite(dueAt))throw new TypeError('Invalid slot time')
  return nextRecoveryCheckpoint(dueAt)+3*HOUR
}
export function recoverablePromotionSlots(schedule,now=Date.now(),enabledAt=null) {
  const base=midnight(now)
  const enabled=enabledAt===null ? -Infinity : Date.parse(enabledAt)
  if(!Number.isFinite(enabled)&&enabled!==-Infinity)return []
  const seen=new Set(),out=[]
  for(const date of [base-DAY,base]) {
    const local=new Date(date+OFFSET)
    for(const slot of Array.isArray(schedule)?schedule:[]) {
      if(slot?.day!==local.getUTCDay()||!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)||!['completed','short','trending','author'].includes(slot.kind))continue
      const [h,m]=slot.time.split(':').map(Number)
      const dueAt=date+h*HOUR+m*60000
      const expiresAt=optionalRecoveryExpiry(dueAt)
      const slotKey=`${local.toISOString().slice(0,10)}T${slot.time}`
      if(seen.has(slotKey)||dueAt<enabled||dueAt>now||expiresAt<=now)continue
      seen.add(slotKey)
      out.push({kind:slot.kind,slotKey,dueAt,expiresAt})
    }
  }
  return out.sort((a,b)=>a.dueAt-b.dueAt)
}
