import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import { html, sendAuthorStoreTelegramMessage } from '../services/telegram.service.js'

const PRODUCT_TYPES = new Set(['book', 'pdf'])
const PRODUCT_STATUSES = new Set(['draft', 'active', 'hidden'])

function normalizePageUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function cleanInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback
}

const DEFAULT_AUTHOR_STORE_DELIVERY_SETTINGS = [
  {
    company_key: 'jnt',
    company_name: 'J&T Express',
    short_name: 'J&T',
    fee_usd: 2,
    is_active: true,
    sort_order: 0,
  },
  {
    company_key: 'vet',
    company_name: 'VET Express',
    short_name: 'VET',
    fee_usd: 2,
    is_active: true,
    sort_order: 1,
  },
]

function publicDeliverySetting(setting) {
  return {
    id: setting.id || '',
    company_key: setting.company_key || '',
    company_name: setting.company_name || '',
    short_name: setting.short_name || '',
    fee_usd: Number(setting.fee_usd || 0),
    is_active: Boolean(setting.is_active),
    sort_order: Number(setting.sort_order || 0),
  }
}

function mergeDeliverySettings(settings) {
  const map = new Map((settings || []).map((setting) => [setting.company_key, setting]))

  return DEFAULT_AUTHOR_STORE_DELIVERY_SETTINGS.map((defaultSetting) => {
    const saved = map.get(defaultSetting.company_key)
    return publicDeliverySetting(saved || defaultSetting)
  })
}

function publicProduct(product) {
  if (!product) return null

  return {
    id: product.id,
    author_page_id: product.author_page_id,
    user_id: product.user_id,
    product_type: product.product_type || 'book',
    type: product.product_type === 'pdf' ? 'PDF' : 'Book',
    title: product.title || '',
    category: product.category || 'New Release',
    description: product.description || '',
    original_price: Number(product.original_price || 0),
    sale_price: Number(product.sale_price || 0),
    status: product.status || 'draft',
    cover_url: product.cover_url || '',
    stock_quantity: Number(product.stock_quantity || 0),
    paper_type: product.paper_type || '',
    book_condition: product.book_condition || 'New',
    quality_percent: product.quality_percent,
    delivery_note: product.delivery_note || '',
    pre_order: Boolean(product.pre_order),
    pdf_file_url: product.pdf_file_url || '',
    pdf_file_name: product.pdf_file_name || '',
    page_count: Number(product.page_count || 0),
    access_rule: product.access_rule || '',
    created_at: product.created_at,
    updated_at: product.updated_at,
  }
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data
}



async function createUniqueTelegramLinkToken() {
  const now = new Date().toISOString()

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = crypto.randomBytes(12).toString('hex')

    const { data, error } = await supabase
      .from('author_pages')
      .select('id')
      .eq('telegram_link_token', token)
      .gt('telegram_link_expires_at', now)
      .maybeSingle()

    if (error) throw error
    if (!data) return token
  }

  throw new Error('Failed to generate Telegram link token')
}

function publicAuthorStoreTelegramSettings(authorPage) {
  return {
    bot_username: process.env.TELEGRAM_BOT_USERNAME || '',
    chat_id: authorPage.telegram_chat_id || '',
    chat_title: authorPage.telegram_chat_title || '',
    linked_at: authorPage.telegram_linked_at || null,
    is_linked: Boolean(authorPage.telegram_chat_id),
  }
}

export async function getMyAuthorStoreDeliverySettings(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data, error } = await supabase
      .from('author_store_delivery_settings')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .order('sort_order', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      delivery_settings: mergeDeliverySettings(data || []),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE DELIVERY SETTINGS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load delivery settings', error: error.message })
  }
}

export async function updateMyAuthorStoreDeliverySettings(req, res) {
  try {
    const userId = req.user?.user_id
    const settings = Array.isArray(req.body.delivery_settings)
      ? req.body.delivery_settings
      : Array.isArray(req.body.deliverySettings)
        ? req.body.deliverySettings
        : []

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const incomingMap = new Map(settings.map((setting) => [String(setting.company_key || setting.companyKey || '').toLowerCase(), setting]))

    const payload = DEFAULT_AUTHOR_STORE_DELIVERY_SETTINGS.map((defaultSetting) => {
      const incoming = incomingMap.get(defaultSetting.company_key) || {}
      const fee = cleanNumber(incoming.fee_usd ?? incoming.feeUsd ?? defaultSetting.fee_usd, defaultSetting.fee_usd)

      return {
        author_page_id: authorPage.id,
        user_id: userId,
        company_key: defaultSetting.company_key,
        company_name: defaultSetting.company_name,
        short_name: defaultSetting.short_name,
        fee_usd: Math.max(0, fee),
        is_active: typeof incoming.is_active === 'boolean' ? incoming.is_active : defaultSetting.is_active,
        sort_order: defaultSetting.sort_order,
        updated_at: new Date().toISOString(),
      }
    })

    const { data, error } = await supabase
      .from('author_store_delivery_settings')
      .upsert(payload, { onConflict: 'author_page_id,company_key' })
      .select('*')

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Delivery settings updated',
      delivery_settings: mergeDeliverySettings(data || []),
    })
  } catch (error) {
    console.error('UPDATE MY AUTHOR STORE DELIVERY SETTINGS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update delivery settings', error: error.message })
  }
}

function getTelegramWebhookMessage(update) {
  return update?.message || update?.channel_post || null
}

function getTelegramStartToken(text) {
  const match = String(text || '').trim().match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i)
  return String(match?.[1] || '').trim()
}

