import { normalizePromotionLanguage, evaluatePromotion } from './policy.service.js'
import { buildPromotionMessage } from './message.service.js'

const STORY_FIELDS = 'id,title,story_language,story_type,story_status,status,deleted_at,admin_visibility_status,is_adult,is_shadow_exclusive,exclusive_status,author_id,cover_url'
const EPISODE_FIELDS = 'id,story_id,title,episode_number,status,deleted_at,is_adult,first_published_at,published_at,scheduled_at,content'
const PAGE = 100
const MAX_EVENTS = 10
const sanitize = value => String(value || 'UNKNOWN').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)
function result(response) {
  if (response.error) throw new Error(`Telegram source database: ${sanitize(response.error.message)}`)
  return response.data
}
function lang(value) {
  const language = normalizePromotionLanguage(value)
  if (!language) throw new TypeError('Invalid promotion language')
  return language
}
export function createPromotionStorySource(db) {
  if (!db?.from || !db?.rpc) throw new TypeError('Missing Supabase client')
  return {
    async load(storyId, episodeId) {
      const [story,episode] = await Promise.all([
        db.from('stories').select(STORY_FIELDS).eq('id',storyId).maybeSingle(),
        db.from('episodes').select(EPISODE_FIELDS).eq('id',episodeId).eq('story_id',storyId).maybeSingle(),
      ]).then(rows=>rows.map(result))
      return { story,episode }
    },
    async authorName(authorId) {
      if (!authorId) return ''
      const row=result(await db.from('author_pages').select('page_name,page_username').eq('id',authorId).maybeSingle())
      return row?.page_name || row?.page_username || ''
    },
    async dueEvents(language,now=Date.now()) {
      return result(await db.from('telegram_promotion_events').select('language,episode_id,story_id,first_published_at,due_at,attempts').eq('language',lang(language)).eq('state','pending').lte('due_at',new Date(now).toISOString()).order('first_published_at').order('episode_id').limit(MAX_EVENTS)) || []
    },
    async finishEvent(event,state,error=null,now=Date.now()) {
      if (!['queued','skipped','pending'].includes(state)) throw new TypeError('Invalid event state')
      const attempts=Number(event.attempts || 0)+1
      const patch={state,attempts,last_error:error?sanitize(error):null,updated_at:new Date(now).toISOString()}
      if (state==='pending') patch.due_at=new Date(now+Math.min(3600000,60000*2**Math.min(6,attempts-1))).toISOString()
      return result(await db.from('telegram_promotion_events').update(patch).eq('language',event.language).eq('episode_id',event.episode_id).eq('state','pending').eq('attempts',event.attempts).select('episode_id').maybeSingle())
    },
    async reconcilePage({language,from,to,after=null}) {
      const response=result(await db.rpc('telegram_promotion_reconcile_v1',{p_language:lang(language),p_from:new Date(from).toISOString(),p_to:new Date(to).toISOString(),p_after_at:after?.first_published_at ?? null,p_after_id:after?.episode_id ?? null,p_limit:PAGE}))
      const rows=response?.rows || []
      return {added:Number(response?.added || 0),next:rows.length===PAGE?rows.at(-1):null}
    },
  }
}
export async function prepareUpdateEvents({source,queue,settings,now=Date.now(),onError=()=>{}}) {
  if (!settings?.enabled) return {queued:0,skipped:0,retry:0}
  const counts={queued:0,skipped:0,retry:0}
  for (const event of await source.dueEvents(settings.language,now)) {
    try {
      const {story,episode}=await source.load(event.story_id,event.episode_id)
      const decision=evaluatePromotion({story,episode,kind:'update',language:settings.language,now})
      if (!decision.eligible) {
        const temporary=['not_published','not_yet_published','language_mismatch'].includes(decision.reason)
        await source.finishEvent(event,temporary?'pending':'skipped',decision.reason,now)
        counts[temporary?'retry':'skipped']++
        continue
      }
      const message=buildPromotionMessage({story,episode,kind:'update',language:settings.language,authorName:await source.authorName(story.author_id),links:settings.links})
      const id=await queue.enqueue({language:settings.language,kind:'update',storyId:story.id,episodeId:episode.id,authorId:story.author_id,message,dueAt:now})
      if (!id) throw new Error('Queue unavailable or disabled')
      await source.finishEvent(event,'queued',null,now)
      counts.queued++
    } catch (error) {
      await source.finishEvent(event,'pending',error.message,now)
      counts.retry++
      onError({code:'TELEGRAM_PROMOTION_PREPARE_FAILED',episode_id:event.episode_id,message:sanitize(error.message)})
    }
  }
  return counts
}
