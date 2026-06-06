import { supabase } from '../config/supabase.js'

function normalizePageUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function publicAuthorPost(post) {
  if (!post) return null

  return {
    id: post.id,
    author_page_id: post.author_page_id,
    user_id: post.user_id,
    post_type: post.post_type || 'article',
    content: post.content || '',
    status: post.status || 'active',
    like_count: Number(post.like_count || 0),
    comment_count: Number(post.comment_count || 0),
    echo_count: Number(post.echo_count || 0),
    created_at: post.created_at,
    updated_at: post.updated_at,
  }
}

export async function getAuthorPagePosts(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const limit = Math.min(30, Math.max(1, Number(req.query.limit || 20)))

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data: posts, error: postsError } = await supabase
      .from('author_page_posts')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (postsError) throw postsError

    return res.status(200).json({
      ok: true,
      posts: (posts || []).map(publicAuthorPost),
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE POSTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load author posts', error: error.message })
  }
}

export async function createMyAuthorPost(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const content = String(req.body.content || '').trim()
    const postType = String(req.body.post_type || req.body.postType || 'article').trim().toLowerCase()
    const allowedTypes = new Set(['article', 'announcement', 'update'])

    if (!content) {
      return res.status(400).json({ ok: false, message: 'Post content is required' })
    }

    if (content.length > 5000) {
      return res.status(400).json({ ok: false, message: 'Post content is too long' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data: createdPost, error: createError } = await supabase
      .from('author_page_posts')
      .insert({
        author_page_id: authorPage.id,
        user_id: userId,
        post_type: allowedTypes.has(postType) ? postType : 'article',
        content,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (createError) throw createError

    return res.status(201).json({
      ok: true,
      message: 'Post created',
      post: publicAuthorPost(createdPost),
    })
  } catch (error) {
    console.error('CREATE MY AUTHOR POST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create author post', error: error.message })
  }
}