function isTelegramGroup(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sendTelegramMessageWithRetry(text, options = {}) {
  const delays = [1500, 3000, 5000]
  let lastError = null

  for (let index = 0; index < delays.length; index += 1) {
    await sleep(delays[index])

    try {
      return await sendAuthorStoreTelegramMessage(text, options)
    } catch (error) {
      lastError = error
      console.error('TELEGRAM SEND RETRY FAILED:', {
        attempt: index + 1,
        chat_id: options.chat_id,
        error: error.message,
      })
    }
  }

    throw lastError || new Error('Telegram send failed')
}

export async function handleAuthorStoreTelegramWebhook(req, res) {
  try {
    const update = req.body || {}

    console.log('AUTHOR STORE TELEGRAM WEBHOOK RECEIVED:', JSON.stringify(update))

    const message = getTelegramWebhookMessage(update)
    const memberUpdate = update.my_chat_member || null

    const chat = message?.chat || memberUpdate?.chat || null
    const text = message?.text || ''
    const token = getTelegramStartToken(text)

    if (!chat) {
      console.log('TELEGRAM WEBHOOK IGNORED:', {
        reason: 'no_chat',
        update_type: Object.keys(update || {}),
      })

      return res.status(200).json({ ok: true, ignored: true, reason: 'no_chat' })
    }

    if (!isTelegramGroup(chat)) {
      console.log('TELEGRAM WEBHOOK IGNORED:', {
        reason: 'not_group',
        chat_id: chat.id,
        chat_type: chat.type,
      })

      return res.status(200).json({ ok: true, ignored: true, reason: 'not_group' })
    }

    const now = new Date().toISOString()
    let authorPage = null

    if (token) {
      const { data, error: pageError } = await supabase
        .from('author_pages')
        .select('id, page_name, page_username, telegram_chat_id')
        .eq('telegram_link_token', token)
        .gt('telegram_link_expires_at', now)
        .maybeSingle()

      if (pageError) throw pageError

      authorPage = data || null

      console.log('TELEGRAM TOKEN CHECK:', {
        has_token: true,
        found_author_page: Boolean(authorPage),
        chat_id: chat.id,
      })
    } else if (memberUpdate) {
      const newStatus = memberUpdate?.new_chat_member?.status || ''
      const oldStatus = memberUpdate?.old_chat_member?.status || ''

      console.log('TELEGRAM MEMBER UPDATE:', {
        chat_id: chat.id,
        chat_title: chat.title,
        old_status: oldStatus,
        new_status: newStatus,
      })

      if (newStatus !== 'member' && newStatus !== 'administrator') {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: 'bot_not_added',
          status: newStatus,
        })
      }

      const { data: pendingPages, error: pendingError } = await supabase
        .from('author_pages')
        .select('id, page_name, page_username, telegram_chat_id, telegram_link_token')
        .is('telegram_chat_id', null)
        .not('telegram_link_token', 'is', null)
        .gt('telegram_link_expires_at', now)
        .order('telegram_link_expires_at', { ascending: false })
        .limit(2)

      if (pendingError) throw pendingError

      if (!pendingPages || pendingPages.length === 0) {
        console.log('TELEGRAM LINK FAILED:', {
          reason: 'no_pending_link',
          chat_id: chat.id,
          chat_title: chat.title,
        })

        return res.status(200).json({
          ok: true,
          linked: false,
          reason: 'no_pending_link',
        })
      }

      if (pendingPages.length > 1) {
        console.log('TELEGRAM LINK FAILED:', {
          reason: 'too_many_pending_links',
          chat_id: chat.id,
          chat_title: chat.title,
          count: pendingPages.length,
        })

        return res.status(200).json({
          ok: true,
          linked: false,
          reason: 'too_many_pending_links',
        })
      }

      authorPage = pendingPages[0]

      console.log('TELEGRAM PENDING LINK FOUND:', {
        author_page_id: authorPage.id,
        chat_id: chat.id,
        chat_title: chat.title,
      })
    } else {
      console.log('TELEGRAM WEBHOOK IGNORED:', {
        reason: 'missing_token_and_not_member_update',
        chat_id: chat.id,
        text,
      })

      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: 'missing_token_and_not_member_update',
      })
    }

    if (!authorPage) {
      console.log('TELEGRAM LINK FAILED:', {
        reason: 'invalid_or_expired_token',
        chat_id: chat.id,
        text,
      })

      return res.status(200).json({
        ok: true,
        linked: false,
        reason: 'invalid_or_expired_token',
      })
    }

    if (authorPage.telegram_chat_id) {
      console.log('TELEGRAM LINK FAILED:', {
        reason: 'already_linked',
        author_page_id: authorPage.id,
        existing_chat_id: authorPage.telegram_chat_id,
        new_chat_id: chat.id,
      })

      return res.status(200).json({
        ok: true,
        linked: false,
        reason: 'already_linked',
      })
    }

    const { error: updateError } = await supabase
      .from('author_pages')
      .update({
        telegram_chat_id: String(chat.id),
        telegram_chat_title: chat.title || '',
        telegram_link_token: null,
        telegram_link_expires_at: null,
        telegram_linked_at: now,
        updated_at: now,
      })
      .eq('id', authorPage.id)

    if (updateError) throw updateError

    console.log('TELEGRAM GROUP LINKED:', {
      author_page_id: authorPage.id,
      chat_id: chat.id,
      chat_title: chat.title,
    })

        try {
      await sendTelegramMessageWithRetry([
        '🎉 <b>Congratulations!</b>',
        '',
        `You’ve successfully linked <b>${html(authorPage.page_name || authorPage.page_username || 'your Author Page')}</b> to this Telegram group.`,
        '',
        'Author Store order notifications will appear here.',
      ].join('\n'), {
        chat_id: String(chat.id),
      })

      console.log('TELEGRAM CONGRATULATIONS SENT:', {
        chat_id: chat.id,
        chat_title: chat.title,
      })
    } catch (sendError) {
      console.error('TELEGRAM CONGRATULATIONS SEND FAILED:', {
        chat_id: chat.id,
        chat_title: chat.title,
        error: sendError.message,
      })
    }

    return res.status(200).json({ ok: true, linked: true })
  } catch (error) {
    console.error('AUTHOR STORE TELEGRAM WEBHOOK ERROR:', error)
    return res.status(200).json({ ok: false, message: error.message || 'Telegram webhook failed' })
  }
}

export async function getMyAuthorStoreTelegramSettings(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    return res.status(200).json({
      ok: true,
      telegram_settings: publicAuthorStoreTelegramSettings(authorPage),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE TELEGRAM SETTINGS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load Telegram settings',
    })
  }
}

export async function createMyAuthorStoreTelegramConnectLink(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    if (authorPage.telegram_chat_id) {
      return res.status(409).json({
        ok: false,
        message: 'Telegram group is already linked. Please unlink the current group before connecting a new one.',
      })
    }

    const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@+/, '').trim()

    if (!botUsername) {
      return res.status(500).json({
        ok: false,
        message: 'TELEGRAM_BOT_USERNAME is not configured',
      })
    }

    const token = await createUniqueTelegramLinkToken()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('author_pages')
      .update({
        telegram_link_token: token,
        telegram_link_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', authorPage.id)
      .eq('user_id', userId)
      .select('telegram_chat_id, telegram_chat_title, telegram_linked_at')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Telegram connect link created',
      telegram_connect: {
        connect_url: `https://t.me/${botUsername}?startgroup=${token}`,
        expires_at: expiresAt,
      },
      telegram_settings: publicAuthorStoreTelegramSettings(data || {}),
    })
  } catch (error) {
    console.error('CREATE AUTHOR STORE TELEGRAM CONNECT LINK ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to create Telegram connect link',
    })
  }
}

export async function unlinkMyAuthorStoreTelegramGroup(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .update({
        telegram_chat_id: null,
        telegram_chat_title: null,
        telegram_link_token: null,
        telegram_link_expires_at: null,
        telegram_linked_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', authorPage.id)
      .eq('user_id', userId)
      .select('telegram_chat_id, telegram_chat_title, telegram_linked_at')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Telegram group unlinked',
      telegram_settings: publicAuthorStoreTelegramSettings(data || {}),
    })
  } catch (error) {
    console.error('UNLINK AUTHOR STORE TELEGRAM GROUP ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to unlink Telegram group',
    })
  }
}

export async function getMyAuthorStoreProducts(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      products: (data || []).map(publicProduct),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE PRODUCTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store products', error: error.message })
  }
}

