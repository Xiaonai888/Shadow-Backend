import { verifyFacebookPage } from './facebookGraph.service.js'
import { requestMetaGraph, metaId, MetaPublishingError } from './metaGraphTransport.service.js'

export async function verifyMetaFacebookConnection({ pageId, pageToken, fetchImpl } = {}) {
  const page = await verifyFacebookPage({ pageId, pageToken, fetchImpl })
  return { platform: 'facebook', externalId: page.pageId, displayName: page.name }
}

export async function verifyMetaInstagramConnection({ pageId, instagramId, userToken, fetchImpl } = {}) {
  metaId(pageId, 'SOCIAL_META_PAGE_INVALID')
  metaId(instagramId, 'SOCIAL_IG_ACCOUNT_INVALID')
  const page = await requestMetaGraph({ path: pageId, token: userToken, params: { fields: 'id,instagram_business_account{id,username}' }, fetchImpl })
  const account = page.instagram_business_account
  if (page.id !== pageId || account?.id !== instagramId || typeof account.username !== 'string' || !account.username.trim() || account.username.length > 300) throw new MetaPublishingError('SOCIAL_IG_ACCOUNT_MISMATCH')
  return { platform: 'instagram', externalId: account.id, displayName: account.username, linkedPageId: pageId }
}
