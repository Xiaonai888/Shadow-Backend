import { supabase } from '../config/supabase.js'
import { createAuthorStoryNotificationSafely } from '../services/authorStoryNotifications.service.js'

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getPromotionId(value) {
  const id = Number(value)

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('Invalid promotion id')
    error.statusCode = 400
    throw error
  }

  return id
}

function publicWallet(wallet) {
  return {
    diamond_balance: Number(wallet?.diamond_balance || 0),
    gem_balance: Number(wallet?.gem_balance || 0),
    coin_balance: Number(wallet?.gem_balance || 0),
    voucher_balance: Number(wallet?.voucher_balance || 0),
    story_card_balance: Number(wallet?.story_card_balance || 0),
  }
}

function discountPercent(originalPrice, salePrice) {
  const original = Number(originalPrice || 0)
  const sale = Number(salePrice || 0)

  if (original <= 0 || sale <= 0 || sale > original) {
    return 0
  }

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(((original - sale) / original) * 100)
    )
  )
}

async function getStorySaleContext({
  promotionId,
  userId,
}) {
  const { data: promotion, error: promotionError } =
    await supabase
      .from('shadow_mall_ads')
      .select(
        'id, sponsor, title, description, promotion_type, story_id, original_price_diamonds, sale_price_diamonds, is_active'
      )
      .eq('id', promotionId)
      .maybeSingle()

  if (promotionError) throw promotionError

  if (!promotion) {
    return {
      statusCode: 404,
      code: 'PROMOTION_NOT_FOUND',
      message: 'Promotion not found',
    }
  }

  if (!promotion.is_active) {
    return {
      statusCode: 410,
      code: 'PROMOTION_INACTIVE',
      message: 'This promotion is no longer active',
    }
  }

  if (
    promotion.promotion_type !== 'story_sale' ||
    !promotion.story_id
  ) {
    return {
      statusCode: 400,
      code: 'NOT_STORY_SALE',
      message: 'This promotion does not sell a story',
    }
  }

  const { data: story, error: storyError } =
    await supabase
      .from('stories')
      .select(
        'id, author_id, user_id, title, cover_url, story_language, main_genre, total_episodes, story_status, status, admin_visibility_status, deleted_at'
      )
      .eq('id', promotion.story_id)
      .is('deleted_at', null)
      .maybeSingle()

  if (storyError) throw storyError

  if (
    !story ||
    String(story.admin_visibility_status || 'active') !==
      'active'
  ) {
    return {
      statusCode: 404,
      code: 'STORY_NOT_AVAILABLE',
      message: 'Story is not available',
    }
  }

  const [
    { data: wallet, error: walletError },
    { data: purchase, error: purchaseError },
  ] = await Promise.all([
    supabase
      .from('user_wallets')
      .select(
        'diamond_balance, gem_balance, voucher_balance, story_card_balance'
      )
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('story_purchases')
      .select(
        'id, promotion_id, original_price_diamonds, paid_price_diamonds, discount_percent, purchased_at'
      )
      .eq('user_id', userId)
      .eq('story_id', story.id)
      .eq('purchase_status', 'active')
      .order('purchased_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (walletError) throw walletError
  if (purchaseError) throw purchaseError

  const isStoryOwner =
    String(story.user_id || '') === String(userId || '')
  const owned = isStoryOwner || Boolean(purchase)

  return {
    statusCode: 200,
    promotion,
    story,
    wallet,
    purchase,
    isStoryOwner,
    owned,
  }
}

async function notifyAuthorOfPurchase({
  userId,
  purchaseResult,
}) {
  if (
    purchaseResult?.already_owned ||
    !purchaseResult?.story_id ||
    !purchaseResult?.purchase_id
  ) {
    return
  }

  const [
    { data: story, error: storyError },
    { data: reader, error: readerError },
  ] = await Promise.all([
    supabase
      .from('stories')
      .select('id, author_id, user_id, title')
      .eq('id', purchaseResult.story_id)
      .maybeSingle(),
    supabase
      .from('users')
      .select('id, name, username, avatar_url')
      .eq('id', userId)
      .maybeSingle(),
  ])

  if (storyError) {
    console.error(
      'GET STORY FOR PROMOTION PURCHASE NOTIFICATION ERROR:',
      storyError
    )
  }

  if (readerError) {
    console.error(
      'GET READER FOR PROMOTION PURCHASE NOTIFICATION ERROR:',
      readerError
    )
  }

  if (
    !story?.author_id ||
    String(story.user_id || '') === String(userId || '')
  ) {
    return
  }

  const readerName =
    reader?.name || reader?.username || 'A reader'
  const paidDiamonds = Number(
    purchaseResult.paid_price_diamonds || 0
  )

  await createAuthorStoryNotificationSafely({
    authorId: story.author_id,
    type: 'income',
    title: `${readerName} purchased your story`,
    message: `${paidDiamonds} Diamonds spent on ${
      story.title || 'your story'
    }`,
    targetUrl: `/author/story/${story.id}/manage`,
    sourceKey: `story-purchase:${purchaseResult.purchase_id}`,
    metadata: {
      story_id: story.id,
      purchase_id: purchaseResult.purchase_id,
      promotion_id:
        purchaseResult.promotion_id || null,
      diamond_amount: paidDiamonds,
      reader_id: userId,
      reader_name: readerName,
      reader_username: reader?.username || '',
      reader_avatar_url: reader?.avatar_url || '',
    },
  })
}

export async function getShadowMallStorySaleStatus(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )

    const context = await getStorySaleContext({
      promotionId,
      userId,
    })

    if (context.statusCode !== 200) {
      return res.status(context.statusCode).json({
        ok: false,
        code: context.code,
        message: context.message,
      })
    }

    const originalPrice = Number(
      context.promotion.original_price_diamonds || 0
    )
    const salePrice = Number(
      context.promotion.sale_price_diamonds || 0
    )

    return res.status(200).json({
      ok: true,
      promotion_id: context.promotion.id,
      promotion_type: 'story_sale',
      owned: context.owned,
      purchased: Boolean(context.purchase),
      is_story_owner: context.isStoryOwner,
      button_state: context.owned ? 'read' : 'buy',
      story_url: `/story/${context.story.id}`,
      story: {
        id: context.story.id,
        title: context.story.title || '',
        cover_url: context.story.cover_url || '',
        author_id: context.story.author_id || null,
        story_language:
          context.story.story_language || '',
        main_genre: context.story.main_genre || '',
        total_episodes: Number(
          context.story.total_episodes || 0
        ),
        story_status:
          context.story.story_status || '',
      },
      price: {
        currency: 'diamond',
        original: originalPrice,
        sale: salePrice,
        discount_percent: discountPercent(
          originalPrice,
          salePrice
        ),
      },
      purchase: context.purchase || null,
      wallet: publicWallet(context.wallet),
    })
  } catch (error) {
    console.error(
      'GET SHADOW MALL STORY SALE STATUS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to check story purchase status',
      })
  }
}

export async function purchaseShadowMallStory(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )

    const { data, error } = await supabase.rpc(
      'purchase_promoted_story_with_diamonds',
      {
        p_user_id: userId,
        p_promotion_id: promotionId,
      }
    )

    if (error) throw error

    const result =
      data && typeof data === 'object' ? data : {}

    if (result.ok !== true) {
      const statusByCode = {
        LOGIN_REQUIRED: 401,
        PROMOTION_NOT_FOUND: 404,
        PROMOTION_INACTIVE: 410,
        NOT_STORY_SALE: 400,
        STORY_NOT_AVAILABLE: 404,
        WALLET_NOT_FOUND: 404,
        INVALID_PROMOTION_PRICE: 400,
        INSUFFICIENT_DIAMONDS: 402,
      }

      return res
        .status(statusByCode[result.code] || 400)
        .json(result)
    }

    await notifyAuthorOfPurchase({
      userId,
      purchaseResult: result,
    })

    return res.status(200).json({
      ...result,
      story_url: `/story/${result.story_id}`,
      button_state: 'read',
    })
  } catch (error) {
    console.error(
      'PURCHASE SHADOW MALL STORY ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to purchase story',
      error: error.message,
    })
  }
}