export async function getPublicAuthorStoreProducts(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)

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

    const { data, error } = await supabase
      .from('author_store_products')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      products: (data || []).map(publicProduct),
    })
  } catch (error) {
    console.error('GET PUBLIC AUTHOR STORE PRODUCTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store products', error: error.message })
  }
}

export async function createMyAuthorStoreProduct(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const title = cleanText(req.body.title)
    const productTypeRaw = cleanText(req.body.product_type || req.body.productType || req.body.type || 'book').toLowerCase()
    const productType = productTypeRaw === 'pdf' ? 'pdf' : 'book'
    const statusRaw = cleanText(req.body.status || 'draft').toLowerCase()
    const status = PRODUCT_STATUSES.has(statusRaw) ? statusRaw : 'draft'
    const coverUrl = cleanText(req.body.cover_url || req.body.coverUrl)

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Product title is required' })
    }

    if (!PRODUCT_TYPES.has(productType)) {
      return res.status(400).json({ ok: false, message: 'Invalid product type' })
    }

    if (!coverUrl) {
      return res.status(400).json({ ok: false, message: 'Product cover is required' })
    }

    const bookCondition = cleanText(req.body.book_condition || req.body.bookCondition || 'New')
    const qualityPercentRaw = req.body.quality_percent ?? req.body.qualityPercent ?? null
    const qualityPercent = qualityPercentRaw === null || qualityPercentRaw === ''
      ? null
      : cleanInteger(qualityPercentRaw, null)

    if (bookCondition === 'Second Hand' && (!qualityPercent || qualityPercent < 1 || qualityPercent > 100)) {
      return res.status(400).json({ ok: false, message: 'Book quality must be between 1% and 100%.' })
    }

    const payload = {
      author_page_id: authorPage.id,
      user_id: userId,
      product_type: productType,
      title,
      category: cleanText(req.body.category, 'New Release') || 'New Release',
      description: cleanText(req.body.description),
      original_price: cleanNumber(req.body.original_price ?? req.body.originalPrice, 0),
      sale_price: cleanNumber(req.body.sale_price ?? req.body.salePrice, 0),
      status,
      cover_url: coverUrl,
      stock_quantity: cleanInteger(req.body.stock_quantity ?? req.body.stockQuantity ?? req.body.stock, 0),
      paper_type: cleanText(req.body.paper_type || req.body.paperType),
      book_condition: bookCondition,
      quality_percent: bookCondition === 'Second Hand' ? qualityPercent : null,
      delivery_note: cleanText(req.body.delivery_note || req.body.deliveryNote),
      pre_order: Boolean(req.body.pre_order ?? req.body.preOrder),
      pdf_file_url: cleanText(req.body.pdf_file_url || req.body.pdfFileUrl),
      pdf_file_name: cleanText(req.body.pdf_file_name || req.body.pdfFileName),
      page_count: cleanInteger(req.body.page_count ?? req.body.pageCount, 0),
      access_rule: cleanText(req.body.access_rule || req.body.accessRule),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .insert(payload)
      .select()
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      message: 'Product created',
      product: publicProduct(data),
    })
  } catch (error) {
    console.error('CREATE MY AUTHOR STORE PRODUCT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create product', error: error.message })
  }
}

export async function updateMyAuthorStoreProduct(req, res) {
  try {
    const userId = req.user?.user_id
    const productId = req.params.productId

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!productId) {
      return res.status(400).json({ ok: false, message: 'Product ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const title = cleanText(req.body.title)
    const productTypeRaw = cleanText(req.body.product_type || req.body.productType || req.body.type || 'book').toLowerCase()
    const productType = productTypeRaw === 'pdf' ? 'pdf' : 'book'
    const statusRaw = cleanText(req.body.status || 'draft').toLowerCase()
    const status = PRODUCT_STATUSES.has(statusRaw) ? statusRaw : 'draft'
    const coverUrl = cleanText(req.body.cover_url || req.body.coverUrl)

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Product title is required' })
    }

    if (!PRODUCT_TYPES.has(productType)) {
      return res.status(400).json({ ok: false, message: 'Invalid product type' })
    }

    if (!coverUrl) {
      return res.status(400).json({ ok: false, message: 'Product cover is required' })
    }

    const bookCondition = cleanText(req.body.book_condition || req.body.bookCondition || 'New')
    const qualityPercentRaw = req.body.quality_percent ?? req.body.qualityPercent ?? null
    const qualityPercent = qualityPercentRaw === null || qualityPercentRaw === ''
      ? null
      : cleanInteger(qualityPercentRaw, null)

    if (bookCondition === 'Second Hand' && (!qualityPercent || qualityPercent < 1 || qualityPercent > 100)) {
      return res.status(400).json({ ok: false, message: 'Book quality must be between 1% and 100%.' })
    }


    const payload = {
      product_type: productType,
      title,
      category: cleanText(req.body.category, 'New Release') || 'New Release',
      description: cleanText(req.body.description),
      original_price: cleanNumber(req.body.original_price ?? req.body.originalPrice, 0),
      sale_price: cleanNumber(req.body.sale_price ?? req.body.salePrice, 0),
      status,
      cover_url: coverUrl,
      stock_quantity: cleanInteger(req.body.stock_quantity ?? req.body.stockQuantity ?? req.body.stock, 0),
      paper_type: cleanText(req.body.paper_type || req.body.paperType),
      book_condition: bookCondition,
      quality_percent: bookCondition === 'Second Hand' ? qualityPercent : null,
      delivery_note: cleanText(req.body.delivery_note || req.body.deliveryNote),
      pre_order: Boolean(req.body.pre_order ?? req.body.preOrder),
      pdf_file_url: cleanText(req.body.pdf_file_url || req.body.pdfFileUrl),
      pdf_file_name: cleanText(req.body.pdf_file_name || req.body.pdfFileName),
      page_count: cleanInteger(req.body.page_count ?? req.body.pageCount, 0),
      access_rule: cleanText(req.body.access_rule || req.body.accessRule),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .update(payload)
      .eq('id', productId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Product not found' })
    }

    return res.status(200).json({
      ok: true,
      message: 'Product updated',
      product: publicProduct(data),
    })
  } catch (error) {
    console.error('UPDATE MY AUTHOR STORE PRODUCT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update product', error: error.message })
  }
}

export async function deleteMyAuthorStoreProduct(req, res) {
  try {
    const userId = req.user?.user_id
    const productId = req.params.productId

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!productId) {
      return res.status(400).json({ ok: false, message: 'Product ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .delete()
      .eq('id', productId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Product not found' })
    }

    return res.status(200).json({
      ok: true,
      message: 'Product deleted',
      product_id: productId,
    })
  } catch (error) {
    console.error('DELETE MY AUTHOR STORE PRODUCT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete product', error: error.message })
  }
}

const PAYWAY_HASH_ORDER = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'items',
  'first_name',
  'last_name',
  'email',
  'phone',
  'purchase_type',
  'payment_option',
  'callback_url',
  'return_deeplink',
  'currency',
  'custom_fields',
  'return_params',
  'payout',
  'lifetime',
  'qr_image_template',
]

const AUTHOR_STORE_DELIVERY_FEE_USD = 2
const AUTHOR_STORE_PLATFORM_FEE_RATE = 0.10

function calculateAuthorStoreIncome(amount) {
  const gross = Number(amount || 0)
  const platformFee = Number((gross * AUTHOR_STORE_PLATFORM_FEE_RATE).toFixed(2))
  const authorIncome = Number((gross - platformFee).toFixed(2))

  return {
    platform_fee_rate: AUTHOR_STORE_PLATFORM_FEE_RATE,
    platform_fee_usd: platformFee,
    author_income_usd: authorIncome,
  }
}
const AUTHOR_STORE_ADMIN_STATUSES = ['under_review', 'confirmed', 'preparing', 'shipped', 'completed', 'cancelled', 'rejected']

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function formatUsd(value) {
  return Number(value || 0).toFixed(2)
}

function getUtcReqTime() {
  const date = new Date()
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')

  return `${year}${month}${day}${hour}${minute}${second}`
}

function base64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64')
}

