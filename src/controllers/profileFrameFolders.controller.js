import { supabase } from '../config/supabase.js'

const TABLE = 'profile_frame_folders'
const FIELDS = 'id, name, sort_order, created_at, updated_at'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function folderId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('Invalid folder ID')
  return value
}

function folderName(value) {
  if (typeof value !== 'string') throw fail('Folder name is required')
  const name = value.trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw fail('Folder name must be 1–80 characters')
  if (name.toLowerCase() === 'general') throw fail('General is the default folder')
  return name
}

function folderOrder(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > 100000) throw fail('Invalid folder display order')
  return number
}

function writeFields(body, creating = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Invalid folder information')
  const value = {}
  if (creating || Object.hasOwn(body, 'name')) value.name = folderName(body.name)
  if (creating || Object.hasOwn(body, 'sort_order')) value.sort_order = folderOrder(body.sort_order ?? 0)
  if (!Object.keys(value).length) throw fail('No folder fields to update')
  if (!creating) value.updated_at = new Date().toISOString()
  return value
}

function sendError(res, error, action) {
  const status = error?.code === '23505' ? 409 : Number(error?.statusCode) || 500
  if (status >= 500) console.error(`PROFILE_FRAME_FOLDER_${action}:`, error)
  return res.status(status).json({
    ok: false,
    message: status === 409 ? 'A folder with this name already exists' : status >= 500 ? 'Unable to manage frame folders' : error.message,
  })
}

export async function listAdminProfileFrameFolders(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const { data, error } = await supabase.from(TABLE)
      .select(FIELDS)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .limit(500)
    if (error) throw error
    return res.status(200).json({
      ok: true,
      folders: [{ id: null, name: 'General', sort_order: 0, is_default: true }, ...(data || [])],
    })
  } catch (error) {
    return sendError(res, error, 'LIST')
  }
}

export async function createAdminProfileFrameFolder(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const payload = writeFields(req.body, true)
    const { data, error } = await supabase.from(TABLE)
      .insert(payload)
      .select(FIELDS)
      .single()
    if (error) throw error
    return res.status(201).json({ ok: true, folder: data })
  } catch (error) {
    return sendError(res, error, 'CREATE')
  }
}

export async function updateAdminProfileFrameFolder(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const id = folderId(req.params.folderId)
    const payload = writeFields(req.body)
    const { data, error } = await supabase.from(TABLE)
      .update(payload)
      .eq('id', id)
      .select(FIELDS)
      .maybeSingle()
    if (error) throw error
    if (!data) throw fail('Folder not found', 404)
    return res.status(200).json({ ok: true, folder: data })
  } catch (error) {
    return sendError(res, error, 'UPDATE')
  }
}

export async function deleteAdminProfileFrameFolder(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const id = folderId(req.params.folderId)
    const { data, error } = await supabase.from(TABLE)
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw fail('Folder not found', 404)
    return res.status(200).json({ ok: true, deleted_id: id, frames_moved_to: 'General' })
  } catch (error) {
    return sendError(res, error, 'DELETE')
  }
}
