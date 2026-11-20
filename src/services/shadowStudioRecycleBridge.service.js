const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTIONS = new Set(['archive', 'unarchive', 'trash', 'restore', 'purge'])

export async function executeStudioRecycleAction({
  ownerId,
  videoId,
  action,
  client,
  invalidate,
}) {
  if (!UUID.test(String(ownerId || '')) || !UUID.test(String(videoId || ''))) {
    const error = new Error('Invalid Studio owner or video ID')
    error.status = 400
    throw error
  }
  if (!ACTIONS.has(action)) {
    const error = new Error('Invalid Studio recycle action')
    error.status = 400
    throw error
  }
  if (typeof client?.rpc !== 'function') {
    throw new TypeError('Studio recycle database client is unavailable')
  }

  const { data, error } = await client.rpc('shadow_studio_recycle_video', {
    p_owner: ownerId,
    p_video: videoId,
    p_action: action,
  })
  if (error) throw error
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    throw new Error('Invalid Studio recycle response')
  }
  if (data.ok) {
    const { data: saved, error: verifyError } = await client.from('fast_videos')
      .select('id,studio_state,status,deleted_at')
      .eq('id', videoId)
      .eq('user_id', ownerId)
      .maybeSingle()
    if (verifyError) throw verifyError
    const verified = action === 'purge' ? !saved
      : action === 'trash' ? saved?.studio_state === 'trashed' && saved?.status === 'draft' && Boolean(saved?.deleted_at)
      : action === 'archive' ? saved?.studio_state === 'archived' && saved?.status === 'draft'
      : action === 'unarchive' ? saved?.studio_state === 'active'
      : action === 'restore' ? saved?.studio_state === 'active' || saved?.studio_state === 'archived'
      : false
    if (!verified) {
      const failure = new Error('Reel state was not saved; please retry.')
      failure.status = 409
      throw failure
    }
  }
  if (data.ok && typeof invalidate === 'function') {
    try {
      await invalidate(ownerId)
    } catch (error) {
      console.warn('STUDIO_RECYCLE_CACHE_INVALIDATION_FAILED', error?.message || 'unknown')
    }
  }
  return data
}