function createAuthorStorePaymentOrderId() {
  const time = Date.now().toString(36).toUpperCase()
  const random = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `A${time}${random}`.slice(0, 20)
}

function getPayWayQrUrl() {
  const directUrl = process.env.ABA_PAYWAY_QR_URL || ''
  if (directUrl) return directUrl

  const mode = String(process.env.ABA_PAYWAY_MODE || 'sandbox').toLowerCase()

  if (mode === 'production' || mode === 'live') {
    return process.env.ABA_PAYWAY_PRODUCTION_QR_URL || 'https://checkout.payway.com.kh/api/payment-gateway/v1/payments/generate-qr'
  }

  return process.env.ABA_PAYWAY_SANDBOX_QR_URL || 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr'
}

function createPayWayHash(payload) {
  const apiKey = process.env.ABA_PAYWAY_API_KEY || ''
  if (!apiKey) return ''

  const raw = PAYWAY_HASH_ORDER.map((field) => payload[field] ?? '').join('')
  return crypto.createHmac('sha512', apiKey).update(raw).digest('base64')
}

function parseReturnParams(value) {
  if (!value) return {}

  try {
    return JSON.parse(String(value))
  } catch {}

  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'))
  } catch {}

  return {}
}

function getCallbackOrderId(body) {
  const returnParams = parseReturnParams(body.return_params)
  return String(body.merchant_ref || body.tran_id || body.transaction_id || returnParams.order_id || '').trim()
}

function isApprovedCallback(body) {
  const status = String(body.status ?? body?.status?.code ?? '').trim().toLowerCase()
  const paymentStatus = String(body.payment_status || '').trim().toLowerCase()
  const paymentStatusCode = String(body.payment_status_code ?? '').trim().toLowerCase()

  return status === '0' || status === '00' || paymentStatusCode === '0' || paymentStatusCode === '00' || paymentStatus === 'approved'
}

function callbackAmountMatches(order, body) {
  const callbackAmount = body.payment_amount ?? body.original_amount ?? body.amount
  const callbackCurrency = body.payment_currency || body.original_currency || body.currency

  if (callbackAmount === undefined || callbackAmount === null || callbackAmount === '') return true
  if (callbackCurrency && String(callbackCurrency).toUpperCase() !== String(order.currency || 'USD').toUpperCase()) return false

  return Number(callbackAmount).toFixed(2) === Number(order.total_usd).toFixed(2)
}

function extractQrResponse(data) {
  const source = data?.data || data || {}

  return {
    qr_string: source.qrString || source.qr_string || source.khqr || source.qr || '',
    qr_image: source.qrImage || source.qr_image || '',
    deeplink: source.abapay_deeplink || source.deeplink || '',
    checkout_url: source.checkout_url || source.payment_url || source.url || '',
    aba_transaction_id: source.transaction_id || source.tran_id || '',
    raw: data || {},
  }
}

function publicAuthorPaymentOrder(order) {
  return {
    id: order.id,
    author_page_id: order.author_page_id,
    buyer_id: order.buyer_id,
    order_id: order.order_id,
    order_number: order.order_number || order.order_id,
    aba_transaction_id: order.aba_transaction_id || '',
    items: order.items || [],
    buyer_profile: order.buyer_profile || {},
    delivery_company: order.delivery_company || {},
    subtotal_usd: Number(order.subtotal_usd || order.subtotal || 0),
    delivery_fee_usd: Number(order.delivery_fee_usd || order.delivery_fee || 0),
    total_usd: Number(order.total_usd || order.total_amount || 0),
    currency: order.currency || 'USD',
    qr_string: order.qr_string || '',
    qr_image: order.qr_image || '',
    checkout_url: order.checkout_url || '',
    deeplink: order.deeplink || '',
    status: order.status || order.order_status || 'waiting_payment',
    payment_status: order.payment_status || 'pending',
    order_status: order.order_status || order.status || 'waiting_payment',
    created_at: order.created_at,
    expires_at: order.expires_at,
    paid_at: order.paid_at,
    updated_at: order.updated_at,
  }
}

async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, username')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getBuyerProfileForAuthorStore(userId) {
  const { data, error } = await supabase
    .from('shadow_mall_buyer_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

function buildAuthorStorePayWayPayload({ orderId, amount, user, phone, payItems }) {
  const callbackUrl =
    process.env.ABA_PAYWAY_AUTHOR_STORE_CALLBACK_URL ||
    'https://shadow-backend-kucw.onrender.com/api/author-store/orders/callback'

  const returnParams = JSON.stringify({ order_id: orderId, type: 'author_store_order' })
  const lifetime = Number(process.env.ABA_PAYWAY_LIFETIME || 3)

  const payload = {
    req_time: getUtcReqTime(),
    merchant_id: process.env.ABA_PAYWAY_MERCHANT_ID || '',
    tran_id: orderId,
    amount,
    items: base64(JSON.stringify(payItems)),
    first_name: String(user?.name || 'Shadow').slice(0, 50),
    last_name: 'Author',
    email: String(user?.email || 'support@shadowerabook.site'),
    phone: String(phone || process.env.ABA_PAYWAY_DEFAULT_PHONE || '012345678'),
    purchase_type: 'purchase',
    payment_option: process.env.ABA_PAYWAY_PAYMENT_OPTION || 'abapay_khqr',
    callback_url: base64(callbackUrl),
    currency: process.env.ABA_PAYWAY_CURRENCY || 'USD',
    return_params: returnParams,
    lifetime: Math.max(3, lifetime),
    qr_image_template: process.env.ABA_PAYWAY_QR_TEMPLATE || 'template3_color',
  }

  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ''))
}

async function callPayWayGenerateQr(payload) {
  const qrUrl = getPayWayQrUrl()
  const hash = createPayWayHash(payload)

  if (!payload.merchant_id || !process.env.ABA_PAYWAY_API_KEY) {
    return {
      configured: false,
      qr_string: '',
      qr_image: '',
      deeplink: '',
      checkout_url: '',
      aba_transaction_id: '',
      raw: { message: 'ABA PayWay QR API is not configured' },
    }
  }

  const response = await fetch(qrUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, hash }),
  })

  const text = await response.text()
  let data = {}

  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || 'ABA PayWay QR generation failed')
  }

  return {
    configured: true,
    ...extractQrResponse(data),
  }
}

