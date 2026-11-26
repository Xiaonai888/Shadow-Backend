const PRODUCT_FIELDS = 'id,product_type,pdf_file_url,pdf_file_name,pdf_is_private,access_rule,pdf_version,pdf_updated_at,pdf_update_note'
const CHUNK_SIZE = 100
export const PDF_VERSION_HEADER = 'X-Shadow-Pdf-Version'

export function normalizePdfVersion(value) {
  const version = Number(value)
  return Number.isSafeInteger(version) && version > 0 ? version : 0
}

export function normalizePdfUpdateNote(value) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0, 500).join('') : ''
}

export function mergePurchasedPdfVersion(purchase, product) {
  if (!product || String(product.product_type || '').toLowerCase() !== 'pdf') {
    return { ...purchase, pdf_version: 0, pdf_updated_at: null, pdf_update_note: '' }
  }
  const isPrivate = product.pdf_is_private === true
  return {
    ...purchase,
    pdf_file_url: isPrivate ? '' : String(product.pdf_file_url || ''),
    pdf_file_name: product.pdf_file_name || purchase.pdf_file_name || '',
    pdf_is_private: isPrivate,
    access_rule: product.access_rule || purchase.access_rule || '',
    pdf_version: normalizePdfVersion(product.pdf_version),
    pdf_updated_at: product.pdf_updated_at || null,
    pdf_update_note: normalizePdfUpdateNote(product.pdf_update_note),
  }
}

export async function enrichPurchasedPdfVersions(db, purchases) {
  const rows = Array.isArray(purchases) ? purchases : []
  const ids = [...new Set(rows.map(row => String(row.product_id || '').trim()).filter(Boolean))]
  if (!ids.length) return rows.map(row => mergePurchasedPdfVersion(row, null))
  const products = new Map()
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    const { data, error } = await db.from('author_store_products')
      .select(PRODUCT_FIELDS)
      .in('id', ids.slice(index, index + CHUNK_SIZE))
    if (error) throw error
    for (const product of data || []) products.set(String(product.id), product)
  }
  return rows.map(row => mergePurchasedPdfVersion(row, products.get(String(row.product_id || '').trim())))
}

export function setPurchasedPdfVersionHeader(res, version) {
  const value = normalizePdfVersion(version)
  if (!value) return
  res.set(PDF_VERSION_HEADER, String(value))
  res.append('Access-Control-Expose-Headers', PDF_VERSION_HEADER)
}
