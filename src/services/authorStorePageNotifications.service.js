import { supabase } from '../config/supabase.js'
import {
  createAuthorPageNotificationSafely,
} from './authorPageNotifications.service.js'
import {
  emitAdminIncomeChange,
} from './adminIncomeEvents.service.js'

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function cleanMoney(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

async function readAuthorPage(authorPageId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username')
    .eq('id', authorPageId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function readBuyer(buyerId) {
  if (!buyerId) return null

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, avatar_url')
    .eq('id', buyerId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

export async function createAuthorStorePaidNotificationsSafely(order = {}) {
  try {
    const authorPageId = cleanText(order.author_page_id)
    const orderId = cleanText(
      order.order_id || order.order_number || order.id
    )

    if (!authorPageId || !orderId) return

    const paymentStatus = cleanText(
      order.payment_status
    ).toLowerCase()
    const orderStatus = cleanText(
      order.order_status || order.status
    ).toLowerCase()
    const isPaid =
      paymentStatus === 'paid' ||
      [
        'confirmed',
        'preparing',
        'shipped',
        'completed',
      ].includes(orderStatus)

    if (isPaid) {
      emitAdminIncomeChange({
        source: 'author_page',
        action: 'paid_order',
        order_id: orderId,
        order_row_id: cleanText(order.id),
        author_page_id: authorPageId,
      })
    }

    const buyerId = cleanText(order.buyer_id)
    const [authorPage, buyer] = await Promise.all([
      readAuthorPage(authorPageId),
      readBuyer(buyerId),
    ])

    if (!authorPage?.user_id) return

    const buyerProfile =
      order.buyer_profile &&
      typeof order.buyer_profile === 'object'
        ? order.buyer_profile
        : {}

    const buyerName =
      cleanText(
        buyer?.name ||
          buyer?.username ||
          buyerProfile.name ||
          order.buyer_name
      ) || 'A reader'

    const totalUsd = cleanMoney(
      order.total_usd || order.total_amount_usd || order.total_amount
    )
    const authorIncomeUsd = cleanMoney(order.author_income_usd)

    const metadata = {
      order_id: orderId,
      order_row_id: cleanText(order.id),
      buyer_id: buyerId,
      buyer_name: buyerName,
      buyer_username: cleanText(buyer?.username),
      buyer_avatar_url: cleanText(buyer?.avatar_url),
      total_usd: totalUsd,
      author_income_usd: authorIncomeUsd,
      payment_status: cleanText(order.payment_status),
      order_status: cleanText(order.order_status || order.status),
    }

    const jobs = [
      createAuthorPageNotificationSafely({
        authorPageId,
        authorUserId: authorPage.user_id,
        type: 'order',
        title: `New paid order from ${buyerName}`,
        message: `Order ${orderId} · Total $${totalUsd.toFixed(2)}`,
        targetUrl: '/author/orders',
        sourceKey: `author-store-order-paid:${orderId}`,
        metadata,
      }),
    ]

    if (authorIncomeUsd > 0) {
      jobs.push(
        createAuthorPageNotificationSafely({
          authorPageId,
          authorUserId: authorPage.user_id,
          type: 'income',
          title: `You earned $${authorIncomeUsd.toFixed(2)} from a store order`,
          message: `Order ${orderId}`,
          targetUrl: '/author/page/finance/income',
          sourceKey: `author-store-income:${orderId}`,
          metadata,
        })
      )
    }

    await Promise.all(jobs)
  } catch (error) {
    console.error(
      'CREATE AUTHOR STORE PAID NOTIFICATIONS ERROR:',
      error
    )
  }
}