function createAuthorCartSignature(orderItems, deliveryCompany, authorPageId) {
  const items = [...orderItems]
    .map((item) => ({
      product_id: String(item.product_id),
      quantity: Number(item.quantity || 1),
    }))
    .sort((a, b) => String(a.product_id).localeCompare(String(b.product_id)))

  const payload = {
    author_page_id: authorPageId,
    items,
    delivery_company_key: deliveryCompany?.key || deliveryCompany?.shortName || deliveryCompany?.name || '',
  }

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function buildAuthorStoreOrderItems(cartItems) {
  const cleanItems = Array.isArray(cartItems)
    ? cartItems
        .map((item) => ({
          product_id: String(item.id || item.product_id || item.productId || '').trim(),
          quantity: Math.max(1, Math.min(Number(item.quantity || 1), 99)),
        }))
        .filter((item) => item.product_id)
    : []

  if (!cleanItems.length) {
    throw new Error('Cart is empty')
  }

  const ids = cleanItems.map((item) => item.product_id)

  const { data: products, error } = await supabase
    .from('author_store_products')
    .select('id, author_page_id, user_id, product_type, title, cover_url, sale_price, original_price, status, stock_quantity, pre_order')
    .in('id', ids)

  if (error) throw error

  const productMap = new Map((products || []).map((product) => [String(product.id), product]))
  let authorPageId = null

  const orderItems = cleanItems.map((item) => {
    const product = productMap.get(String(item.product_id))

    if (!product || product.status !== 'active') {
      throw new Error('Some books are no longer available')
    }

    if (!authorPageId) authorPageId = product.author_page_id

    if (String(product.author_page_id) !== String(authorPageId)) {
      throw new Error('Please checkout one author store at a time')
    }

    const quantityAvailable = Number(product.stock_quantity || 0)

    if (!product.pre_order && quantityAvailable <= 0) {
      throw new Error(`${product.title} is sold out`)
    }

    if (!product.pre_order && quantityAvailable > 0 && item.quantity > quantityAvailable) {
      throw new Error(`${product.title} has only ${quantityAvailable} in stock`)
    }

    const unitPrice = Number(product.sale_price || product.original_price || 0)
const itemTotal = Number((unitPrice * item.quantity).toFixed(2))
const itemIncome = calculateAuthorStoreIncome(itemTotal)

return {
  product_id: product.id,
  author_page_id: product.author_page_id,
  seller_user_id: product.user_id,
  title: product.title,
  product_title: product.title,
  product_type: product.product_type || 'book',
  cover_url: product.cover_url || '',
  quantity: item.quantity,
  unit_price_usd: unitPrice,
  total_usd: itemTotal,
  platform_fee_rate: itemIncome.platform_fee_rate,
  platform_fee_usd: itemIncome.platform_fee_usd,
  author_income_usd: itemIncome.author_income_usd,
}
  })

  return {
    authorPageId,
    orderItems,
  }
}

export async function deductAuthorStoreOrderStock(order) {
  const items = Array.isArray(order?.items) ? order.items : []

  for (const item of items) {
    const productId = item.product_id
    const quantity = Math.max(1, Number(item.quantity || 1))

    if (!productId || !quantity) continue

    const { data: product, error: productError } = await supabase
      .from('author_store_products')
      .select('id, stock_quantity, pre_order')
      .eq('id', productId)
      .maybeSingle()

    if (productError) throw productError
    if (!product) continue
    if (product.pre_order) continue

    const currentQuantity = Math.max(0, Number(product.stock_quantity || 0))
    const nextQuantity = Math.max(0, currentQuantity - quantity)

    const payload = {
      stock_quantity: nextQuantity,
      updated_at: new Date().toISOString(),
    }

    if (nextQuantity <= 0) {
      payload.status = 'hidden'
    }

    const { error: updateError } = await supabase
      .from('author_store_products')
      .update(payload)
      .eq('id', productId)

    if (updateError) throw updateError
  }
}

export async function unlockAuthorStorePdfDownloads(order) {
  const items = Array.isArray(order?.items) ? order.items : []
  const pdfItems = items.filter((item) => {
    const type = String(item.product_type || item.type || '').toLowerCase()
    return type === 'pdf'
  })

  if (!order?.buyer_id || !pdfItems.length) return []

  const productIds = pdfItems
    .map((item) => item.product_id)
    .filter(Boolean)

  if (!productIds.length) return []

  const { data: products, error: productsError } = await supabase
    .from('author_store_products')
    .select('id, author_page_id, title, cover_url, pdf_file_url, pdf_file_name, access_rule')
    .in('id', productIds)

  if (productsError) throw productsError

  const productMap = new Map((products || []).map((product) => [String(product.id), product]))

  const payload = pdfItems
    .map((item) => {
      const product = productMap.get(String(item.product_id))
      if (!product?.pdf_file_url) return null

      return {
        buyer_id: order.buyer_id,
        author_page_id: product.author_page_id || item.author_page_id || order.author_page_id || null,
        product_id: product.id,
        order_id: order.id,
        order_number: order.order_id || order.order_number || '',
        title: product.title || item.title || item.product_title || '',
        cover_url: product.cover_url || item.cover_url || '',
        pdf_file_url: product.pdf_file_url,
        pdf_file_name: product.pdf_file_name || `${product.title || 'download'}.pdf`,
        access_rule: product.access_rule || 'download',
      }
    })
    .filter(Boolean)

  if (!payload.length) return []

  const { data, error } = await supabase
    .from('author_store_reader_downloads')
    .upsert(payload, { onConflict: 'buyer_id,product_id' })
    .select('*')

  if (error) throw error

  return data || []
}

function publicOrder(order) {
  return {
    id: order.id,
    author_page_id: order.author_page_id,
    buyer_id: order.buyer_id,
    order_number: order.order_number,
    buyer_name: order.buyer_name || '',
    buyer_phone: order.buyer_phone || '',
    buyer_email: order.buyer_email || '',
    delivery_address: order.delivery_address || '',
    subtotal: Number(order.subtotal || 0),
delivery_fee: Number(order.delivery_fee || 0),
total_amount: Number(order.total_amount || 0),
product_subtotal_usd: Number(order.product_subtotal_usd || order.subtotal || 0),
platform_fee_rate: Number(order.platform_fee_rate || 0.10),
platform_fee_usd: Number(order.platform_fee_usd || 0),
author_income_usd: Number(order.author_income_usd || 0),
    payment_status: order.payment_status || 'pending',
    order_status: order.order_status || 'pending',
    note: order.note || '',
    created_at: order.created_at,
    updated_at: order.updated_at,
    items: Array.isArray(order.items)
      ? order.items.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_title: item.product_title || '',
          product_type: item.product_type || 'book',
          cover_url: item.cover_url || '',
          quantity: Number(item.quantity || 1),
          unit_price: Number(item.unit_price || 0),
total_price: Number(item.total_price || 0),
platform_fee_rate: Number(item.platform_fee_rate || 0.10),
platform_fee_usd: Number(item.platform_fee_usd || 0),
author_income_usd: Number(item.author_income_usd || 0),
        }))
      : [],
  }
}

