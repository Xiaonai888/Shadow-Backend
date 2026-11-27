import { shadowAiError } from './shadowAiPolicy.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const denied = () => shadowAiError('SHADOW_AI_SESSION_DENIED','Booking session is unavailable',403)
const unavailable = () => shadowAiError('SHADOW_AI_ACCESS_UNAVAILABLE','Booking access is temporarily unavailable',503)
export function shadowAiId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw shadowAiError('SHADOW_AI_SESSION_INVALID','Invalid booking ID',400)
  return value.toLowerCase()
}
export function selectShadowAiReaderAuthor({ conversation, participants, author, actorUserId, blocks }) {
  const actor = shadowAiId(actorUserId)
  if (conversation?.conversation_type !== 'reader_author' || conversation.is_group !== false || !['accepted','pending'].includes(conversation.request_status) || !author || author.status !== 'active' || author.id !== conversation.author_page_id || author.user_id === actor || !Array.isArray(participants) || participants.length !== 2 || !Array.isArray(blocks) || blocks.length) throw denied()
  if (!participants.some(p=>p.user_id===actor && p.participant_role==='reader' && p.deleted_at===null) || !participants.some(p=>p.user_id===author.user_id && p.participant_role==='author' && p.deleted_at===null)) throw denied()
  return shadowAiId(author.id)
}
async function read(query) {
  const {data,error} = await query.abortSignal(AbortSignal.timeout(5000))
  if (error) throw unavailable()
  return data
}
export function createShadowAiPreOrderAccess({db}) {
  async function resolve({actorUserId,conversationId}) {
    const actor=shadowAiId(actorUserId), chat=shadowAiId(conversationId)
    const [conversation,participants]=await Promise.all([
      read(db.from('chat_conversations').select('id,conversation_type,is_group,request_status,author_page_id').eq('id',chat).maybeSingle()),
      read(db.from('chat_participants').select('user_id,participant_role,deleted_at').eq('conversation_id',chat).limit(3)),
    ])
    if (conversation?.conversation_type!=='reader_author' || conversation.is_group!==false || !['accepted','pending'].includes(conversation.request_status) || !conversation.author_page_id || !participants?.some(p=>p.user_id===actor && p.participant_role==='reader' && p.deleted_at===null)) throw denied()
    const author=await read(db.from('author_pages').select('id,user_id,status').eq('id',shadowAiId(conversation.author_page_id)).maybeSingle())
    const authorId=selectShadowAiReaderAuthor({conversation,participants,author,actorUserId:actor,blocks:[]})
    const other=shadowAiId(author.user_id)
    const blocks=await read(db.from('chat_blocks').select('id').or(`and(blocker_user_id.eq.${actor},blocked_user_id.eq.${other}),and(blocker_user_id.eq.${other},blocked_user_id.eq.${actor})`).limit(1))
    return selectShadowAiReaderAuthor({conversation,participants,author,actorUserId:actor,blocks})
  }
  return {resolve,async authorize(scope) { return await resolve(scope)===scope.authorPageId }}
}
