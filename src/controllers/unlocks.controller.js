import { supabase } from '../config/supabase.js'

const DIAMOND_PRICE_PER_EPISODE = 10
const GEM_PRICE_PER_EPISODE = 1000
const GEM_ACCESS_DAYS = 7

const PACKAGE_RULES = {
  single: {
    key: 'single',
    label: '1 Episode',
    count: 1,
    discount_percent: 0,
    unlock_scope: 'single',
  },
  next10: {
    key: 'next10',
    label: 'Next 10 Eps',
    count: 10,
    discount_percent: 10,
    unlock_scope: 'next10',
  },
  next30: {
    key: 'next30',
    label: 'Next 30 Eps',
    count: 30,
    discount_percent: 20,
    unlock_scope: 'next30',
  },
  next50: {
    key: 'next50',
    label: 'Next 50 Eps',
    count: 50,
    discount_percent: 25,
    unlock_scope: 'next50',
  },
  all_released: {
    key: 'all_released',
    label: 'All Released Episodes',
    count: null,
    discount_percent: 40,
    unlock_scope: 'all_released',
  },
}

function publicWallet(wallet) {
  return {
    diamond_balance: Number(wallet?.diamond_balance || 0),
    gem_balance: Number(wallet?.gem_balance || 0),
    voucher_balance: Number(wallet?.voucher_balance || 0),
    story_card_balance: Number(wallet?.story_card_balance || 0),
    auto_unlock: Boolean(wallet?.auto_unlock),
  }
}

function normalizeStoryStatus(story) {
  return String(story?.story_status || story?.completion_status || story?.novel_status || '').trim().toLowerCase()
}

function isStoryCompleted(story) {
  const status = normalizeStoryStatus(story)
  return status === 'completed' || status === 'complete' || status === 'finished' || status === 'ended'
}

function isEpisodeFree(episode) {
  return !episode?.is_locked || Number(episode?.episode_number || 0) <= 1
}

function calculateDiamondCost(count, discountPercent = 0) {
  const original = Number(count || 0) * DIAMOND_PRICE_PER_EPISODE
  const discount = Math.max(0, Math.min(100, Number(discountPercent || 0)))
  const total = Math.ceil(original * ((100 - discount) / 100))

  return {
    original,
    total,
    discount_percent: discount,
  }
}

function publicPackageOption({ rule, availableEpisodes, story }) {
  const availableCount = availableEpisodes.length
  const requiredCount = rule.key === 'all_released' ? availableCount : Number(rule.count || 0)
  const canUseAllReleased = rule.key !== 'all_released' || availableCount > 70 || isStoryCompleted(story)
  const enabled = availableCount >= requiredCount && requiredCount > 0 && canUseAllReleased
  const cost = calculateDiamondCost(requiredCount, rule.discount_percent)

  return {
    key: rule.key,
    label: rule.label,
    unlock_scope: rule.unlock_scope,
    requested_count: requiredCount,
    available_count: availableCount,
    enabled,
    disabled_reason: enabled
      ? ''
      : rule.key === 'all_released'
        ? 'All Released Episodes works when the story has more than 70 released locked episodes or the story is completed.'
        : `This story does not have ${requiredCount} locked released episodes available from this point.`,
    discount_percent: rule.discount_percent,
    original_price: cost.original,
    price: cost.total,
    currency: 'diamond',
    episode_ids: enabled ? availableEpisodes.slice(0, requiredCount).map((episode) => episode.id) : [],
  }
}