export async function getMyAuthorStoreOrders(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: orders, error } = await supabase
      .from('author_store_orders')
      .select('*, items:author_store_order_items(*)')
      .eq('author_page_id', authorPage.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    const safeOrders = (orders || []).map(publicOrder)
    const grossRevenue = safeOrders
  .filter((order) => order.payment_status === 'paid')
  .reduce((sum, order) => sum + Number(order.product_subtotal_usd || order.subtotal || 0), 0)

const platformFee = safeOrders
  .filter((order) => order.payment_status === 'paid')
  .reduce((sum, order) => sum + Number(order.platform_fee_usd || 0), 0)

const authorIncome = safeOrders
  .filter((order) => order.payment_status === 'paid')
  .reduce((sum, order) => sum + Number(order.author_income_usd || 0), 0)

    return res.status(200).json({
      ok: true,
      summary: {
  orders_count: safeOrders.length,
  revenue: authorIncome,
  gross_revenue: grossRevenue,
  platform_fee: platformFee,
  author_income: authorIncome,
},
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE ORDERS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store orders', error: error.message })
  }
}

export async function createAuthorStoreOrder(req, res) {
  try {
    const buyerId = req.user?.user_id || null
    const pageUsername = normalizePageUsername(req.body.page_username || req.body.pageUsername)
    const items = Array.isArray(req.body.items) ? req.body.items : []

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    if (!items.length) {
      return res.status(400).json({ ok: false, message: 'Order items are required' })
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

    const productIds = items.map((item) => item.product_id || item.productId).filter(Boolean)

    const { data: products, error: productsError } = await supabase
      .from('author_store_products')
      .select('*')
      .in('id', productIds)
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')

    if (productsError) throw productsError

    const productMap = new Map((products || []).map((product) => [product.id, product]))
    const orderItems = []

    for (const item of items) {
      const productId = item.product_id || item.productId
      const product = productMap.get(productId)

      if (!product) {
        return res.status(400).json({ ok: false, message: 'Invalid product in order' })
      }

      const quantity = Math.max(1, cleanInteger(item.quantity, 1))
      const unitPrice = Number(product.sale_price || product.original_price || 0)

      orderItems.push({
        product_id: product.id,
        product_title: product.title || '',
        product_type: product.product_type || 'book',
        cover_url: product.cover_url || '',
        quantity,
        unit_price: unitPrice,
        total_price: unitPrice * quantity,
      })
    }

    const subtotal = orderItems.reduce((sum, item) => sum + item.total_price, 0)
    const deliveryFee = cleanNumber(req.body.delivery_fee ?? req.body.deliveryFee, 0)
    const totalAmount = subtotal + deliveryFee
    const orderNumber = `AS-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`

    const { data: order, error: orderError } = await supabase
      .from('author_store_orders')
      .insert({
        author_page_id: authorPage.id,
        buyer_id: buyerId,
        order_number: orderNumber,
        buyer_name: cleanText(req.body.buyer_name || req.body.buyerName),
        buyer_phone: cleanText(req.body.buyer_phone || req.body.buyerPhone),
        buyer_email: cleanText(req.body.buyer_email || req.body.buyerEmail),
        delivery_address: cleanText(req.body.delivery_address || req.body.deliveryAddress),
        subtotal: subtotal,
        delivery_fee: deliveryFee,
        total_amount: totalAmount,
        payment_status: 'pending',
        order_status: 'pending',
        note: cleanText(req.body.note),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (orderError) throw orderError

    const { data: createdItems, error: itemsError } = await supabase
      .from('author_store_order_items')
      .insert(orderItems.map((item) => ({ ...item, order_id: order.id })))
      .select()

    if (itemsError) throw itemsError

    return res.status(201).json({
      ok: true,
      message: 'Order created',
      order: publicOrder({ ...order, items: createdItems || [] }),
    })
  } catch (error) {
    console.error('CREATE AUTHOR STORE ORDER ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create order', error: error.message })
  }
}


export async function createAuthorStoreOrderPayment(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    const user = await getUserProfile(userId)
    const buyerProfile = await getBuyerProfileForAuthorStore(userId)

    if (!buyerProfile?.phone_number || !buyerProfile?.delivery_address) {
      return res.status(400).json({ ok: false, message: 'Buyer profile is required before payment' })
    }

    const { authorPageId, orderItems } = await buildAuthorStoreOrderItems(req.body.items)
    const subtotal = Number(orderItems.reduce((total, item) => total + item.total_usd, 0).toFixed(2))
    const deliveryFee = AUTHOR_STORE_DELIVERY_FEE_USD
    const total = Number((subtotal + deliveryFee).toFixed(2))
    const income = calculateAuthorStoreIncome(subtotal)

    const deliveryCompany = req.body.delivery_company || {
      key: 'jnt',
      name: 'J&T Express',
      shortName: 'J&T',
    }

    const cartSignature = createAuthorCartSignature(orderItems, deliveryCompany, authorPageId)
    const activeWindowStart = new Date(Date.now() - 20 * 60 * 1000).toISOString()

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('author_store_orders')
      .select('*')
      .eq('buyer_id', userId)
      .eq('status', 'waiting_payment')
      .eq('cart_signature', cartSignature)
      .gte('created_at', activeWindowStart)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (currentOrderError) throw currentOrderError

    if (currentOrder) {
      return res.status(200).json({
        ok: true,
        reused: true,
        order: publicAuthorPaymentOrder(currentOrder),
      })
    }

    const orderId = createAuthorStorePaymentOrderId()

    const payItems = [
      ...orderItems.map((item) => ({
        name: item.title,
        quantity: item.quantity,
        price: item.unit_price_usd,
      })),
      {
        name: `${deliveryCompany.shortName || deliveryCompany.name || 'Delivery'} delivery fee`,
        quantity: 1,
        price: deliveryFee,
      },
    ]

    const amount = formatUsd(total)
    const payload = buildAuthorStorePayWayPayload({
      orderId,
      amount,
      user,
      phone: buyerProfile.phone_number,
      payItems,
    })

    const aba = await callPayWayGenerateQr(payload)
    const expiresAt = new Date(Date.now() + Number(payload.lifetime) * 60 * 1000).toISOString()

    const { data: order, error: orderError } = await supabase
      .from('author_store_orders')
      .insert({
        author_page_id: authorPageId,
        buyer_id: userId,
        order_id: orderId,
        order_number: orderId,
        cart_signature: cartSignature,
        aba_transaction_id: aba.aba_transaction_id || null,
        items: orderItems,
        buyer_profile: {
          name: user?.name || user?.username || '',
          phone_number: buyerProfile.phone_number,
          telegram_username: buyerProfile.telegram_username || '',
          facebook_link: buyerProfile.facebook_link || '',
          province_city: buyerProfile.province_city,
          delivery_address: buyerProfile.delivery_address,
          delivery_note: buyerProfile.delivery_note || '',
        },
        delivery_company: deliveryCompany,
        buyer_name: user?.name || user?.username || '',
        buyer_phone: buyerProfile.phone_number,
        buyer_email: user?.email || '',
        delivery_address: buyerProfile.delivery_address,
        subtotal,
        delivery_fee: deliveryFee,
        total_amount: total,
        subtotal_usd: subtotal,
        delivery_fee_usd: deliveryFee,
        total_usd: total,
        product_subtotal_usd: subtotal,
        platform_fee_rate: income.platform_fee_rate,
        platform_fee_usd: income.platform_fee_usd,
        author_income_usd: income.author_income_usd,
        currency: payload.currency,
        qr_string: aba.qr_string || null,
        qr_image: aba.qr_image || null,
        checkout_url: aba.checkout_url || null,
        deeplink: aba.deeplink || null,
        status: 'waiting_payment',
        payment_status: 'pending',
        order_status: 'waiting_payment',
        note: buyerProfile.delivery_note || '',
        request_payload: payload,
        aba_payload: aba.raw || {},
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (orderError) throw orderError

    await supabase
  .from('author_store_order_items')
  .insert(orderItems.map((item) => ({
    order_id: order.id,
    product_id: item.product_id,
    product_title: item.product_title,
    product_type: item.product_type,
    cover_url: item.cover_url,
    quantity: item.quantity,
    unit_price: item.unit_price_usd,
    total_price: item.total_usd,
    platform_fee_rate: item.platform_fee_rate,
    platform_fee_usd: item.platform_fee_usd,
    author_income_usd: item.author_income_usd,
  })))

    return res.status(201).json({
      ok: true,
      configured: aba.configured,
      order: publicAuthorPaymentOrder(order),
    })
  } catch (error) {
    console.error('CREATE AUTHOR STORE ORDER PAYMENT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to create Author Store payment',
    })
  }
}

export async function getAuthorStoreOrderStatus(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(req.params.orderId || '').trim()

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    const { data, error } = await supabase
      .from('author_store_orders')
      .select('*')
      .eq('order_id', orderId)
      .eq('buyer_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Author Store order not found' })

    return res.status(200).json({ ok: true, order: publicAuthorPaymentOrder(data) })
  } catch (error) {
    console.error('GET AUTHOR STORE ORDER STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Author Store order status' })
  }
}

