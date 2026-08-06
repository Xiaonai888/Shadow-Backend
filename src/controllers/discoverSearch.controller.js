import { supabase } from '../config/supabase.js'
import {
  applyAdultStoryVisibility,
  getReaderAgeAccess,
} from '../services/storyAgeAccess.service.js'

const VALID_TYPES = new Set([
  'all',
  'readers',
  'pages',
  'stories',
  'pdfs',
  'posts',
])

const TYPE_ALIASES = {
  reader: 'readers',
  user: 'readers',
  users: 'readers',
  author: 'pages',
  authors: 'pages',
  page: 'pages',
  story: 'stories',
  book: 'pdfs',
  books: 'pdfs',
  pdf: 'pdfs',
  post: 'posts',
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 30
const ALL_SECTION_LIMIT = 8
const MAX_SCAN_LIMIT = 80

function cleanKeyword(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120)
}

function cleanFilterKeyword(value) {
  return cleanKeyword(value)
    .replace(/[^\p{L}\p{N}\s@#&+'\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeType(value) {
  const raw = String(value || 'all').trim().toLowerCase()
  const normalized = TYPE_ALIASES[raw] || raw
  return VALID_TYPES.has(normalized) ? normalized : 'all'
}

function getLimit(value) {
  const number = Number.parseInt(value, 10)

  if (!Number.isFinite(number)) return DEFAULT_LIMIT

  return Math.min(MAX_LIMIT, Math.max(1, number))
}

function getScanLimit(limit) {
  return Math.min(MAX_SCAN_LIMIT, Math.max(limit * 3, 24))
}

function makeIlikeFilter(columns, keyword) {
  const filterKeyword = cleanFilterKeyword(keyword)

  if (!filterKeyword) return ''

  return columns
    .map((column) => `${column}.ilike.*${filterKeyword}*`)
    .join(',')
}

function uniqueById(items) {
  const seen = new Set()
  const output = []

  for (const item of items || []) {
    const id = String(item?.id || '')

    if (!id || seen.has(id)) continue

    seen.add(id)
    output.push(item)
  }

  return output
}

function textScore(keyword, values) {
  const target = cleanKeyword(keyword).toLocaleLowerCase()

  if (!target) return 0

  let score = 0

  for (const value of values || []) {
    const text = String(value || '').trim().toLocaleLowerCase()

    if (!text) continue

    if (text === target) {
      score = Math.max(score, 100)
    } else if (text.startsWith(target)) {
      score = Math.max(score, 70)
    } else if (text.includes(target)) {
      score = Math.max(score, 40)
    }
  }

  return score
}

function sortBySearchScore(items, keyword, getValues, getPopularity) {
  return [...(items || [])].sort((left, right) => {
    const rightScore = textScore(keyword, getValues(right))
    const leftScore = textScore(keyword, getValues(left))

    if (rightScore !== leftScore) return rightScore - leftScore

    const rightPopularity = Number(getPopularity?.(right) || 0)
    const leftPopularity = Number(getPopularity?.(left) || 0)

    if (rightPopularity !== leftPopularity) {
      return rightPopularity - leftPopularity
    }

    const rightTime = new Date(
      right?.updated_at || right?.created_at || 0
    ).getTime()
    const leftTime = new Date(
      left?.updated_at || left?.created_at || 0
    ).getTime()

    return rightTime - leftTime
  })
}

async function resolveQuery(query) {
  const { data, error } = await query

  if (error) throw error

  return Array.isArray(data) ? data : []
}

function publicReader(user) {
  return {
    search_type: 'reader',
    id: user.id,
    name: user.name || 'Reader',
    username: user.username || '',
    avatar_url: user.avatar_url || null,
    bio: user.bio || '',
    work: user.work || '',
    location: user.location || '',
    is_author: Boolean(user.is_author),
    created_at: user.created_at,
    updated_at: user.updated_at,
  }
}

function publicPage(page) {
  return {
    search_type: 'page',
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name || 'Author',
    page_username: page.page_username || '',
    page_slug: page.page_slug || '',
    bio: page.bio || '',
    avatar_url: page.avatar_url || null,
    cover_url: page.cover_url || null,
    total_stories: Number(page.total_stories || 0),
    total_followers: Number(page.total_followers || 0),
    created_at: page.created_at,
    updated_at: page.updated_at,
  }
}

function publicStory(story, authorPage) {
  return {
    search_type: 'story',
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title || 'Untitled Story',
    story_type: story.story_type || 'novel',
    story_language: story.story_language || '',
    main_genre: story.main_genre || '',
    story_status: story.story_status || 'New',
    tags: Array.isArray(story.tags) ? story.tags : [],
    description: story.description || '',
    cover_url: story.cover_url || null,
    landscape_thumbnail_url: story.landscape_thumbnail_url || null,
    access_type: story.access_type || 'free',
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    author_page: authorPage ? publicPage(authorPage) : null,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicPdf(product, authorPage) {
  return {
    search_type: 'pdf',
    id: product.id,
    author_page_id: product.author_page_id,
    user_id: product.user_id,
    title: product.title || 'Untitled PDF',
    author_name: product.author_name || '',
    publisher: product.publisher || '',
    category: product.category || '',
    genre: product.genre || '',
    description: product.description || '',
    cover_url: product.cover_url || null,
    original_price: Number(product.original_price || 0),
    sale_price: Number(product.sale_price || 0),
    page_count: Number(product.page_count || 0),
    author_page: authorPage ? publicPage(authorPage) : null,
    created_at: product.created_at,
    updated_at: product.updated_at,
  }
}

function publicReaderPost(post, user) {
  return {
    search_type: 'post',
    post_source: 'reader',
    id: post.id,
    user_id: post.user_id,
    content: post.content || '',
    image_urls: Array.isArray(post.image_urls)
      ? post.image_urls.filter(Boolean).slice(0, 5)
      : [],
    like_count: Number(post.like_count || 0),
    comment_count: Number(post.comment_count || 0),
    echo_count: Number(post.echo_count || 0),
    owner: user ? publicReader(user) : null,
    publish_at: post.publish_at || post.created_at,
    created_at: post.created_at,
    updated_at: post.updated_at,
  }
}

function publicAuthorPost(post, authorPage) {
  return {
    search_type: 'post',
    post_source: 'author',
    id: post.id,
    author_page_id: post.author_page_id,
    user_id: post.user_id,
    post_type: post.post_type || 'article',
    content: post.content || '',
    image_urls: Array.isArray(post.image_urls)
      ? post.image_urls.filter(Boolean).slice(0, 5)
      : [],
    is_pinned: Boolean(post.is_pinned),
    like_count: Number(post.like_count || 0),
    comment_count: Number(post.comment_count || 0),
    echo_count: Number(post.echo_count || 0),
    owner: authorPage ? publicPage(authorPage) : null,
    publish_at: post.created_at,
    created_at: post.created_at,
    updated_at: post.updated_at,
  }
}

async function searchMatchingUsers(keyword, scanLimit) {
  const filter = makeIlikeFilter(
    ['name', 'username', 'bio', 'work', 'location'],
    keyword
  )

  if (!filter) return []

  const users = await resolveQuery(
    supabase
      .from('users')
      .select(
        'id, name, username, avatar_url, bio, work, location, is_author, is_active, created_at, updated_at'
      )
      .eq('is_active', true)
      .or(filter)
      .order('updated_at', { ascending: false })
      .limit(scanLimit)
  )

  return sortBySearchScore(
    users,
    keyword,
    (user) => [
      user.name,
      user.username,
      user.bio,
      user.work,
      user.location,
    ]
  )
}

async function searchMatchingPages(keyword, matchedUserIds, scanLimit) {
  const select =
    'id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, total_stories, total_followers, status, created_at, updated_at'
  const filter = makeIlikeFilter(
    ['page_name', 'page_username', 'page_slug', 'bio'],
    keyword
  )
  const requests = []

  if (filter) {
    requests.push(
      resolveQuery(
        supabase
          .from('author_pages')
          .select(select)
          .eq('status', 'active')
          .or(filter)
          .order('total_followers', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  if (matchedUserIds.length) {
    requests.push(
      resolveQuery(
        supabase
          .from('author_pages')
          .select(select)
          .eq('status', 'active')
          .in('user_id', matchedUserIds.slice(0, MAX_SCAN_LIMIT))
          .order('total_followers', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  const groups = requests.length
    ? await Promise.all(requests)
    : []
  const pages = uniqueById(groups.flat())

  return sortBySearchScore(
    pages,
    keyword,
    (page) => [
      page.page_name,
      page.page_username,
      page.page_slug,
      page.bio,
    ],
    (page) =>
      Number(page.total_followers || 0) +
      Number(page.total_stories || 0) * 10
  )
}

async function searchStories(
  keyword,
  matchedPages,
  limit,
  ageAccess
) {
  const scanLimit = getScanLimit(limit)
  const select =
    'id, author_id, user_id, title, story_type, story_language, main_genre, story_status, tags, description, is_adult, cover_url, landscape_thumbnail_url, status, access_type, total_episodes, total_views, total_likes, total_comments, created_at, updated_at'
  const filter = makeIlikeFilter(
    [
      'title',
      'description',
      'story_type',
      'story_language',
      'main_genre',
      'story_status',
      'access_type',
    ],
    keyword
  )

  function baseQuery() {
    let query = supabase
      .from('stories')
      .select(select)
      .eq('status', 'published')
      .is('deleted_at', null)

    query = applyAdultStoryVisibility(query, ageAccess)

    return query
  }

  const requests = []

  if (filter) {
    requests.push(
      resolveQuery(
        baseQuery()
          .or(filter)
          .order('total_views', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  const pageIds = matchedPages.map((page) => page.id).filter(Boolean)

  if (pageIds.length) {
    requests.push(
      resolveQuery(
        baseQuery()
          .in('author_id', pageIds.slice(0, MAX_SCAN_LIMIT))
          .order('total_views', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  if (keyword) {
    requests.push(
      resolveQuery(
        baseQuery()
          .contains('tags', [keyword])
          .order('total_views', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  const groups = requests.length
    ? await Promise.all(requests)
    : []
  const stories = uniqueById(groups.flat())
  const pageMap = new Map(
    matchedPages.map((page) => [String(page.id), page])
  )
  const missingPageIds = [
    ...new Set(
      stories
        .map((story) => String(story.author_id || ''))
        .filter((id) => id && !pageMap.has(id))
    ),
  ]

  if (missingPageIds.length) {
    const missingPages = await resolveQuery(
      supabase
        .from('author_pages')
        .select(
          'id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, total_stories, total_followers, status, created_at, updated_at'
        )
        .in('id', missingPageIds)
        .eq('status', 'active')
    )

    for (const page of missingPages) {
      pageMap.set(String(page.id), page)
    }
  }

  return sortBySearchScore(
    stories,
    keyword,
    (story) => [
      story.title,
      story.description,
      story.story_type,
      story.story_language,
      story.main_genre,
      story.story_status,
      ...(Array.isArray(story.tags) ? story.tags : []),
      pageMap.get(String(story.author_id))?.page_name,
      pageMap.get(String(story.author_id))?.page_username,
    ],
    (story) =>
      Number(story.total_views || 0) +
      Number(story.total_likes || 0) * 5
  )
    .slice(0, limit)
    .map((story) =>
      publicStory(
        story,
        pageMap.get(String(story.author_id)) || null
      )
    )
}

async function searchPdfs(keyword, matchedPages, limit) {
  const scanLimit = getScanLimit(limit)
  const select =
    'id, author_page_id, user_id, product_type, title, author_name, publisher, category, genre, description, cover_url, original_price, sale_price, status, page_count, created_at, updated_at'
  const filter = makeIlikeFilter(
    [
      'title',
      'author_name',
      'publisher',
      'category',
      'genre',
      'description',
    ],
    keyword
  )
  const requests = []

  if (filter) {
    requests.push(
      resolveQuery(
        supabase
          .from('author_store_products')
          .select(select)
          .eq('product_type', 'pdf')
          .eq('status', 'active')
          .or(filter)
          .order('updated_at', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  const pageIds = matchedPages.map((page) => page.id).filter(Boolean)

  if (pageIds.length) {
    requests.push(
      resolveQuery(
        supabase
          .from('author_store_products')
          .select(select)
          .eq('product_type', 'pdf')
          .eq('status', 'active')
          .in('author_page_id', pageIds.slice(0, MAX_SCAN_LIMIT))
          .order('updated_at', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  const groups = requests.length
    ? await Promise.all(requests)
    : []
  const products = uniqueById(groups.flat())
  const pageMap = new Map(
    matchedPages.map((page) => [String(page.id), page])
  )
  const missingPageIds = [
    ...new Set(
      products
        .map((product) => String(product.author_page_id || ''))
        .filter((id) => id && !pageMap.has(id))
    ),
  ]

  if (missingPageIds.length) {
    const missingPages = await resolveQuery(
      supabase
        .from('author_pages')
        .select(
          'id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, total_stories, total_followers, status, created_at, updated_at'
        )
        .in('id', missingPageIds)
        .eq('status', 'active')
    )

    for (const page of missingPages) {
      pageMap.set(String(page.id), page)
    }
  }

  return sortBySearchScore(
    products,
    keyword,
    (product) => [
      product.title,
      product.author_name,
      product.publisher,
      product.category,
      product.genre,
      product.description,
      pageMap.get(String(product.author_page_id))?.page_name,
      pageMap.get(String(product.author_page_id))?.page_username,
    ],
    (product) =>
      Number(product.sale_price || 0) > 0 ? 1 : 0
  )
    .slice(0, limit)
    .map((product) =>
      publicPdf(
        product,
        pageMap.get(String(product.author_page_id)) || null
      )
    )
}

async function searchPosts(
  keyword,
  matchedUsers,
  matchedPages,
  limit
) {
  const scanLimit = getScanLimit(limit)
  const now = new Date().toISOString()
  const userIds = matchedUsers.map((user) => user.id).filter(Boolean)
  const pageIds = matchedPages.map((page) => page.id).filter(Boolean)
  const readerRequests = []
  const authorRequests = []

  if (keyword) {
    readerRequests.push(
      resolveQuery(
        supabase
          .from('reader_posts')
          .select(
            'id, user_id, content, image_urls, visibility, publish_at, like_count, comment_count, echo_count, created_at, updated_at'
          )
          .eq('visibility', 'public')
          .is('deleted_at', null)
          .lte('publish_at', now)
          .ilike('content', `%${keyword}%`)
          .order('publish_at', { ascending: false })
          .limit(scanLimit)
      )
    )

    authorRequests.push(
      resolveQuery(
        supabase
          .from('author_page_posts')
          .select(
            'id, author_page_id, user_id, post_type, content, image_urls, status, is_pinned, like_count, comment_count, echo_count, created_at, updated_at'
          )
          .eq('status', 'active')
          .ilike('content', `%${keyword}%`)
          .order('created_at', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  if (userIds.length) {
    readerRequests.push(
      resolveQuery(
        supabase
          .from('reader_posts')
          .select(
            'id, user_id, content, image_urls, visibility, publish_at, like_count, comment_count, echo_count, created_at, updated_at'
          )
          .eq('visibility', 'public')
          .is('deleted_at', null)
          .lte('publish_at', now)
          .in('user_id', userIds.slice(0, MAX_SCAN_LIMIT))
          .order('publish_at', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  if (pageIds.length) {
    authorRequests.push(
      resolveQuery(
        supabase
          .from('author_page_posts')
          .select(
            'id, author_page_id, user_id, post_type, content, image_urls, status, is_pinned, like_count, comment_count, echo_count, created_at, updated_at'
          )
          .eq('status', 'active')
          .in('author_page_id', pageIds.slice(0, MAX_SCAN_LIMIT))
          .order('created_at', { ascending: false })
          .limit(scanLimit)
      )
    )
  }

  const [readerGroups, authorGroups] = await Promise.all([
    readerRequests.length ? Promise.all(readerRequests) : [],
    authorRequests.length ? Promise.all(authorRequests) : [],
  ])
  const readerPosts = uniqueById(readerGroups.flat())
  const authorPosts = uniqueById(authorGroups.flat())
  const userMap = new Map(
    matchedUsers.map((user) => [String(user.id), user])
  )
  const pageMap = new Map(
    matchedPages.map((page) => [String(page.id), page])
  )
  const missingUserIds = [
    ...new Set(
      readerPosts
        .map((post) => String(post.user_id || ''))
        .filter((id) => id && !userMap.has(id))
    ),
  ]
  const missingPageIds = [
    ...new Set(
      authorPosts
        .map((post) => String(post.author_page_id || ''))
        .filter((id) => id && !pageMap.has(id))
    ),
  ]

  const [missingUsers, missingPages] = await Promise.all([
    missingUserIds.length
      ? resolveQuery(
          supabase
            .from('users')
            .select(
              'id, name, username, avatar_url, bio, work, location, is_author, is_active, created_at, updated_at'
            )
            .in('id', missingUserIds)
            .eq('is_active', true)
        )
      : [],
    missingPageIds.length
      ? resolveQuery(
          supabase
            .from('author_pages')
            .select(
              'id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, total_stories, total_followers, status, created_at, updated_at'
            )
            .in('id', missingPageIds)
            .eq('status', 'active')
        )
      : [],
  ])

  for (const user of missingUsers) {
    userMap.set(String(user.id), user)
  }

  for (const page of missingPages) {
    pageMap.set(String(page.id), page)
  }

  const normalizedPosts = [
    ...readerPosts.map((post) =>
      publicReaderPost(
        post,
        userMap.get(String(post.user_id)) || null
      )
    ),
    ...authorPosts.map((post) =>
      publicAuthorPost(
        post,
        pageMap.get(String(post.author_page_id)) || null
      )
    ),
  ]

  return sortBySearchScore(
    normalizedPosts,
    keyword,
    (post) => [
      post.content,
      post.owner?.name,
      post.owner?.username,
      post.owner?.page_name,
      post.owner?.page_username,
    ],
    (post) =>
      Number(post.like_count || 0) +
      Number(post.comment_count || 0) * 2 +
      Number(post.echo_count || 0) * 3
  ).slice(0, limit)
}

function emptyPayload(keyword, type) {
  return {
    ok: true,
    query: keyword,
    type,
    results: [],
    sections: {
      readers: [],
      pages: [],
      stories: [],
      pdfs: [],
      posts: [],
    },
    shown_counts: {
      readers: 0,
      pages: 0,
      stories: 0,
      pdfs: 0,
      posts: 0,
      all: 0,
    },
  }
}

export async function searchDiscover(req, res) {
  try {
    const keyword = cleanKeyword(req.query.q || req.query.search)
    const type = normalizeType(req.query.type)
    const requestedLimit = getLimit(req.query.limit)
    const sectionLimit =
      type === 'all'
        ? Math.min(ALL_SECTION_LIMIT, requestedLimit)
        : requestedLimit

    if (!keyword || !cleanFilterKeyword(keyword)) {
      return res.status(200).json(emptyPayload(keyword, type))
    }

    const scanLimit = getScanLimit(requestedLimit)
    const matchedUsers = await searchMatchingUsers(keyword, scanLimit)
    const matchedUserIds = matchedUsers.map((user) => user.id).filter(Boolean)
    const matchedPages = await searchMatchingPages(
      keyword,
      matchedUserIds,
      scanLimit
    )
    const ageAccess = await getReaderAgeAccess(req)
    const sections = {
      readers: [],
      pages: [],
      stories: [],
      pdfs: [],
      posts: [],
    }

    if (type === 'all' || type === 'readers') {
      sections.readers = matchedUsers
        .slice(0, sectionLimit)
        .map(publicReader)
    }

    if (type === 'all' || type === 'pages') {
      sections.pages = matchedPages
        .slice(0, sectionLimit)
        .map(publicPage)
    }

    const requests = []

    if (type === 'all' || type === 'stories') {
      requests.push(
        searchStories(
          keyword,
          matchedPages,
          sectionLimit,
          ageAccess
        ).then((items) => {
          sections.stories = items
        })
      )
    }

    if (type === 'all' || type === 'pdfs') {
      requests.push(
        searchPdfs(
          keyword,
          matchedPages,
          sectionLimit
        ).then((items) => {
          sections.pdfs = items
        })
      )
    }

    if (type === 'all' || type === 'posts') {
      requests.push(
        searchPosts(
          keyword,
          matchedUsers,
          matchedPages,
          sectionLimit
        ).then((items) => {
          sections.posts = items
        })
      )
    }

    await Promise.all(requests)

    const results =
      type === 'all'
        ? [
            ...sections.readers,
            ...sections.pages,
            ...sections.stories,
            ...sections.pdfs,
            ...sections.posts,
          ]
        : sections[type]

    const shownCounts = {
      readers: sections.readers.length,
      pages: sections.pages.length,
      stories: sections.stories.length,
      pdfs: sections.pdfs.length,
      posts: sections.posts.length,
    }

    return res.status(200).json({
      ok: true,
      query: keyword,
      type,
      results,
      sections,
      shown_counts: {
        ...shownCounts,
        all: Object.values(shownCounts).reduce(
          (sum, value) => sum + Number(value || 0),
          0
        ),
      },
    })
  } catch (error) {
    console.error('DISCOVER SEARCH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to search Shadow',
    })
  }
}
