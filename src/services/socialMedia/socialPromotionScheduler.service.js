const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const terminal=new Set(['queued','existing','invalid','disabled','stale_rule','invalid_slot','daily_limit','ineligible','duplicate','duplicate_caption','empty'])
const grace=15*60000
export function createSocialPromotionScheduler({db,integration,enabled,clock=Date.now,onError=()=>{}}={}){
  if(!db?.rpc||!integration?.plan||!integration?.runWorker||typeof enabled!=='function'||typeof clock!=='function'||typeof onError!=='function')throw new TypeError('SOCIAL_SCHEDULER_DEPENDENCIES')
  let running=false,timer=null,started=false
  const attempted=new Map()
  const report=stage=>{try{onError({code:`SOCIAL_SCHEDULER_${stage}_FAILED`})}catch{}}
  async function tick(){
    if(!enabled())return {state:'disabled'}
    if(running)return {state:'busy'}
    running=true
    try{
      const now=clock()
      if(!Number.isFinite(now))throw new Error('SOCIAL_SCHEDULER_CLOCK_INVALID')
      for(const [key,item] of attempted)if(item.expires<now)attempted.delete(key)
      const {data,error}=await db.rpc('social_promotion_poll_v5',{p_skip:[...attempted.values()].map(({ruleId,slot})=>({ruleId,slot}))})
      if(error||!Array.isArray(data?.due)||data.due.length>12||typeof data.hasWork!=='boolean')throw new Error('SOCIAL_SCHEDULER_POLL_FAILED')
      let planned=0,queued=false
      for(const item of data.due){
        if(planned>=3||!enabled())break
        const r=item?.rule,stamp=Date.parse(item?.slot)
        if(!uuid.test(r?.id||'')||r.owner_type!=='admin'||r.owner_id!=='shadow'||r.enabled!==true||!Number.isFinite(stamp)||stamp%60000!==0||stamp>now||now-stamp>grace)continue
        const slot=new Date(stamp).toISOString(),key=`${r.id}:${slot}`
        if(attempted.has(key))continue
        planned++
        try{
          const result=await integration.plan({rule:r,slot})
          if(!terminal.has(result?.state))throw new Error('SOCIAL_SCHEDULER_PLAN_RESPONSE')
          if(attempted.size>=200)attempted.delete(attempted.keys().next().value)
          attempted.set(key,{ruleId:r.id,slot,expires:stamp+grace})
          if(result.state==='queued'||result.state==='existing')queued=true
        }catch{report('PLAN')}
      }
      let worker=null
      if(enabled()&&(queued||data.hasWork)){
        try{worker=await integration.runWorker()}catch{report('WORKER')}
      }
      return {state:'ok',planned,worker}
    }catch{report('POLL');return {state:'failed'}}finally{running=false}
  }
  function schedule(){
    if(!started)return
    timer=setTimeout(async()=>{try{await tick()}finally{schedule()}},60000)
    timer.unref?.()
  }
  return {tick,start(){if(started||!enabled())return false;started=true;schedule();return true},stop(){started=false;clearTimeout(timer);timer=null;attempted.clear()}}
}
