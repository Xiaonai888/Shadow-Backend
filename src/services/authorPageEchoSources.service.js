export async function hydrateAuthorEchoPosts(posts, supabase) {
  const rows = Array.isArray(posts) ? posts : []
  const storyEchoIds = rows.filter((post) => post?.echo_source_type === 'story' && post?.echo_source_id).map((post) => String(post.echo_source_id))
  const episodeIds = [...new Set(rows.filter((post) => post?.echo_source_type === 'episode' && post?.echo_source_id).map((post) => String(post.echo_source_id)))]
  if (!storyEchoIds.length && !episodeIds.length) return rows

  let episodes = []
  if (episodeIds.length) {
    const { data, error } = await supabase
      .from('episodes')
      .select('id, story_id, title, episode_number, cover_url')
      .in('id', episodeIds)
      .eq('status', 'published')
      .is('deleted_at', null)
    if (error) throw error
    episodes = data || []
  }

  const episodeById = new Map(episodes.map((episode) => [String(episode.id), episode]))
  const storyIds = [...new Set([...storyEchoIds, ...episodes.map((episode) => episode.story_id).filter(Boolean).map(String)])]
  const { data: stories, error: storiesError } = await supabase
    .from('stories')
    .select('id, author_id, title, cover_url, landscape_thumbnail_url, main_genre')
    .in('id', storyIds)
    .eq('status', 'published')
    .is('deleted_at', null)

  if (storiesError) throw storiesError

  const pageIds = [...new Set((stories || []).map((story) => story.author_id).filter(Boolean))]
  let pages = []
  if (pageIds.length) {
    const { data, error } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, avatar_url')
      .in('id', pageIds)
    if (error) throw error
    pages = data || []
  }

  const pageById = new Map(pages.map((page) => [String(page.id), page]))
  const storyById = new Map((stories || []).map((story) => [String(story.id), story]))

  return rows.map((post) => {
    const sourceType = post?.echo_source_type
    if (!['story', 'episode'].includes(sourceType) || !post.echo_source_id) return post
    const episode = sourceType === 'episode' ? episodeById.get(String(post.echo_source_id)) : null
    const story = sourceType === 'episode'
      ? episode && storyById.get(String(episode.story_id))
      : storyById.get(String(post.echo_source_id))
    if (!story || (sourceType === 'episode' && !episode)) {
      return { ...post, echo_source: null, echo_unavailable: true }
    }

    const owner = pageById.get(String(story.author_id)) || null
    const imageUrl = story.landscape_thumbnail_url || story.cover_url || episode?.cover_url || ''
    const episodeTitle = episode?.title || (episode ? `Episode ${Number(episode.episode_number || 0)}` : '')
    const url = episode
      ? `/story/${encodeURIComponent(story.id)}/episode/${encodeURIComponent(episode.id)}`
      : `/story/${encodeURIComponent(story.id)}`

    return {
      ...post,
      echo_unavailable: false,
      echo_source: {
        type: sourceType,
        id: String(episode?.id || story.id),
        name: story.title || 'Story',
        content: episodeTitle,
        image_url: imageUrl,
        image_urls: imageUrl ? [imageUrl] : [],
        label: sourceType,
        url,
        owner,
        story: {
          id: story.id,
          title: story.title || '',
          cover_url: story.cover_url || '',
          landscape_thumbnail_url: story.landscape_thumbnail_url || '',
          main_genre: story.main_genre || '',
        },
        ...(episode ? {
          episode: {
            id: episode.id,
            story_id: episode.story_id,
            title: episodeTitle,
            episode_number: Number(episode.episode_number || 0),
            cover_url: episode.cover_url || '',
          },
        } : {}),
      },
    }
  })
}
