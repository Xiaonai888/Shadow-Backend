const safe=e=>String(e?.message||e||'Unknown').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)
export function createPromotionUpdatePreparerV2({source,updateQueue,messageBuilder,onError=()=>{}}){
  if(!source?.dueEvents||!source?.load||!source?.finishEvent||!updateQueue?.enqueue||!messageBuilder?.build)throw new TypeError('Missing V2 update dependencies')
  return async function prepare({settings,now=Date.now()}){
    const counts={queued:0,skipped:0,retry:0}
    if(!settings?.enabled||!['km','en'].includes(settings.language))return counts
    for(const event of await source.dueEvents(settings.language,now)){
      try{
        const args={language:settings.language,episodeId:event.episode_id}
        let outcome=await updateQueue.enqueue(args)
        if(outcome.state==='needs_payload'){
          const {story,episode}=await source.load(event.story_id,event.episode_id)
          if(!story||!episode)throw new Error('Missing update source')
          const message=await messageBuilder.build({story,episode,language:settings.language,postType:'update',authorName:await source.authorName(story.author_id),links:settings.links})
          if(!message){await source.finishEvent(event,'skipped','SAFE_PREVIEW_UNAVAILABLE',now);counts.skipped++;continue}
          outcome=await updateQueue.enqueue({...args,message})
        }
        if(['queued','existing','legacy_existing'].includes(outcome.state)){counts.queued++;continue}
        if(outcome.state==='legacy_day'){
          await source.finishEvent(event,'skipped','V2_LEGACY_DAY',now);counts.skipped++;continue
        }
        if(outcome.state==='ineligible'||outcome.state==='missing_event'){
          await source.finishEvent(event,'skipped',outcome.state,now);counts.skipped++;continue
        }
        if(outcome.state==='disabled'||outcome.state==='not_due')continue
        throw new Error(`Unexpected update state: ${outcome.state}`)
      }catch(error){
        await source.finishEvent(event,'pending',safe(error),now);counts.retry++
        try{onError({code:'TELEGRAM_PROMOTION_V2_PREPARE_FAILED',episode_id:event.episode_id,language:settings.language,message:safe(error)})}catch{}
      }
    }
    return counts
  }
}
