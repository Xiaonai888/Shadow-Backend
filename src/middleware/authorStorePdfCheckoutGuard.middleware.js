import {
  authorStorePdfCheckoutDecision,
  getAuthorStorePdfOwnership,
} from '../services/authorStorePdfOwnership.service.js'

export async function requireUnpurchasedAuthorStorePdf(req, res, next) {
  res.set('Cache-Control', 'private, no-store')

  const userId = String(req.user?.user_id || req.user?.id || '').trim()

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'LOGIN_REQUIRED',
      message: 'Sign in required.',
    })
  }

  try {
    const items = req.body?.items

    if (!Array.isArray(items) || !items.length || items.length > 30) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_CHECKOUT',
        message: 'Invalid checkout items.',
      })
    }

    const ids = items.map((item) =>
      String(item?.id || item?.product_id || item?.productId || '')
        .trim()
        .toLowerCase()
    )

    if (ids.some((id) => !id)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_PRODUCT',
        message: 'Invalid checkout product.',
      })
    }

    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({
        ok: false,
        code: 'DUPLICATE_PRODUCT',
        message: 'The same product cannot appear twice in one order.',
      })
    }

    const ownership = await getAuthorStorePdfOwnership(userId, ids)

    const pdfIds = new Set(
      ownership
        .filter((item) => item.product_type === 'pdf')
        .map((item) => String(item.product_id).toLowerCase())
    )

    const containsPdf = pdfIds.size > 0
    const containsBook = ownership.some(
      (item) => item.product_type === 'book'
    )

    if (containsPdf && containsBook) {
      return res.status(400).json({
        ok: false,
        code: 'MIXED_CHECKOUT',
        message: 'Please purchase printed books and PDFs separately.',
      })
    }

    for (let index = 0; index < items.length; index += 1) {
      if (!pdfIds.has(ids[index])) continue

      const quantity = Number(items[index]?.quantity ?? 1)

      if (!Number.isFinite(quantity) || quantity !== 1) {
        return res.status(400).json({
          ok: false,
          code: 'INVALID_PDF_QUANTITY',
          message: 'A PDF can only be purchased once per order.',
        })
      }
    }

    const decision = authorStorePdfCheckoutDecision(ownership)

    if (decision) {
      return res.status(409).json(decision)
    }

    return next()
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404) {
      return res.status(error.statusCode).json({
        ok: false,
        message: error.message,
      })
    }

    console.error(
      'AUTHOR STORE PDF PURCHASE GUARD FAILED:',
      String(error?.message || error)
    )

    return res.status(503).json({
      ok: false,
      code: 'PDF_OWNERSHIP_CHECK_UNAVAILABLE',
      message: 'Unable to check PDF ownership. No new payment was started; please retry later.',
    })
  }
}
