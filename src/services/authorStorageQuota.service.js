import { supabase } from '../config/supabase.js'

const MB = 1024 * 1024
const AUTHOR_BASE_QUOTA_BYTES = 100 * MB
const AUTHOR_INCOME_STEP_USD = 10
const AUTHOR_BONUS_PER_STEP_BYTES = 100 * MB
const AUTHOR_MAX_BONUS_BYTES = 1000 * MB

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

async function getAuthorTotalIncomeUsd(authorId) {
  const { data, error } = await supabase
    .from('author_earnings')
    .select('author_net_payout_usd')
    .eq('author_id', authorId)
    .neq('earning_status', 'void')

  if (error) throw error

  return (data || []).reduce((sum, item) => sum + numberValue(item.author_net_payout_usd), 0)
}

async function getAuthorUsedStorageBytes(authorId) {
  const { data, error } = await supabase
    .from('r2_assets')
    .select('file_size')
    .eq('owner_type', 'author')
    .eq('owner_id', authorId)
    .eq('asset_status', 'active')

  if (error) throw error

  return (data || []).reduce((sum, item) => sum + numberValue(item.file_size), 0)
}

export async function getAuthorStorageQuota(authorId) {
  const totalIncomeUsd = await getAuthorTotalIncomeUsd(authorId)
  const usedBytes = await getAuthorUsedStorageBytes(authorId)
  const bonusSteps = Math.floor(totalIncomeUsd / AUTHOR_INCOME_STEP_USD)
  const bonusBytes = Math.min(bonusSteps * AUTHOR_BONUS_PER_STEP_BYTES, AUTHOR_MAX_BONUS_BYTES)
  const quotaBytes = AUTHOR_BASE_QUOTA_BYTES + bonusBytes
  const remainingBytes = Math.max(quotaBytes - usedBytes, 0)

  return {
    owner_type: 'author',
    owner_id: authorId,
    total_income_usd: totalIncomeUsd,
    used_bytes: usedBytes,
    quota_bytes: quotaBytes,
    remaining_bytes: remainingBytes,
    base_quota_bytes: AUTHOR_BASE_QUOTA_BYTES,
    bonus_bytes: bonusBytes,
    max_quota_bytes: AUTHOR_BASE_QUOTA_BYTES + AUTHOR_MAX_BONUS_BYTES,
    can_upload: remainingBytes > 0,
  }
}

export async function assertAuthorStorageAvailable(authorId, fileSizeBytes) {
  const quota = await getAuthorStorageQuota(authorId)
  const requestedBytes = numberValue(fileSizeBytes)

  if (quota.used_bytes + requestedBytes > quota.quota_bytes) {
    const error = new Error('Author storage quota is full')
    error.statusCode = 403
    error.code = 'AUTHOR_STORAGE_QUOTA_FULL'
    error.quota = quota
    error.requested_bytes = requestedBytes
    throw error
  }

  return quota
}

export async function recordAuthorR2Asset({
  authorId,
  category,
  fileName,
  filePath,
  publicUrl,
  mimeType,
  fileSize,
  uploadedBy = null,
  sourceTable = null,
  sourceId = null,
  ownerLabel = null,
}) {
  const { data, error } = await supabase
    .from('r2_assets')
    .insert({
      owner_type: 'author',
      owner_id: authorId,
      owner_label: ownerLabel,
      category,
      file_name: fileName,
      file_path: filePath,
      public_url: publicUrl,
      mime_type: mimeType,
      file_size: numberValue(fileSize),
      uploaded_by: uploadedBy,
      source_table: sourceTable,
      source_id: sourceId,
      asset_status: 'active',
    })
    .select()
    .single()

  if (error) throw error

  return data
}