async function getStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getEpisode({ storyId, episodeId }) {
  const { data, error } = await supabase
    .from('episodes')
    .select('id, story_id, author_id, user_id, title, episode_number, is_locked, status')
    .eq('id', episodeId)
    .eq('story_id', storyId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getWallet(userId) {
  const { data: wallet, error } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (wallet) return wallet

  const { data: createdWallet, error: createError } = await supabase
    .from('user_wallets')
    .insert({ user_id: userId })
    .select()
    .single()

  if (createError) throw createError
  return createdWallet
}

async function getActiveUnlock({ userId, episodeId }) {
  const { data, error } = await supabase
    .from('episode_unlocks')
    .select('*')
    .eq('user_id', userId)
    .eq('episode_id', episodeId)
    .eq('unlock_status', 'active')
    .maybeSingle()

  if (error) throw error

  if (data?.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return null
  }

  return data
}

async function getActiveUnlockEpisodeIds({ userId, storyId }) {
  if (!userId || !storyId) return new Set()

  const { data, error } = await supabase
    .from('episode_unlocks')
    .select('episode_id, expires_at')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .eq('unlock_status', 'active')

  if (error) throw error

  return new Set(
    (data || [])
      .filter((item) => !item.expires_at || new Date(item.expires_at).getTime() >= Date.now())
      .map((item) => item.episode_id)
  )
}

async function getAvailableLockedEpisodes({ userId, storyId, fromEpisodeNumber }) {
  const unlockedIds = await getActiveUnlockEpisodeIds({ userId, storyId })

  const { data, error } = await supabase
    .from('episodes')
    .select('id, story_id, author_id, title, episode_number, is_locked, status')
    .eq('story_id', storyId)
    .eq('status', 'published')
    .eq('is_locked', true)
    .gte('episode_number', Number(fromEpisodeNumber || 1))
    .order('episode_number', { ascending: true })

  if (error) throw error

  return (data || [])
    .filter((episode) => Number(episode.episode_number || 0) > 1)
    .filter((episode) => !unlockedIds.has(episode.id))
}

async function getUnlockStatusPayload({ userId, storyId, episodeId }) {
  const [story, episode, wallet] = await Promise.all([
    getStory(storyId),
    getEpisode({ storyId, episodeId }),
    getWallet(userId),
  ])

  if (!story || !episode) {
    return {
      notFound: true,
    }
  }

  const unlock = await getActiveUnlock({ userId, episodeId })
  const freeEpisode = isEpisodeFree(episode)
  const unlocked = freeEpisode || Boolean(unlock)
  const availableEpisodes = await getAvailableLockedEpisodes({
    userId,
    storyId,
    fromEpisodeNumber: episode.episode_number,
  })

  return {
    notFound: false,
    story,
    episode,
    wallet,
    unlock,
    freeEpisode,
    unlocked,
    availableEpisodes,
    packageOptions: [
      publicPackageOption({ rule: PACKAGE_RULES.single, availableEpisodes, story }),
      publicPackageOption({ rule: PACKAGE_RULES.next10, availableEpisodes, story }),
      publicPackageOption({ rule: PACKAGE_RULES.next30, availableEpisodes, story }),
      publicPackageOption({ rule: PACKAGE_RULES.next50, availableEpisodes, story }),
      publicPackageOption({ rule: PACKAGE_RULES.all_released, availableEpisodes, story }),
    ],
  }
}

async function updateDiamondBalance({ userId, wallet, amount }) {
  const nextDiamondBalance = Number(wallet.diamond_balance || 0) - Number(amount || 0)

  const { data, error } = await supabase
    .from('user_wallets')
    .update({
      diamond_balance: nextDiamondBalance,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw error
  return data
}

async function updateGemBalance({ userId, wallet, amount }) {
  const nextGemBalance = Number(wallet.gem_balance || 0) - Number(amount || 0)

  const { data, error } = await supabase
    .from('user_wallets')
    .update({
      gem_balance: nextGemBalance,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw error
  return data
}

async function createUnlocksAndTransactions({ userId, storyId, episodes, unlockType, unlockScope, accessType, expiresAt, diamondSpent, transactionCurrency, transactionAmount, metadata }) {
  if (!episodes.length) return []

  const unlockRows = episodes.map((episode) => ({
    user_id: userId,
    story_id: storyId,
    episode_id: episode.id,
    author_id: episode.author_id,
    unlock_type: unlockType,
    unlock_scope: unlockScope,
    access_type: accessType,
    expires_at: expiresAt,
    diamond_spent: diamondSpent,
    unlock_status: 'active',
  }))

  const { data: unlocks, error: unlockError } = await supabase
    .from('episode_unlocks')
    .upsert(unlockRows, {
      onConflict: 'user_id,episode_id',
    })
    .select()

  if (unlockError) throw unlockError

  const unlockMap = new Map((unlocks || []).map((unlock) => [unlock.episode_id, unlock.id]))

  const transactionRows = episodes.map((episode) => ({
    unlock_id: unlockMap.get(episode.id) || null,
    user_id: userId,
    story_id: storyId,
    episode_id: episode.id,
    author_id: episode.author_id,
    currency: transactionCurrency,
    amount: transactionAmount,
    transaction_type: 'unlock',
    metadata: {
      ...metadata,
      episode_number: episode.episode_number,
      episode_title: episode.title,
    },
  }))

  const { error: transactionError } = await supabase
    .from('episode_unlock_transactions')
    .insert(transactionRows)

  if (transactionError) throw transactionError

  return unlocks || []
}

export async function getEpisodeUnlockStatus(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    return res.status(200).json({
      ok: true,
      locked: !payload.unlocked,
      unlocked: payload.unlocked,
      free_episode: payload.freeEpisode,
      unlock_type: payload.freeEpisode ? 'free' : payload.unlock?.unlock_type || null,
      price: {
        currency: 'diamond',
        amount: DIAMOND_PRICE_PER_EPISODE,
      },
      gem_access: {
        currency: 'gem',
        amount: GEM_PRICE_PER_EPISODE,
        access_days: GEM_ACCESS_DAYS,
      },
      package_options: payload.packageOptions,
      story_unlock_rules: {
        completed: isStoryCompleted(payload.story),
        all_released_minimum_episodes: 70,
      },
      wallet: publicWallet(payload.wallet),
    })
  } catch (error) {
    console.error('GET EPISODE UNLOCK STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to check unlock status',
      error: error.message,
    })
  }
}

export async function unlockEpisodeWithDiamonds(req, res) {
  try {
    const reqWithPackage = {
      ...req,
      body: {
        ...req.body,
        package_key: 'single',
      },
    }

    return unlockEpisodePackageWithDiamonds(reqWithPackage, res)
  } catch (error) {
    console.error('UNLOCK EPISODE WITH DIAMONDS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode',
      error: error.message,
    })
  }
}

export async function unlockEpisodePackageWithDiamonds(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const packageKey = String(req.body.package_key || req.body.packageKey || 'single').trim()
    const rule = PACKAGE_RULES[packageKey]

    if (!rule) {
      return res.status(400).json({
        ok: false,
        message: 'Unlock package is not valid',
      })
    }

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    if (payload.freeEpisode || payload.unlocked) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(payload.wallet),
      })
    }

    const option = payload.packageOptions.find((item) => item.key === packageKey)

    if (!option?.enabled) {
      return res.status(400).json({
        ok: false,
        code: 'PACKAGE_NOT_AVAILABLE',
        message: option?.disabled_reason || 'This package is not available',
        option,
        package_options: payload.packageOptions,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (Number(payload.wallet.diamond_balance || 0) < Number(option.price || 0)) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_DIAMONDS',
        message: 'Not enough Diamonds',
        need: Number(option.price || 0) - Number(payload.wallet.diamond_balance || 0),
        price: Number(option.price || 0),
        option,
        wallet: publicWallet(payload.wallet),
      })
    }

    const episodesToUnlock = payload.availableEpisodes.slice(0, option.requested_count)
    const updatedWallet = await updateDiamondBalance({
      userId,
      wallet: payload.wallet,
      amount: option.price,
    })

    const unlocks = await createUnlocksAndTransactions({
      userId,
      storyId,
      episodes: episodesToUnlock,
      unlockType: 'diamond',
      unlockScope: rule.unlock_scope,
      accessType: 'permanent',
      expiresAt: null,
      diamondSpent: option.price,
      transactionCurrency: 'diamond',
      transactionAmount: option.price,
      metadata: {
        package_key: packageKey,
        package_label: option.label,
        episode_count: episodesToUnlock.length,
        discount_percent: option.discount_percent,
        original_price: option.original_price,
        final_price: option.price,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Episodes unlocked successfully',
      unlocked: true,
      package_key: packageKey,
      unlocked_count: unlocks.length,
      unlocked_episode_ids: unlocks.map((unlock) => unlock.episode_id),
      wallet: publicWallet(updatedWallet),
    })
  } catch (error) {
    console.error('UNLOCK EPISODE PACKAGE WITH DIAMONDS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episodes',
      error: error.message,
    })
  }
}

