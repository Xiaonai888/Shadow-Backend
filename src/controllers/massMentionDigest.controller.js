import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cleanId(value) {
  const id = String(value || '').trim().toLowerCase()
  return UUID.test(id) ? id : ''
}

export async function getMyMassMentionDigest(req, res) {
  const readerId = cleanId(req.user?.user_id || req.user?.id)
  const digestId = cleanId(req.params?.digestId)
  if (!readerId) return res.status(401).json({ ok: false, message: 'Sign in required' })
  if (!digestId) return res.status(400).json({ ok: false, message: 'Invalid digest ID' })

  res.set('Cache-Control', 'private, no-store')
  try {
    const { data: digest, error: digestError } = await supabase
      .from('mass_mention_digests')
      .select('id,sender_user_id,recipient_user_id,item_count,first_at,last_at')
      .eq('id', digestId)
      .eq('recipient_user_id', readerId)
      .maybeSingle()
    if (digestError) throw digestError
    if (!digest) return res.status(404).json({ ok: false, message: 'Digest not found' })

    const end = new Date(new Date(digest.first_at).getTime() + 86400000).toISOString()
    const { data: receipts, error: receiptsError } = await supabase
      .from('mass_mention_receipts')
      .select('job_id,source_kind,source_id,created_at')
      .eq('sender_user_id', digest.sender_user_id)
      .eq('recipient_user_id', readerId)
      .gte('created_at', digest.first_at)
      .lt('created_at', end)
      .order('created_at', { ascending: false })
      .limit(50)
    if (receiptsError) throw receiptsError

    const jobIds = [...new Set((receipts || []).map((row) => cleanId(row.job_id)).filter(Boolean))]
    if (!jobIds.length) return res.status(200).json({ ok: true, digest, items: [] })
    const { data: jobs, error: jobsError } = await supabase
      .from('mass_mention_jobs')
      .select('id,sender_user_id,source_kind,source_id,post_id,tag')
      .in('id', jobIds)
      .eq('sender_user_id', digest.sender_user_id)
    if (jobsError) throw jobsError
    const byJob = new Map((jobs || []).map((job) => [String(job.id), job]))
    const readerPosts = [...new Set((jobs || []).filter((job) => job.source_kind === 'reader_post_comment').map((job) => job.post_id))]
    const authorPosts = [...new Set((jobs || []).filter((job) => job.source_kind === 'author_post_comment').map((job) => job.post_id))]
    const allowedReaderPosts = new Set()
    const allowedAuthorPosts = new Set()

    if (readerPosts.length) {
      const { data, error } = await supabase.from('reader_posts')
        .select('id')
        .in('id', readerPosts)
        .eq('visibility', 'public')
        .is('deleted_at', null)
        .or(`publish_at.is.null,publish_at.lte.${new Date().toISOString()}`)
      if (error) throw error
      for (const item of data || []) allowedReaderPosts.add(String(item.id))
    }
    if (authorPosts.length) {
      const { data, error } = await supabase.from('author_page_posts')
        .select('id')
        .in('id', authorPosts)
        .eq('status', 'active')
      if (error) throw error
      for (const item of data || []) allowedAuthorPosts.add(String(item.id))
    }

    const items = (receipts || []).flatMap((receipt) => {
      const job = byJob.get(String(receipt.job_id))
      if (!job || String(job.source_id) !== String(receipt.source_id) || job.source_kind !== receipt.source_kind) return []
      if (job.source_kind === 'reader_post_comment' && allowedReaderPosts.has(String(job.post_id))) {
        return [{ tag: job.tag, commentId: job.source_id, postId: job.post_id, link: `/reader/post/${job.post_id}`, createdAt: receipt.created_at }]
      }
      if (job.source_kind === 'author_post_comment' && allowedAuthorPosts.has(String(job.post_id))) {
        return [{ tag: job.tag, commentId: job.source_id, postId: job.post_id, link: `/author/page?post=${job.post_id}`, createdAt: receipt.created_at }]
      }
      return []
    })
    return res.status(200).json({
      ok: true,
      digest: { id: digest.id, senderUserId: digest.sender_user_id, count: digest.item_count, firstAt: digest.first_at, lastAt: digest.last_at },
      items,
    })
  } catch (error) {
    console.error('MASS_MENTION_DIGEST_ERROR', String(error?.message || error).slice(0, 200))
    return res.status(500).json({ ok: false, message: 'Unable to load mentions' })
  }
}
