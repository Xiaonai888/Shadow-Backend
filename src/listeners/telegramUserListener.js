import dotenv from 'dotenv'
import { TelegramClient } from 'telegram'
import { NewMessage } from 'telegram/events/index.js'
import { StringSession } from 'telegram/sessions/index.js'
import { pathToFileURL } from 'node:url'

dotenv.config()

const TEMP_ABA_TELEGRAM_LISTENER_NAME = 'TEMP_ABA_TELEGRAM_USER_ACCOUNT_LISTENER'

let TEMP_ABA_TELEGRAM_LISTENER_STARTED = false
let TEMP_ABA_TELEGRAM_CLIENT = null

function senderUsername(sender) {
  return String(sender?.username || '').replace('@', '').toLowerCase()
}

function getText(event) {
  return String(event?.message?.message || '').trim()
}

function getMessageId(event) {
  const id = event?.message?.id
  return Number(id || Date.now())
}

function getDate(event) {
  const date = event?.message?.date
  if (!date) return Math.floor(Date.now() / 1000)
  if (typeof date === 'number') return date
  return Math.floor(new Date(date).getTime() / 1000)
}

function makeTelegramBotUpdate({ event, text, sender, adminChatId }) {
  return {
    update_id: Date.now(),
    message: {
      message_id: getMessageId(event),
      date: getDate(event),
      chat: {
        id: Number(adminChatId),
        type: 'group',
        title: 'Shadow Payment Alert',
      },
      from: {
        id: Number(sender?.id?.value || sender?.id || 0),
        is_bot: Boolean(sender?.bot),
        first_name: sender?.firstName || sender?.title || 'PayWay',
        username: sender?.username || 'PayWayByABA_bot',
      },
      text,
    },
  }
}

async function postToBackend(update, backendWebhookUrl) {
  const response = await fetch(backendWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `Backend webhook failed: ${response.status}`)
  }

  return data
}

function getConfig() {
  return {
    apiId: Number(process.env.TELEGRAM_API_ID || 0),
    apiHash: process.env.TELEGRAM_API_HASH || '',
    stringSession: process.env.TELEGRAM_STRING_SESSION || '',
    backendWebhookUrl: process.env.BACKEND_TELEGRAM_WEBHOOK_URL || '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    targetChat: process.env.TELEGRAM_LISTENER_CHAT || '',
    abaBotUsername: String(process.env.ABA_BOT_USERNAME || 'PayWayByABA_bot').replace('@', '').toLowerCase(),
  }
}

function validateConfig(config) {
  const missing = []

  if (!config.apiId) missing.push('TELEGRAM_API_ID')
  if (!config.apiHash) missing.push('TELEGRAM_API_HASH')
  if (!config.stringSession) missing.push('TELEGRAM_STRING_SESSION')
  if (!config.backendWebhookUrl) missing.push('BACKEND_TELEGRAM_WEBHOOK_URL')
  if (!config.adminChatId) missing.push('TELEGRAM_ADMIN_CHAT_ID')
  if (!config.targetChat) missing.push('TELEGRAM_LISTENER_CHAT')

  if (missing.length) {
    throw new Error(`${TEMP_ABA_TELEGRAM_LISTENER_NAME} missing ENV: ${missing.join(', ')}`)
  }
}

export async function startTelegramUserListener() {
  if (TEMP_ABA_TELEGRAM_LISTENER_STARTED) return TEMP_ABA_TELEGRAM_CLIENT

  const config = getConfig()
  validateConfig(config)

  const client = new TelegramClient(new StringSession(config.stringSession), config.apiId, config.apiHash, {
    connectionRetries: 5,
  })

  await client.connect()

  const authorized = await client.checkAuthorization()
  if (!authorized) {
    throw new Error(`${TEMP_ABA_TELEGRAM_LISTENER_NAME} is not authorized. Generate TELEGRAM_STRING_SESSION again.`)
  }

  TEMP_ABA_TELEGRAM_LISTENER_STARTED = true
  TEMP_ABA_TELEGRAM_CLIENT = client

  console.log(`${TEMP_ABA_TELEGRAM_LISTENER_NAME} started.`)

  client.addEventHandler(async (event) => {
    try {
      const text = getText(event)
      if (!text) return

      const sender = await event.message.getSender()
      const username = senderUsername(sender)

      if (username !== config.abaBotUsername) return

      const update = makeTelegramBotUpdate({
        event,
        text,
        sender,
        adminChatId: config.adminChatId,
      })

      await postToBackend(update, config.backendWebhookUrl)

      console.log(`${TEMP_ABA_TELEGRAM_LISTENER_NAME} forwarded ABA message: ${text}`)
    } catch (error) {
      console.error('TEMP_ABA_TELEGRAM_LISTENER_EVENT_ERROR:', error)
    }
  }, new NewMessage({ chats: [config.targetChat] }))

  return client
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  startTelegramUserListener().catch((error) => {
    console.error('TEMP_ABA_TELEGRAM_LISTENER_START_ERROR:', error)
    process.exit(1)
  })
}
