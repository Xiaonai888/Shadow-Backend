import { supabase } from '../config/supabase.js'

function normalizePublisher(publisher) {
  return {
    id: publisher.id,
    name: publisher.name || '',
    description: publisher.description || '',
    logo_url: publisher.logo_url || '',
    is_active: Boolean(publisher.is_active),
    sort_order: Number(publisher.sort_order || 0),
    created_at: publisher.created_at,
    updated_at: publisher.updated_at,
  }
}

export async function getShadowMallPublishers(req, res) {
  try {
    const includeInactive = req.query.include_inactive === 'true'

    let query = supabase
      .from('shadow_mall_publishers')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })

    if (!includeInactive) {
      query = query.eq('is_active', true)
    }

    const { data, error } = await query

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publishers: (data || []).map(normalizePublisher),
    })
  } catch (error) {
    console.error('GET SHADOW MALL PUBLISHERS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow Mall publishers',
      error: error.message,
    })
  }
}

export async function createShadowMallPublisher(req, res) {
  try {
    const name = String(req.body.name || '').trim()

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher name is required',
      })
    }

    const payload = {
      name,
      description: String(req.body.description || '').trim(),
      logo_url: String(req.body.logo_url || '').trim(),
      is_active: req.body.is_active === undefined ? true : Boolean(req.body.is_active),
      sort_order: Number(req.body.sort_order || 0),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_mall_publishers')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      publisher: normalizePublisher(data),
    })
  } catch (error) {
    console.error('CREATE SHADOW MALL PUBLISHER ERROR:', error)

    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      return res.status(409).json({
        ok: false,
        message: 'Publisher name already exists',
      })
    }

    return res.status(500).json({
      ok: false,
      message: 'Failed to create Shadow Mall publisher',
      error: error.message,
    })
  }
}

export async function updateShadowMallPublisher(req, res) {
  try {
    const id = Number(req.params.id)

    if (!id) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    const payload = {
      updated_at: new Date().toISOString(),
    }

    if (req.body.name !== undefined) payload.name = String(req.body.name || '').trim()
    if (req.body.description !== undefined) payload.description = String(req.body.description || '').trim()
    if (req.body.logo_url !== undefined) payload.logo_url = String(req.body.logo_url || '').trim()
    if (req.body.is_active !== undefined) payload.is_active = Boolean(req.body.is_active)
    if (req.body.sort_order !== undefined) payload.sort_order = Number(req.body.sort_order || 0)

    if (payload.name === '') {
      return res.status(400).json({
        ok: false,
        message: 'Publisher name is required',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_publishers')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publisher: normalizePublisher(data),
    })
  } catch (error) {
    console.error('UPDATE SHADOW MALL PUBLISHER ERROR:', error)

    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      return res.status(409).json({
        ok: false,
        message: 'Publisher name already exists',
      })
    }

    return res.status(500).json({
      ok: false,
      message: 'Failed to update Shadow Mall publisher',
      error: error.message,
    })
  }
}

export async function deleteShadowMallPublisher(req, res) {
  try {
    const id = Number(req.params.id)

    if (!id) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_publishers')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publisher: normalizePublisher(data),
    })
  } catch (error) {
    console.error('DELETE SHADOW MALL PUBLISHER ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to disable Shadow Mall publisher',
      error: error.message,
    })
  }
}
