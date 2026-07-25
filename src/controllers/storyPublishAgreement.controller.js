import { supabase } from '../config/supabase.js'

export const AUTHOR_AGREEMENT_VERSION = '2026-07-25-v1'

async function getOwnedStory(storyId, userId) {
  const { data, error } = await supabase
    .from('stories')
    .select('id')
    .eq('id', storyId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getStoryPublishAgreement(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const story = await getOwnedStory(storyId, userId)

    if (!story) {
      return res.status(404).json({ ok: false, message: 'Story not found' })
    }

    const { data, error } = await supabase
      .from('story_publish_agreements')
      .select('original_work_confirmed, author_agreement_accepted, agreement_version, accepted_at')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .eq('agreement_version', AUTHOR_AGREEMENT_VERSION)
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      accepted: Boolean(
        data?.original_work_confirmed &&
        data?.author_agreement_accepted
      ),
      agreement_version: AUTHOR_AGREEMENT_VERSION,
      agreement: data || null,
    })
  } catch (error) {
    console.error('GET STORY PUBLISH AGREEMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load story publish agreement',
      error: error.message,
    })
  }
}

export async function acceptStoryPublishAgreement(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()
    const originalWorkConfirmed = req.body?.original_work_confirmed === true
    const authorAgreementAccepted = req.body?.author_agreement_accepted === true

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!originalWorkConfirmed || !authorAgreementAccepted) {
      return res.status(400).json({
        ok: false,
        message: 'Both confirmations are required',
      })
    }

    const story = await getOwnedStory(storyId, userId)

    if (!story) {
      return res.status(404).json({ ok: false, message: 'Story not found' })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('story_publish_agreements')
      .upsert(
        {
          story_id: storyId,
          user_id: userId,
          original_work_confirmed: true,
          author_agreement_accepted: true,
          agreement_version: AUTHOR_AGREEMENT_VERSION,
          accepted_at: now,
          updated_at: now,
        },
        {
          onConflict: 'story_id,agreement_version',
        }
      )
      .select('original_work_confirmed, author_agreement_accepted, agreement_version, accepted_at')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      accepted: true,
      agreement_version: AUTHOR_AGREEMENT_VERSION,
      agreement: data,
    })
  } catch (error) {
    console.error('ACCEPT STORY PUBLISH AGREEMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to save story publish agreement',
      error: error.message,
    })
  }
}
