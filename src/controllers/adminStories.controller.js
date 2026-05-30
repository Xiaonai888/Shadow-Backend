export async function issueStoryWarning(req, res) {
  try {
    const { storyId } = req.params
    const reason = cleanText(req.body.reason)
    const note = cleanText(req.body.admin_note || req.body.note)
    const actor = adminActor(req)

    if (reason.length < 5) {
      return res.status(400).json({ ok: false, message: 'Warning reason is required' })
    }

    const { data: oldStory, error: oldStoryError } = await supabase
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .maybeSingle()

    if (oldStoryError) throw oldStoryError
    if (!oldStory) return res.status(404).json({ ok: false, message: 'Story not found' })

    const warningCount = Number(oldStory.policy_warning_count || 0) + 1
    const now = new Date().toISOString()
    const shouldAutoRestrict = warningCount >= 3 && oldStory.admin_visibility_status !== 'restricted'

    const updatePayload = {
      policy_warning_count: warningCount,
      last_policy_warning_at: now,
      admin_note: note || oldStory.admin_note || '',
      updated_at: now,
    }

    if (shouldAutoRestrict) {
      updatePayload.admin_visibility_status = 'restricted'
      updatePayload.admin_restriction_reason = 'Auto restricted after 3 policy warnings'
      updatePayload.admin_restricted_at = now
      updatePayload.admin_restricted_by = actor
    }

    const { data: story, error: updateError } = await supabase
      .from('stories')
      .update(updatePayload)
      .eq('id', storyId)
      .select()
      .single()

    if (updateError) throw updateError

    await supabase.from('story_moderation_logs').insert({
      story_id: storyId,
      author_id: story.author_id,
      action: 'warning_issued',
      reason,
      admin_actor: actor,
    })

    if (shouldAutoRestrict) {
      await supabase.from('story_moderation_logs').insert({
        story_id: storyId,
        author_id: story.author_id,
        action: 'story_auto_restricted',
        reason: 'Auto restricted after 3 policy warnings',
        admin_actor: actor,
      })
    }

    const authors = await fetchAuthors([story.author_id])

    return res.status(200).json({
      ok: true,
      message: shouldAutoRestrict ? 'Warning issued and story auto restricted' : 'Warning issued',
      story: publicStory(story, authors.get(story.author_id)),
    })
  } catch (error) {
    console.error('ISSUE STORY WARNING ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to issue warning', error: error.message })
  }
}
