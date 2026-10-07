import { supabase } from '../config/supabase.js'
import { AUTHOR_AGREEMENT_VERSION } from '../controllers/storyPublishAgreement.controller.js'

export async function enforceFirstPublishAgreement(req, res, next) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const status = String(req.body?.status || '').trim().toLowerCase()

    if (!userId || !['published', 'scheduled'].includes(status)) {
      return next()
    }

    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .select('episode_number, published_at')
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (episodeError) throw episodeError

    if (!episode || Number(episode.episode_number || 0) !== 1 || episode.published_at) {
      return next()
    }

    const { data: agreement, error: agreementError } = await supabase
      .from('story_publish_agreements')
      .select('original_work_confirmed, author_agreement_accepted')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .eq('agreement_version', AUTHOR_AGREEMENT_VERSION)
      .maybeSingle()

    if (agreementError) throw agreementError

    if (
      agreement?.original_work_confirmed &&
      agreement?.author_agreement_accepted
    ) {
      return next()
    }

    return res.status(409).json({
      ok: false,
      code: 'PUBLISH_AGREEMENT_REQUIRED',
      message: 'Publishing agreement is required before the first episode can be published.',
    })
  } catch (error) {
    console.error('FIRST PUBLISH AGREEMENT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to verify publishing agreement',
      error: error.message,
    })
  }
}
