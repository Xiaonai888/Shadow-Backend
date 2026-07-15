import { supabase } from '../config/supabase.js'
import { getAdminActor, logAdminActivity } from '../services/adminActivity.service.js'
import { bumpContentVersions } from '../services/contentVersion.service.js'

const HELP_CENTER_VERSION_KEY = 'help_center'
const ARTICLE_STATUSES = new Set(['draft', 'published'])

function cleanText(value, fallback = '', maxLength = 20000) {
  const text = String(value ?? '').trim()
  return (text || fallback).slice(0, maxLength)
}

function cleanInteger(value, fallback = 0, min = 0, max = 1000000) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function toBoolean(value, fallback = true) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  )
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

function cleanColor(value, fallback = '#7458E8') {
  const color = String(value || '').trim()
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : fallback
}

function cleanStatus(value, fallback = 'draft') {
  const status = String(value || '').trim().toLowerCase()
  return ARTICLE_STATUSES.has(status) ? status : fallback
}

function cleanSearch(value) {
  return cleanText(value, '', 120).replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').trim()
}

function publicCategory(row, articleCount = 0) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon || 'circle-help',
    color: row.color || '#7458E8',
    display_order: Number(row.display_order || 0),
    article_count: Number(articleCount || 0),
  }
}

function publicArticle(row, category = null) {
  return {
    id: row.id,
    category_id: row.category_id,
    question: row.question,
    answer: row.answer,
    search_keywords: row.search_keywords || '',
    display_order: Number(row.display_order || 0),
    is_popular: Boolean(row.is_popular),
    created_at: row.created_at,
    updated_at: row.updated_at,
    category: category
      ? {
          id: category.id,
          name: category.name,
          slug: category.slug,
          icon: category.icon || 'circle-help',
          color: category.color || '#7458E8',
        }
      : null,
  }
}

async function getCategoryById(categoryId) {
  const { data, error } = await supabase
    .from('help_categories')
    .select('*')
    .eq('id', categoryId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getCategoryBySlug(slug) {
  const { data, error } = await supabase
    .from('help_categories')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function notifyHelpCenterChange() {
  await bumpContentVersions([HELP_CENTER_VERSION_KEY])
}

async function recordAdminAction(req, action, sectionKey, item, details = '') {
  await logAdminActivity({
    action,
    section_key: sectionKey,
    item_id: item?.id || null,
    title: item?.question || item?.name || '',
    order_index: Number(item?.display_order || 0),
    actor: getAdminActor(req),
    details,
  })
}

function sendError(res, error, fallbackMessage) {
  console.error(`${fallbackMessage.toUpperCase()} ERROR:`, error)

  if (error?.code === '23505') {
    return res.status(409).json({ ok: false, message: 'This Help Center item already exists' })
  }

  if (error?.code === '23503') {
    return res.status(409).json({ ok: false, message: 'This item is still connected to other Help Center content' })
  }

  return res.status(500).json({
    ok: false,
    message: error?.message || fallbackMessage,
  })
}

export async function getPublicHelpCenter(req, res) {
  try {
    const [categoriesResult, articlesResult] = await Promise.all([
      supabase
        .from('help_categories')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true })
        .order('name', { ascending: true }),
      supabase
        .from('help_articles')
        .select('*')
        .eq('status', 'published')
        .eq('is_active', true)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true }),
    ])

    if (categoriesResult.error) throw categoriesResult.error
    if (articlesResult.error) throw articlesResult.error

    const categoryRows = categoriesResult.data || []
    const categoryMap = new Map(categoryRows.map((category) => [category.id, category]))
    const articleRows = (articlesResult.data || []).filter((article) => categoryMap.has(article.category_id))

    const articles = articleRows.map((article) => publicArticle(article, categoryMap.get(article.category_id)))
    const articlesByCategory = new Map()

    for (const article of articles) {
      const current = articlesByCategory.get(article.category_id) || []
      current.push(article)
      articlesByCategory.set(article.category_id, current)
    }

    const categories = categoryRows.map((category) => {
      const categoryArticles = articlesByCategory.get(category.id) || []
      return {
        ...publicCategory(category, categoryArticles.length),
        articles: categoryArticles,
      }
    })

    return res.status(200).json({
      ok: true,
      categories,
      articles,
      popular_articles: articles.filter((article) => article.is_popular),
    })
  } catch (error) {
    return sendError(res, error, 'Failed to load Help Center')
  }
}

