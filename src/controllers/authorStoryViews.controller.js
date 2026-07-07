import { supabase } from '../config/supabase.js'

export async function recordAuthorStoryView(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()
    const now = new Date().toISOString()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story ID is required',
      })
    }

    const { data: story, error: storyError } = await supabase
      .from('author_page_stories')
      .select('id, author_page_id, status, expires_at, view_count')
      .eq('id', storyId)
      .eq('status', 'active')
      .gt('expires_at', now)
      .maybeSingle()

    if (storyError) throw storyError

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found or expired',
      })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id')
      .eq('id', story.author_page_id)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    if (String(authorPage.user_id) === String(userId)) {
      return res.status(200).json({
        ok: true,
        counted: false,
        has_viewed: true,
        view_count: Number(story.view_count || 0),
      })
    }

    const { data: existingView, error: existingViewError } = await supabase
      .from('author_page_story_views')
      .select('id')
      .eq('story_id', story.id)
      .eq('viewer_user_id', userId)
      .maybeSingle()

    if (existingViewError) throw existingViewError

    let counted = false

    if (!existingView) {
      const { error: insertError } = await supabase
        .from('author_page_story_views')
        .insert({
          story_id: story.id,
          viewer_user_id: userId,
          viewed_at: now,
        })

      if (insertError && insertError.code !== '23505') throw insertError

      counted = !insertError
    }

    const { data: updatedStory, error: updatedStoryError } = await supabase
      .from('author_page_stories')
      .select('view_count')
      .eq('id', story.id)
      .single()

    if (updatedStoryError) throw updatedStoryError

    return res.status(200).json({
      ok: true,
      counted,
      has_viewed: true,
      view_count: Number(updatedStory.view_count || 0),
    })
  } catch (error) {
    console.error('RECORD AUTHOR STORY VIEW ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to record story view',
      error: error.message,
    })
  }
}