export async function getMyAuthorStoreBuyerOrders(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    const { data, error } = await supabase
      .from('author_store_orders')
      .select('*')
      .eq('buyer_id', userId)
      .in('status', AUTHOR_STORE_READER_STATUSES)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      orders: (data || []).map(publicAuthorPaymentOrder),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE BUYER ORDERS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Author Store orders' })
  }
}

export async function getAdminAuthorStoreOrders(req, res) {
  try {
    const page = Math.max(Number(req.query.page || 1), 1)
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100)
    const status = String(req.query.status || 'under_review').trim()
    const q = String(req.query.q || '').trim()
    const from = (page - 1) * limit
    const to = from + limit - 1

    const adminHistoryWindowStart = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()

    let query = supabase
      .from('author_store_orders')
      .select('*', { count: 'exact' })
      .gte('created_at', adminHistoryWindowStart)

    if (status === 'all') {
      query = query
        .neq('status', 'waiting_payment')
        .neq('status', 'expired')
    } else if (AUTHOR_STORE_ADMIN_STATUSES.includes(status)) {
      query = query.eq('status', status)
    } else {
      query = query.eq('status', 'under_review')
    }

    if (q) {
      query = query.or(`order_id.ilike.%${q}%,order_number.ilike.%${q}%,aba_transaction_id.ilike.%${q}%`)
    }

    const { data, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      orders: (data || []).map(publicAuthorPaymentOrder),
      page,
      limit,
      total: count || 0,
      total_pages: Math.max(Math.ceil((count || 0) / limit), 1),
      has_next: to + 1 < (count || 0),
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET ADMIN AUTHOR STORE ORDERS ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to load Author Store orders' })
  }
}

export async function updateAdminAuthorStoreOrderStatus(req, res) {
  try {
    const orderId = String(req.params.orderId || '').trim()
    const status = String(req.body.status || '').trim()

    if (!AUTHOR_STORE_ADMIN_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid order status' })
    }

    const { data, error } = await supabase
      .from('author_store_orders')
      .update({
        status,
        order_status: status,
        payment_status: status === 'confirmed' ? 'paid' : undefined,
        admin_note: req.body.admin_note || null,
        updated_at: new Date().toISOString(),
      })
      .eq('order_id', orderId)
      .select('*')
      .single()

    if (error) throw error

    if (status === 'confirmed') {
      await deductAuthorStoreOrderStock(data)
      await unlockAuthorStorePdfDownloads(data)
    }

    return res.status(200).json({
      ok: true,
      order: publicAuthorPaymentOrder(data),
    })
  } catch (error) {
    console.error('UPDATE ADMIN AUTHOR STORE ORDER STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update Author Store order' })
  }
}

