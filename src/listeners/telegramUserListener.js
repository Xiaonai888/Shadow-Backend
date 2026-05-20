import dotenv from 'dotenv'
import { TelegramClient } from 'telegram'
import { NewMessage } from 'telegram/events/index.js'
import { StringSession } from 'telegram/sessions/index.js'

dotenv.config()

const apiId = Number(process.env.TELEGRAM_API_ID || 0)
const apiHash = process.env.TELEGRAM_API_HASH || ''
const stringSession = process.env.TELEGRAM_STRING_SESSION || ''
const backendWebhookUrl = process.env.BACKEND_TELEGRAM_WEBHOOK_URL || ''
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || ''
const targetChat = process.env.TELEGRAM_LISTENER_CHAT || ''
const abaBotUsername = String(process.env.ABA_BOT_USERNAME || 'PayWayByABA_bot').replace('@', '').toLowerCase()

function required(value, name) {
  if (!value) throw new Error(`${name} is required`)
}

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

function makeTelegramBotUpdate({ event, text, sender }) {
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

async function postToBackend(update) {
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

async function main() {
  required(apiId, 'TELEGRAM_API_ID')
  required(apiHash, 'TELEGRAM_API_HASH')
  required(stringSession, 'TELEGRAM_STRING_SESSION')
  required(backendWebhookUrl, 'BACKEND_TELEGRAM_WEBHOOK_URL')
  required(adminChatId, 'TELEGRAM_ADMIN_CHAT_ID')
  required(targetChat, 'TELEGRAM_LISTENER_CHAT')

  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 5,
  })

  await client.connect()

  if (!await client.checkAuthorization()) {
    throw new Error('Telegram listener is not authorized. Create TELEGRAM_STRING_SESSION first.')
  }

  console.log('Telegram user-account listener started.')

  client.addEventHandler(async (event) => {
    try {
      const text = getText(event)
      if (!text) return

      const sender = await event.message.getSender()
      const username = senderUsername(sender)

      if (username !== abaBotUsername) return

      const update = makeTelegramBotUpdate({ event, text, sender })
      await postToBackend(update)

      console.log(`Forwarded ABA Bot message to backend: ${text}`)
    } catch (error) {
      console.error('TELEGRAM LISTENER EVENT ERROR:', error)
    }
  }, new NewMessage({ chats: [targetChat] }))
}

main().catch((error) => {
  console.error('TELEGRAM LISTENER START ERROR:', error)
  process.exit(1)
})
