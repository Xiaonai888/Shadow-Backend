import { supabase } from '../config/supabase.js'

const DIAMOND_PRICE_PER_EPISODE = 10

function publicWallet(wallet) {
  return {
    diamond_balance: Number(wallet?.diamond_balance || 0),
    gem_balance: Number(wallet?.gem_balance || 0),
    voucher_balance: Number(wallet?.voucher_balance || 0),
    story_card_balance: Number(wallet?.story_card_balance || 0),
    auto_unlock: Boolean(wallet?.auto_unlock),
  }
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
  return data
}

function isEpisodeFree(episode) {
  return !episode?.is_locked || Number(episode?.episode_number || 0) <= 1
}

export async function getEpisodeUnlockStatus(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    const episode = await getEpisode({ storyId, episodeId })

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const wallet = await getWallet(userId)
    const unlock = await getActiveUnlock({ userId, episodeId })
    const freeEpisode = isEpisodeFree(episode)
    const unlocked = freeEpisode || Boolean(unlock)

    return res.status(200).json({
      ok: true,
      locked: !unlocked,
      unlocked,
      free_episode: freeEpisode,
      unlock_type: freeEpisode ? 'free' : unlock?.unlock_type || null,
      price: {
        currency: 'diamond',
        amount: DIAMOND_PRICE_PER_EPISODE,
      },
      wallet: publicWallet(wallet),
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
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    const episode = await getEpisode({ storyId, episodeId })

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const wallet = await getWallet(userId)
    const oldUnlock = await getActiveUnlock({ userId, episodeId })
    const freeEpisode = isEpisodeFree(episode)

    if (freeEpisode || oldUnlock) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(wallet),
      })
    }

    if (Number(wallet.diamond_balance || 0) < DIAMOND_PRICE_PER_EPISODE) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_DIAMONDS',
        message: 'Not enough Diamonds',
        need: DIAMOND_PRICE_PER_EPISODE - Number(wallet.diamond_balance || 0),
        price: DIAMOND_PRICE_PER_EPISODE,
        wallet: publicWallet(wallet),
      })
    }

    const nextDiamondBalance = Number(wallet.diamond_balance || 0) - DIAMOND_PRICE_PER_EPISODE

    const { data: updatedWallet, error: walletError } = await supabase
      .from('user_wallets')
      .update({
        diamond_balance: nextDiamondBalance,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select()
      .single()

    if (walletError) throw walletError

    const { data: unlock, error: unlockError } = await supabase
      .from('episode_unlocks')
      .upsert(
        {
          user_id: userId,
          story_id: storyId,
          episode_id: episodeId,
          author_id: episode.author_id,
          unlock_type: 'diamond',
          unlock_scope: 'single',
          access_type: 'permanent',
          expires_at: null,
          diamond_spent: DIAMOND_PRICE_PER_EPISODE,
          unlock_status: 'active',
        },
        {
          onConflict: 'user_id,episode_id',
        }
      )
      .select()
      .single()

    if (unlockError) throw unlockError

    const { error: transactionError } = await supabase
      .from('episode_unlock_transactions')
      .insert({
        unlock_id: unlock.id,
        user_id: userId,
        story_id: storyId,
        episode_id: episodeId,
        author_id: episode.author_id,
        currency: 'diamond',
        amount: DIAMOND_PRICE_PER_EPISODE,
        transaction_type: 'unlock',
        metadata: {
          episode_number: episode.episode_number,
          episode_title: episode.title,
        },
      })

    if (transactionError) throw transactionError

    return res.status(200).json({
      ok: true,
      message: 'Episode unlocked successfully',
      unlocked: true,
      unlock,
      wallet: publicWallet(updatedWallet),
    })
  } catch (error) {
    console.error('UNLOCK EPISODE WITH DIAMONDS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode',
      error: error.message,
    })
  }
}