export async function handleAuthorStoreAbaCallback(req, res) {
  try {
    const orderId = getCallbackOrderId(req.body)

    if (!orderId) return res.status(400).json({ ok: false, message: 'Missing order id' })

    const { data: order, error: orderError } = await supabase
      .from('author_store_orders')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle()

    if (orderError) throw orderError
    if (!order) return res.status(404).json({ ok: false, message: 'Author Store order not found' })

    await supabase.from('author_store_order_callbacks').insert({
      order_id: orderId,
      payload: req.body,
      status_detected: isApprovedCallback(req.body) ? 'approved' : 'not_approved',
    })

    if (!isApprovedCallback(req.body)) {
      await supabase
        .from('author_store_orders')
        .update({ callback_payload: req.body, updated_at: new Date().toISOString() })
        .eq('id', order.id)

      return res.status(200).json({ ok: true })
    }

    if (!callbackAmountMatches(order, req.body)) {
      await supabase
        .from('author_store_orders')
        .update({
          status: 'amount_mismatch',
          order_status: 'amount_mismatch',
          callback_payload: req.body,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id)

      return res.status(200).json({ ok: true })
    }

    if (order.status !== 'waiting_payment') return res.status(200).json({ ok: true })

    const { data: updatedOrder, error: updateError } = await supabase
      .from('author_store_orders')
      .update({
        status: 'under_review',
        order_status: 'under_review',
        payment_status: 'paid',
        aba_transaction_id: req.body.transaction_id || req.body.tran_id || order.aba_transaction_id || null,
        callback_payload: req.body,
        paid_at: req.body.transaction_date ? new Date(req.body.transaction_date).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id)
      .eq('status', 'waiting_payment')
      .select('*')
      .single()

    if (updateError) throw updateError

    await deductAuthorStoreOrderStock(updatedOrder)

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('AUTHOR STORE ABA CALLBACK ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to process Author Store ABA callback' })
  }
}

const DEFAULT_AUTHOR_STORE_CATEGORIES = [
  'New Books',
  'PDF Books',
  'Pre-order',
  'Best Seller',
  'Second Hand',
  'Author Picks',
  'Sold out',
]

function publicCategory(category) {
  return {
    id: category.id,
    author_page_id: category.author_page_id,
    user_id: category.user_id,
    name: category.name || '',
    sort_order: Number(category.sort_order || 0),
    is_default: Boolean(category.is_default),
    is_hidden: Boolean(category.is_hidden),
    created_at: category.created_at,
    updated_at: category.updated_at,
  }
}

async function ensureDefaultAuthorStoreCategories(authorPage, userId) {
  const { count, error: countError } = await supabase
    .from('author_store_categories')
    .select('id', { count: 'exact', head: true })
    .eq('author_page_id', authorPage.id)

  if (countError) throw countError

  if (Number(count || 0) > 0) return

  const rows = DEFAULT_AUTHOR_STORE_CATEGORIES.map((name, index) => ({
    author_page_id: authorPage.id,
    user_id: userId,
    name,
    sort_order: index,
    is_default: true,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('author_store_categories')
    .insert(rows)

  if (error) throw error
}

export async function getMyAuthorStoreCategories(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    await ensureDefaultAuthorStoreCategories(authorPage, userId)

    const { data, error } = await supabase
      .from('author_store_categories')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      categories: (data || []).map(publicCategory),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE CATEGORIES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store categories', error: error.message })
  }
}

export async function createMyAuthorStoreCategory(req, res) {
  try {
    const userId = req.user?.user_id
    const name = cleanText(req.body.name)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!name) {
      return res.status(400).json({ ok: false, message: 'Category name is required' })
    }

    if (name.length > 40) {
      return res.status(400).json({ ok: false, message: 'Category name is too long' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: existing, error: existingError } = await supabase
      .from('author_store_categories')
      .select('id')
      .eq('author_page_id', authorPage.id)
      .ilike('name', name)
      .maybeSingle()

    if (existingError) throw existingError

    if (existing) {
      return res.status(409).json({ ok: false, message: 'Category already exists' })
    }

    const { count: customCount, error: customCountError } = await supabase
  .from('author_store_categories')
  .select('id', { count: 'exact', head: true })
  .eq('author_page_id', authorPage.id)
  .eq('is_default', false)

if (customCountError) throw customCountError

if (Number(customCount || 0) >= 5) {
  return res.status(400).json({ ok: false, message: 'You can create up to 5 custom categories only.' })
}


const { data: lastCategory, error: lastError } = await supabase
  .from('author_store_categories')
  .select('sort_order')
  .eq('author_page_id', authorPage.id)
  .order('sort_order', { ascending: false })
  .limit(1)
  .maybeSingle()
    
    if (lastError) throw lastError

    const nextSortOrder = Number(lastCategory?.sort_order || 0) + 1

    const { data, error } = await supabase
      .from('author_store_categories')
      .insert({
        author_page_id: authorPage.id,
        user_id: userId,
        name,
        sort_order: nextSortOrder,
        is_default: false,
        is_hidden: false,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      message: 'Category created',
      category: publicCategory(data),
    })
  } catch (error) {
    console.error('CREATE MY AUTHOR STORE CATEGORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create store category', error: error.message })
  }
}

export async function updateMyAuthorStoreCategory(req, res) {
  try {
    const userId = req.user?.user_id
    const categoryId = req.params.categoryId
    const name = cleanText(req.body.name)
    const isHidden = typeof req.body.is_hidden === 'boolean'
      ? req.body.is_hidden
      : typeof req.body.isHidden === 'boolean'
        ? req.body.isHidden
        : null

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!categoryId) {
      return res.status(400).json({ ok: false, message: 'Category ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: currentCategory, error: currentError } = await supabase
  .from('author_store_categories')
  .select('name, is_default')
      .eq('id', categoryId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!currentCategory) {
      return res.status(404).json({ ok: false, message: 'Category not found' })
    }

    const isSoldOutSystem = currentCategory.name === 'Sold out'

    if (isSoldOutSystem && name && name !== 'Sold out') {
      return res.status(403).json({ ok: false, message: 'Sold out category cannot be renamed' })
    }

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (!isSoldOutSystem && name) {
      if (name.length > 40) {
        return res.status(400).json({ ok: false, message: 'Category name is too long' })
      }

      const { data: existing, error: existingError } = await supabase
        .from('author_store_categories')
        .select('id')
        .eq('author_page_id', authorPage.id)
        .ilike('name', name)
        .neq('id', categoryId)
        .maybeSingle()

      if (existingError) throw existingError

      if (existing) {
        return res.status(409).json({ ok: false, message: 'Category already exists' })
      }

      updates.name = name
    }

    if (isHidden !== null) {
      updates.is_hidden = isHidden
    }

    const { data, error } = await supabase
      .from('author_store_categories')
      .update(updates)
      .eq('id', categoryId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select()
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Category updated',
      category: publicCategory(data),
    })
  } catch (error) {
    console.error('UPDATE MY AUTHOR STORE CATEGORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update store category', error: error.message })
  }
}

export async function deleteMyAuthorStoreCategory(req, res) {
  try {
    const userId = req.user?.user_id
    const categoryId = req.params.categoryId

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!categoryId) {
      return res.status(400).json({ ok: false, message: 'Category ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: currentCategory, error: currentError } = await supabase
  .from('author_store_categories')
  .select('name')
  .eq('id', categoryId)
  .eq('author_page_id', authorPage.id)
  .eq('user_id', userId)
  .maybeSingle()

if (currentError) throw currentError

if (!currentCategory) {
  return res.status(404).json({ ok: false, message: 'Category not found' })
}

if (currentCategory.is_default) {
  return res.status(403).json({ ok: false, message: 'System category cannot be deleted' })
}
    const { data, error } = await supabase
      .from('author_store_categories')
      .delete()
      .eq('id', categoryId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Category not found' })
    }

    return res.status(200).json({
      ok: true,
      message: 'Category deleted',
      category_id: categoryId,
    })
  } catch (error) {
    console.error('DELETE MY AUTHOR STORE CATEGORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete store category', error: error.message })
  }
}

export async function reorderMyAuthorStoreCategories(req, res) {
  try {
    const userId = req.user?.user_id
    const categoryIds = Array.isArray(req.body.category_ids)
      ? req.body.category_ids
      : Array.isArray(req.body.categoryIds)
        ? req.body.categoryIds
        : []

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!categoryIds.length) {
      return res.status(400).json({ ok: false, message: 'Category order is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    for (let index = 0; index < categoryIds.length; index += 1) {
      const { error } = await supabase
        .from('author_store_categories')
        .update({
          sort_order: index,
          updated_at: new Date().toISOString(),
        })
        .eq('id', categoryIds[index])
        .eq('author_page_id', authorPage.id)
        .eq('user_id', userId)

      if (error) throw error
    }

    const { data, error } = await supabase
      .from('author_store_categories')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Categories reordered',
      categories: (data || []).map(publicCategory),
    })
  } catch (error) {
    console.error('REORDER MY AUTHOR STORE CATEGORIES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to reorder store categories', error: error.message })
  }
}
