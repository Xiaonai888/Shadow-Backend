export async function hydrateAuthorEchoPosts(posts, supabase) {
  const rows = Array.isArray(posts) ? posts : []
  const storyIds = [...new Set(rows.filter((post) => post?.echo_source_type === 'story' && post?.echo_source_id).map((post) => String(post.echo_source_id)))]
  if (!storyIds.length) return rows

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
    if (post?.echo_source_type !== 'story' || !post.echo_source_id) return post
    const story = storyById.get(String(post.echo_source_id))
    if (!story) return { ...post, echo_source: null, echo_unavailable: true }
    const owner = pageById.get(String(story.author_id)) || null
    const imageUrl = story.landscape_thumbnail_url || story.cover_url || ''
    return {
      ...post,
      echo_unavailable: false,
      echo_source: {
        type: 'story',
        id: String(story.id),
        name: story.title || 'Story',
        content: '',
        image_url: imageUrl,
        image_urls: imageUrl ? [imageUrl] : [],
        label: 'story',
        url: `/story/${encodeURIComponent(story.id)}`,
        owner,
        story: {
          id: story.id,
          title: story.title || '',
          cover_url: story.cover_url || '',
          landscape_thumbnail_url: story.landscape_thumbnail_url || '',
          main_genre: story.main_genre || '',
        },
      },
    }
  })
}
