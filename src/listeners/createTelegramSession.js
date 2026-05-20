import dotenv from 'dotenv'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

dotenv.config()

const rl = readline.createInterface({ input, output })

async function ask(label) {
  const value = await rl.question(label)
  return value.trim()
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID || await ask('TELEGRAM_API_ID: '))
  const apiHash = process.env.TELEGRAM_API_HASH || await ask('TELEGRAM_API_HASH: ')
  const stringSession = new StringSession('')

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  })

  await client.start({
    phoneNumber: async () => process.env.TELEGRAM_PHONE_NUMBER || await ask('Phone number with country code: '),
    password: async () => process.env.TELEGRAM_2FA_PASSWORD || await ask('Telegram 2FA password if asked: '),
    phoneCode: async () => await ask('Telegram login code: '),
    onError: (error) => console.error(error),
  })

  console.log('')
  console.log('TELEGRAM_STRING_SESSION=')
  console.log(client.session.save())
  console.log('')

  await client.disconnect()
  rl.close()
}

main().catch((error) => {
  console.error(error)
  rl.close()
  process.exit(1)
})