export async function getPublicHelpCategories(req, res) {
  try {
    const [categoriesResult, articleIdsResult] = await Promise.all([
      supabase
        .from('help_categories')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true })
        .order('name', { ascending: true }),
      supabase
        .from('help_articles')
        .select('category_id')
        .eq('status', 'published')
        .eq('is_active', true),
    ])

    if (categoriesResult.error) throw categoriesResult.error
    if (articleIdsResult.error) throw articleIdsResult.error

    const counts = new Map()
    for (const article of articleIdsResult.data || []) {
      counts.set(article.category_id, Number(counts.get(article.category_id) || 0) + 1)
    }

    return res.status(200).json({
      ok: true,
      categories: (categoriesResult.data || []).map((category) =>
        publicCategory(category, counts.get(category.id) || 0),
      ),
    })
  } catch (error) {
    return sendError(res, error, 'Failed to load Help Center categories')
  }
}

export async function getPublicHelpArticles(req, res) {
  try {
    const search = cleanSearch(req.query.search || req.query.q)
    const categorySlug = slugify(req.query.category || req.query.category_slug)
    const popularOnly = toBoolean(req.query.popular, false)
    const limit = cleanInteger(req.query.limit, 100, 1, 100)

    const { data: activeCategories, error: categoriesError } = await supabase
      .from('help_categories')
      .select('*')
      .eq('is_active', true)

    if (categoriesError) throw categoriesError

    let categoryRows = activeCategories || []
    if (categorySlug) {
      categoryRows = categoryRows.filter((category) => category.slug === categorySlug)
    }

    const categoryMap = new Map(categoryRows.map((category) => [category.id, category]))
    const categoryIds = [...categoryMap.keys()]

    if (!categoryIds.length) {
      return res.status(200).json({ ok: true, articles: [], total: 0 })
    }

    let query = supabase
      .from('help_articles')
      .select('*')
      .in('category_id', categoryIds)
      .eq('status', 'published')
      .eq('is_active', true)

    if (popularOnly) query = query.eq('is_popular', true)

    if (search) {
      const pattern = `%${search}%`
      query = query.or(`question.ilike.${pattern},answer.ilike.${pattern},search_keywords.ilike.${pattern}`)
    }

    const { data, error } = await query
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(limit)

    if (error) throw error

    const articles = (data || []).map((article) => publicArticle(article, categoryMap.get(article.category_id)))

    return res.status(200).json({
      ok: true,
      articles,
      total: articles.length,
    })
  } catch (error) {
    return sendError(res, error, 'Failed to search Help Center articles')
  }
}

export async function getPublicHelpArticleById(req, res) {
  try {
    const articleId = String(req.params.articleId || '').trim()
    if (!isUuid(articleId)) {
      return res.status(400).json({ ok: false, message: 'Invalid article ID' })
    }

    const { data: article, error } = await supabase
      .from('help_articles')
      .select('*')
      .eq('id', articleId)
      .eq('status', 'published')
      .eq('is_active', true)
      .maybeSingle()

    if (error) throw error
    if (!article) return res.status(404).json({ ok: false, message: 'Help article not found' })

    const category = await getCategoryById(article.category_id)
    if (!category?.is_active) {
      return res.status(404).json({ ok: false, message: 'Help article not found' })
    }

    return res.status(200).json({
      ok: true,
      article: publicArticle(article, category),
    })
  } catch (error) {
    return sendError(res, error, 'Failed to load Help Center article')
  }
}

export async function getAdminHelpCategories(req, res) {
  try {
    const [categoriesResult, articlesResult] = await Promise.all([
      supabase
        .from('help_categories')
        .select('*')
        .order('display_order', { ascending: true })
        .order('name', { ascending: true }),
      supabase.from('help_articles').select('category_id'),
    ])

    if (categoriesResult.error) throw categoriesResult.error
    if (articlesResult.error) throw articlesResult.error

    const counts = new Map()
    for (const article of articlesResult.data || []) {
      counts.set(article.category_id, Number(counts.get(article.category_id) || 0) + 1)
    }

    return res.status(200).json({
      ok: true,
      categories: (categoriesResult.data || []).map((category) => ({
        ...category,
        article_count: Number(counts.get(category.id) || 0),
      })),
    })
  } catch (error) {
    return sendError(res, error, 'Failed to load admin Help Center categories')
  }
}