export async function unlockEpisodeWithGems(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    if (payload.freeEpisode || payload.unlocked) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (Number(payload.wallet.gem_balance || 0) < GEM_PRICE_PER_EPISODE) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_GEMS',
        message: 'Not enough Gems',
        need: GEM_PRICE_PER_EPISODE - Number(payload.wallet.gem_balance || 0),
        price: GEM_PRICE_PER_EPISODE,
        wallet: publicWallet(payload.wallet),
      })
    }

    const expiresAt = new Date(Date.now() + GEM_ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const updatedWallet = await updateGemBalance({
      userId,
      wallet: payload.wallet,
      amount: GEM_PRICE_PER_EPISODE,
    })

    const unlocks = await createUnlocksAndTransactions({
      userId,
      storyId,
      episodes: [payload.episode],
      unlockType: 'gem',
      unlockScope: 'single',
      accessType: 'temporary',
      expiresAt,
      diamondSpent: 0,
      transactionCurrency: 'gem',
      transactionAmount: GEM_PRICE_PER_EPISODE,
      metadata: {
        access_days: GEM_ACCESS_DAYS,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Episode unlocked with Gems',
      unlocked: true,
      access_type: 'temporary',
      expires_at: expiresAt,
      unlocked_episode_ids: unlocks.map((unlock) => unlock.episode_id),
      wallet: publicWallet(updatedWallet),
    })
  } catch (error) {
    console.error('UNLOCK EPISODE WITH GEMS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode with Gems',
      error: error.message,
    })
  }
}
