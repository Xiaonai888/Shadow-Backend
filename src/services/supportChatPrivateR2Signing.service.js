import { createHash, createHmac } from 'node:crypto'
import { parseSupportImageInput, validateSupportImageKey } from './supportChatImageInput.service.js'

const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const hmac = (key, value) => createHmac('sha256', key).update(value).digest()
const hash = value => createHash('sha256').update(value).digest('hex')

export function signSupportImageUrl(config, { method, key, mime, size, now = new Date() }) {
  if (!config || !/^[a-z0-9-]+$/i.test(config.accountId || '') || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(config.bucket || '') || !config.accessKeyId || !config.secretAccessKey) throw new Error('Missing private R2 configuration')
  const put = method === 'PUT'
  if (!put && method !== 'GET') throw new Error('Invalid support image method')
  if (!validateSupportImageKey(key, put ? 'temp' : 'media', put ? mime : undefined)) throw new Error('Invalid support image key')
  if (put && !parseSupportImageInput({ mime_type: mime, file_size: size })) throw new Error('Invalid support image input')
  const host = `${config.accountId}.r2.cloudflarestorage.com`
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = date.slice(0, 8)
  const scope = `${day}/auto/s3/aws4_request`
  const path = `/${[config.bucket, ...key.split('/')].map(encode).join('/')}`
  const headers = put ? { 'content-length': String(size), 'content-type': mime, host } : { host }
  const names = Object.keys(headers).sort()
  const signed = names.join(';')
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': put ? '300' : '120',
    'X-Amz-SignedHeaders': signed,
  }
  if (!put) params['response-cache-control'] = 'private, no-store'
  const query = Object.entries(params).map(([k, v]) => [encode(k), encode(v)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('&')
  const canonical = [method, path, query, names.map(k => `${k}:${headers[k]}\n`).join(''), signed, 'UNSIGNED-PAYLOAD'].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), 'auto'), 's3'), 'aws4_request')
  const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', date, scope, hash(canonical)].join('\n')).toString('hex')
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`
}