export async function createAdminHelpCategory(req, res) {
  try {
    const name = cleanText(req.body.name, '', 120)
    const slug = slugify(req.body.slug || name)

    if (!name || !slug) {
      return res.status(400).json({ ok: false, message: 'Category name is required' })
    }

    const payload = {
      name,
      slug,
      icon: cleanText(req.body.icon, 'circle-help', 80),
      color: cleanColor(req.body.color),
      display_order: cleanInteger(req.body.display_order, 0),
      is_active: toBoolean(req.body.is_active, true),
    }

    const { data, error } = await supabase
      .from('help_categories')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'CREATE', 'help_center_categories', data, 'Created Help Center category'),
    ])

    return res.status(201).json({ ok: true, category: data })
  } catch (error) {
    return sendError(res, error, 'Failed to create Help Center category')
  }
}

export async function updateAdminHelpCategory(req, res) {
  try {
    const categoryId = String(req.params.categoryId || '').trim()
    if (!isUuid(categoryId)) {
      return res.status(400).json({ ok: false, message: 'Invalid category ID' })
    }

    const current = await getCategoryById(categoryId)
    if (!current) return res.status(404).json({ ok: false, message: 'Help category not found' })

    const name = req.body.name === undefined ? current.name : cleanText(req.body.name, '', 120)
    const slug = req.body.slug === undefined && req.body.name === undefined
      ? current.slug
      : slugify(req.body.slug || name)

    if (!name || !slug) {
      return res.status(400).json({ ok: false, message: 'Category name is required' })
    }

    const payload = {
      name,
      slug,
      icon: req.body.icon === undefined ? current.icon : cleanText(req.body.icon, 'circle-help', 80),
      color: req.body.color === undefined ? current.color : cleanColor(req.body.color, current.color),
      display_order: req.body.display_order === undefined
        ? current.display_order
        : cleanInteger(req.body.display_order, current.display_order),
      is_active: req.body.is_active === undefined
        ? current.is_active
        : toBoolean(req.body.is_active, current.is_active),
    }

    const { data, error } = await supabase
      .from('help_categories')
      .update(payload)
      .eq('id', categoryId)
      .select('*')
      .single()

    if (error) throw error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'UPDATE', 'help_center_categories', data, 'Updated Help Center category'),
    ])

    return res.status(200).json({ ok: true, category: data })
  } catch (error) {
    return sendError(res, error, 'Failed to update Help Center category')
  }
}

export async function deleteAdminHelpCategory(req, res) {
  try {
    const categoryId = String(req.params.categoryId || '').trim()
    if (!isUuid(categoryId)) {
      return res.status(400).json({ ok: false, message: 'Invalid category ID' })
    }

    const current = await getCategoryById(categoryId)
    if (!current) return res.status(404).json({ ok: false, message: 'Help category not found' })

    const { count, error: countError } = await supabase
      .from('help_articles')
      .select('id', { count: 'exact', head: true })
      .eq('category_id', categoryId)

    if (countError) throw countError
    if (Number(count || 0) > 0) {
      return res.status(409).json({
        ok: false,
        message: 'Move or delete this category’s articles before deleting the category',
      })
    }

    const { error } = await supabase.from('help_categories').delete().eq('id', categoryId)
    if (error) throw error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'DELETE', 'help_center_categories', current, 'Deleted Help Center category'),
    ])

    return res.status(200).json({ ok: true, message: 'Help category deleted' })
  } catch (error) {
    return sendError(res, error, 'Failed to delete Help Center category')
  }
}

