import { getSupabaseClient } from '../config/supabase.js'
import {
  GAME_REGISTRY,
  getGameDefinition,
} from '../config/gameRegistry.js'
import {
  deleteMediaLibraryObject,
  uploadMediaLibraryObject,
} from '../services/mediaLibraryR2.service.js'

const TABLE = 'game_settings'

function createHttpError(message, statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function getR2PublicUrl() {
  return String(
    process.env.CLOUDFLARE_R2_PUBLIC_URL ||
      process.env.R2_PUBLIC_URL ||
      ''
  )
    .trim()
    .replace(/\/+$/, '')
}

function storageKeyFromR2Url(value) {
  if (value === null) return null

  const url = String(value || '').trim()
  const publicUrl = getR2PublicUrl()

  if (!url || !publicUrl || !url.startsWith(`${publicUrl}/`)) {
    throw createHttpError(
      'Profile image must be stored in Cloudflare R2',
      400
    )
  }

  return decodeURIComponent(url.slice(publicUrl.length + 1))
}

function defaultRow(definition) {
  return {
    game_key: definition.gameKey,
    name: definition.name,
    profile_url: definition.profile,
    profile_storage_key: null,
    hidden: definition.hidden,
    disabled: definition.disabled,
  }
}

function serializeGame(definition, row = null) {
  const source = row || defaultRow(definition)

  return {
    gameKey: definition.gameKey,
    name: String(source.name || definition.name),
    profile: source.profile_url || null,
    hidden: Boolean(source.hidden),
    disabled: Boolean(source.disabled),
  }
}

function mapRows(rows) {
  return new Map(
    (rows || []).map((row) => [String(row.game_key), row])
  )
}

async function readRows(client) {
  const { data, error } = await client
    .from(TABLE)
    .select(
      'game_key,name,profile_url,profile_storage_key,hidden,disabled,updated_at'
    )

  if (error) throw error
  return data || []
}

async function readCurrentRow(client, gameKey) {
  const { data, error } = await client
    .from(TABLE)
    .select(
      'game_key,name,profile_url,profile_storage_key,hidden,disabled,updated_at'
    )
    .eq('game_key', gameKey)
    .limit(1)

  if (error) throw error
  return data?.[0] || null
}

async function saveRow(client, definition, current, patch) {
  const base = current || defaultRow(definition)
  const payload = {
    game_key: definition.gameKey,
    name: patch.name ?? base.name ?? definition.name,
    profile_url:
      patch.profile_url !== undefined
        ? patch.profile_url
        : base.profile_url || null,
    profile_storage_key:
      patch.profile_storage_key !== undefined
        ? patch.profile_storage_key
        : base.profile_storage_key || null,
    hidden:
      patch.hidden !== undefined
        ? patch.hidden
        : Boolean(base.hidden),
    disabled:
      patch.disabled !== undefined
        ? patch.disabled
        : Boolean(base.disabled),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await client
    .from(TABLE)
    .upsert(payload, { onConflict: 'game_key' })
    .select(
      'game_key,name,profile_url,profile_storage_key,hidden,disabled,updated_at'
    )
    .single()

  if (error) throw error
  return data
}

async function deleteOwnedProfile(gameKey, storageKey) {
  const key = String(storageKey || '').trim()
  const prefix = `game-profiles/${gameKey}/`

  if (!key.startsWith(prefix)) return

  try {
    await deleteMediaLibraryObject(key)
  } catch (error) {
    console.error('DELETE GAME PROFILE ERROR:', error)
  }
}

function validatePatch(body) {
  const input = body && typeof body === 'object' ? body : {}
  const allowed = new Set([
    'name',
    'profile',
    'hidden',
    'disabled',
  ])
  const keys = Object.keys(input)

  if (!keys.length) {
    throw createHttpError('No game settings provided', 400)
  }

  const invalid = keys.filter((key) => !allowed.has(key))

  if (invalid.length) {
    throw createHttpError(
      `Unsupported fields: ${invalid.join(', ')}`,
      400
    )
  }

  const patch = {}

  if ('name' in input) {
    const name = String(input.name || '').trim()

    if (!name || name.length > 100) {
      throw createHttpError(
        'Name must be between 1 and 100 characters',
        400
      )
    }

    patch.name = name
  }

  if ('hidden' in input) {
    if (typeof input.hidden !== 'boolean') {
      throw createHttpError('hidden must be boolean', 400)
    }

    patch.hidden = input.hidden
  }

  if ('disabled' in input) {
    if (typeof input.disabled !== 'boolean') {
      throw createHttpError('disabled must be boolean', 400)
    }

    patch.disabled = input.disabled
  }

  if ('profile' in input) {
    if (input.profile === null || input.profile === '') {
      patch.profile_url = null
      patch.profile_storage_key = null
    } else {
      const profile = String(input.profile || '').trim()
      patch.profile_url = profile
      patch.profile_storage_key = storageKeyFromR2Url(profile)
    }
  }

  return patch
}

export async function getPublicGames(req, res) {
  let rows = []

  try {
    const client = getSupabaseClient()

    if (client) {
      rows = await readRows(client)
    }
  } catch (error) {
    console.error('GET PUBLIC GAMES ERROR:', error)
  }

  const rowMap = mapRows(rows)
  const games = GAME_REGISTRY
    .map((definition) =>
      serializeGame(
        definition,
        rowMap.get(definition.gameKey)
      )
    )
    .filter((game) => !game.hidden)

  return res.json({ ok: true, games })
}

export async function getPublicGame(req, res) {
  const definition = getGameDefinition(req.params.gameKey)

  if (!definition) {
    return res.status(404).json({
      ok: false,
      message: 'Game not found',
    })
  }

  let row = null

  try {
    const client = getSupabaseClient()

    if (client) {
      row = await readCurrentRow(
        client,
        definition.gameKey
      )
    }
  } catch (error) {
    console.error('GET PUBLIC GAME ERROR:', error)
  }

  const game = serializeGame(definition, row)

  if (game.hidden) {
    return res.status(404).json({
      ok: false,
      message: 'Game not found',
    })
  }

  return res.json({ ok: true, game })
}

export async function getAdminGames(req, res) {
  try {
    const client = getSupabaseClient()

    if (!client) {
      return res.status(503).json({
        ok: false,
        message: 'Supabase is not configured',
      })
    }

    const rows = await readRows(client)
    const rowMap = mapRows(rows)
    const games = GAME_REGISTRY.map((definition) =>
      serializeGame(
        definition,
        rowMap.get(definition.gameKey)
      )
    )

    return res.json({ ok: true, games })
  } catch (error) {
    console.error('GET ADMIN GAMES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load games',
    })
  }
}

export async function updateAdminGame(req, res) {
  const definition = getGameDefinition(req.params.gameKey)

  if (!definition) {
    return res.status(404).json({
      ok: false,
      message: 'Game not found',
    })
  }

  try {
    const client = getSupabaseClient()

    if (!client) {
      return res.status(503).json({
        ok: false,
        message: 'Supabase is not configured',
      })
    }

    const patch = validatePatch(req.body)
    const current = await readCurrentRow(
      client,
      definition.gameKey
    )
    const saved = await saveRow(
      client,
      definition,
      current,
      patch
    )

    if (
      current?.profile_storage_key &&
      current.profile_storage_key !==
        saved.profile_storage_key
    ) {
      await deleteOwnedProfile(
        definition.gameKey,
        current.profile_storage_key
      )
    }

    return res.json({
      ok: true,
      game: serializeGame(definition, saved),
    })
  } catch (error) {
    console.error('UPDATE ADMIN GAME ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.message || 'Failed to update game settings',
    })
  }
}