export async function reorderAdminHelpCategories(req, res) {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : []
    const validItems = items
      .filter((item) => isUuid(item?.id))
      .map((item, index) => ({
        id: item.id,
        display_order: cleanInteger(item.display_order, index),
      }))

    if (!validItems.length) {
      return res.status(400).json({ ok: false, message: 'Category order items are required' })
    }

    const results = await Promise.all(
      validItems.map((item) =>
        supabase
          .from('help_categories')
          .update({ display_order: item.display_order })
          .eq('id', item.id),
      ),
    )

    const failed = results.find((result) => result.error)
    if (failed?.error) throw failed.error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'UPDATE', 'help_center_categories', null, 'Reordered Help Center categories'),
    ])

    return res.status(200).json({ ok: true, message: 'Category order updated' })
  } catch (error) {
    return sendError(res, error, 'Failed to reorder Help Center categories')
  }
}

export async function getAdminHelpArticles(req, res) {
  try {
    const page = cleanInteger(req.query.page, 1, 1, 100000)
    const limit = cleanInteger(req.query.limit, 30, 1, 100)
    const search = cleanSearch(req.query.search || req.query.q)
    const categoryValue = cleanText(req.query.category || req.query.category_id, '', 120)
    const status = cleanText(req.query.status, '', 20).toLowerCase()
    const activeValue = req.query.active ?? req.query.is_active
    const popularValue = req.query.popular ?? req.query.is_popular
    const from = (page - 1) * limit
    const to = from + limit - 1

    let categoryId = ''
    if (categoryValue) {
      if (isUuid(categoryValue)) {
        categoryId = categoryValue
      } else {
        const category = await getCategoryBySlug(slugify(categoryValue))
        categoryId = category?.id || '__missing__'
      }
    }

    let query = supabase.from('help_articles').select('*', { count: 'exact' })

    if (categoryId === '__missing__') {
      return res.status(200).json({ ok: true, articles: [], page, limit, total: 0 })
    }

    if (categoryId) query = query.eq('category_id', categoryId)
    if (ARTICLE_STATUSES.has(status)) query = query.eq('status', status)
    if (activeValue !== undefined) query = query.eq('is_active', toBoolean(activeValue, true))
    if (popularValue !== undefined) query = query.eq('is_popular', toBoolean(popularValue, false))

    if (search) {
      const pattern = `%${search}%`
      query = query.or(`question.ilike.${pattern},answer.ilike.${pattern},search_keywords.ilike.${pattern}`)
    }

    const [{ data, error, count }, categoriesResult] = await Promise.all([
      query
        .order('display_order', { ascending: true })
        .order('updated_at', { ascending: false })
        .range(from, to),
      supabase.from('help_categories').select('*'),
    ])

    if (error) throw error
    if (categoriesResult.error) throw categoriesResult.error

    const categoryMap = new Map((categoriesResult.data || []).map((category) => [category.id, category]))

    return res.status(200).json({
      ok: true,
      articles: (data || []).map((article) => ({
        ...article,
        category: categoryMap.get(article.category_id) || null,
      })),
      page,
      limit,
      total: Number(count || 0),
    })
  } catch (error) {
    return sendError(res, error, 'Failed to load admin Help Center articles')
  }
}

export async function createAdminHelpArticle(req, res) {
  try {
    const categoryId = cleanText(req.body.category_id || req.body.categoryId, '', 80)
    const question = cleanText(req.body.question, '', 500)
    const answer = cleanText(req.body.answer, '', 20000)

    if (!isUuid(categoryId)) {
      return res.status(400).json({ ok: false, message: 'A valid category is required' })
    }

    if (!question || !answer) {
      return res.status(400).json({ ok: false, message: 'Question and answer are required' })
    }

    const category = await getCategoryById(categoryId)
    if (!category) return res.status(404).json({ ok: false, message: 'Help category not found' })

    const payload = {
      category_id: categoryId,
      question,
      answer,
      search_keywords: cleanText(req.body.search_keywords || req.body.searchKeywords, '', 1000),
      display_order: cleanInteger(req.body.display_order, 0),
      is_popular: toBoolean(req.body.is_popular, false),
      status: cleanStatus(req.body.status, 'draft'),
      is_active: toBoolean(req.body.is_active, true),
    }

    const { data, error } = await supabase
      .from('help_articles')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'CREATE', 'help_center_articles', data, 'Created Help Center article'),
    ])

    return res.status(201).json({ ok: true, article: { ...data, category } })
  } catch (error) {
    return sendError(res, error, 'Failed to create Help Center article')
  }
}

export async function updateAdminHelpArticle(req, res) {
  try {
    const articleId = String(req.params.articleId || '').trim()
    if (!isUuid(articleId)) {
      return res.status(400).json({ ok: false, message: 'Invalid article ID' })
    }

    const { data: current, error: currentError } = await supabase
      .from('help_articles')
      .select('*')
      .eq('id', articleId)
      .maybeSingle()

    if (currentError) throw currentError
    if (!current) return res.status(404).json({ ok: false, message: 'Help article not found' })

    const categoryId = req.body.category_id === undefined && req.body.categoryId === undefined
      ? current.category_id
      : cleanText(req.body.category_id || req.body.categoryId, '', 80)

    if (!isUuid(categoryId)) {
      return res.status(400).json({ ok: false, message: 'A valid category is required' })
    }

    const category = await getCategoryById(categoryId)
    if (!category) return res.status(404).json({ ok: false, message: 'Help category not found' })

    const payload = {
      category_id: categoryId,
      question: req.body.question === undefined
        ? current.question
        : cleanText(req.body.question, '', 500),
      answer: req.body.answer === undefined
        ? current.answer
        : cleanText(req.body.answer, '', 20000),
      search_keywords: req.body.search_keywords === undefined && req.body.searchKeywords === undefined
        ? current.search_keywords
        : cleanText(req.body.search_keywords || req.body.searchKeywords, '', 1000),
      display_order: req.body.display_order === undefined
        ? current.display_order
        : cleanInteger(req.body.display_order, current.display_order),
      is_popular: req.body.is_popular === undefined
        ? current.is_popular
        : toBoolean(req.body.is_popular, current.is_popular),
      status: req.body.status === undefined
        ? current.status
        : cleanStatus(req.body.status, current.status),
      is_active: req.body.is_active === undefined
        ? current.is_active
        : toBoolean(req.body.is_active, current.is_active),
    }

    if (!payload.question || !payload.answer) {
      return res.status(400).json({ ok: false, message: 'Question and answer are required' })
    }

    const { data, error } = await supabase
      .from('help_articles')
      .update(payload)
      .eq('id', articleId)
      .select('*')
      .single()

    if (error) throw error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'UPDATE', 'help_center_articles', data, 'Updated Help Center article'),
    ])

    return res.status(200).json({ ok: true, article: { ...data, category } })
  } catch (error) {
    return sendError(res, error, 'Failed to update Help Center article')
  }
}

export async function deleteAdminHelpArticle(req, res) {
  try {
    const articleId = String(req.params.articleId || '').trim()
    if (!isUuid(articleId)) {
      return res.status(400).json({ ok: false, message: 'Invalid article ID' })
    }

    const { data: current, error: currentError } = await supabase
      .from('help_articles')
      .select('*')
      .eq('id', articleId)
      .maybeSingle()

    if (currentError) throw currentError
    if (!current) return res.status(404).json({ ok: false, message: 'Help article not found' })

    const { error } = await supabase.from('help_articles').delete().eq('id', articleId)
    if (error) throw error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'DELETE', 'help_center_articles', current, 'Deleted Help Center article'),
    ])

    return res.status(200).json({ ok: true, message: 'Help article deleted' })
  } catch (error) {
    return sendError(res, error, 'Failed to delete Help Center article')
  }
}

export async function reorderAdminHelpArticles(req, res) {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : []
    const validItems = items
      .filter((item) => isUuid(item?.id))
      .map((item, index) => ({
        id: item.id,
        display_order: cleanInteger(item.display_order, index),
      }))

    if (!validItems.length) {
      return res.status(400).json({ ok: false, message: 'Article order items are required' })
    }

    const results = await Promise.all(
      validItems.map((item) =>
        supabase
          .from('help_articles')
          .update({ display_order: item.display_order })
          .eq('id', item.id),
      ),
    )

    const failed = results.find((result) => result.error)
    if (failed?.error) throw failed.error

    await Promise.all([
      notifyHelpCenterChange(),
      recordAdminAction(req, 'UPDATE', 'help_center_articles', null, 'Reordered Help Center articles'),
    ])

    return res.status(200).json({ ok: true, message: 'Article order updated' })
  } catch (error) {
    return sendError(res, error, 'Failed to reorder Help Center articles')
  }
}