export async function uploadAdminGameProfile(req, res) {
  const definition = getGameDefinition(req.params.gameKey)

  if (!definition) {
    return res.status(404).json({
      ok: false,
      message: 'Game not found',
    })
  }

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      message: 'Profile image is required',
    })
  }

  let uploaded = null

  try {
    const client = getSupabaseClient()

    if (!client) {
      return res.status(503).json({
        ok: false,
        message: 'Supabase is not configured',
      })
    }

    const current = await readCurrentRow(
      client,
      definition.gameKey
    )

    uploaded = await uploadMediaLibraryObject({
      file: req.file,
      prefix: `game-profiles/${definition.gameKey}`,
    })

    const saved = await saveRow(
      client,
      definition,
      current,
      {
        profile_url: uploaded.image_url,
        profile_storage_key: uploaded.storage_key,
      }
    )

    if (
      current?.profile_storage_key &&
      current.profile_storage_key !==
        uploaded.storage_key
    ) {
      await deleteOwnedProfile(
        definition.gameKey,
        current.profile_storage_key
      )
    }

    return res.status(201).json({
      ok: true,
      game: serializeGame(definition, saved),
    })
  } catch (error) {
    if (uploaded?.storage_key) {
      await deleteMediaLibraryObject(
        uploaded.storage_key
      ).catch(() => {})
    }

    console.error('UPLOAD GAME PROFILE ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.message || 'Failed to upload game profile',
    })
  }
}
