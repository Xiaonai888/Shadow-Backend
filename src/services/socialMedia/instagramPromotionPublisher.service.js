import { requestMetaGraph, metaId, metaCreatedId, validateMetaPhotoPost, MetaPublishingError } from './metaGraphTransport.service.js'

export async function readInstagramContainer({ containerId, userToken, fetchImpl } = {}) {
  metaId(containerId, 'SOCIAL_IG_CONTAINER_INVALID')
  const result = await requestMetaGraph({ path: containerId, token: userToken, params: { fields: 'id,status_code' }, fetchImpl })
  if (result.id !== containerId || !['FINISHED','IN_PROGRESS','ERROR','EXPIRED','PUBLISHED'].includes(result.status_code)) throw new MetaPublishingError('SOCIAL_IG_CONTAINER_STATUS_UNKNOWN')
  return { containerId, status: result.status_code }
}

export async function prepareInstagramPromotion({ instagramId, userToken, post, fetchImpl } = {}) {
  metaId(instagramId, 'SOCIAL_IG_ACCOUNT_INVALID')
  const { photos, caption } = validateMetaPhotoPost(post, 'instagram', { jpegOnly: true })
  const create = async params => metaCreatedId(await requestMetaGraph({ path: `${instagramId}/media`, token: userToken, method: 'POST', params, fetchImpl }))
  if (photos.length === 1) return { state: 'container_created', containerId: await create({ image_url: photos[0], caption }) }
  const childIds = []
  for (const photo of photos) childIds.push(await create({ image_url: photo, is_carousel_item: 'true' }))
  if (new Set(childIds).size !== childIds.length) throw new MetaPublishingError('SOCIAL_IG_CHILD_ID_DUPLICATE')
  return { state: 'children_created', childIds }
}

export async function createInstagramCarousel({ instagramId, userToken, childIds, post, fetchImpl } = {}) {
  metaId(instagramId, 'SOCIAL_IG_ACCOUNT_INVALID')
  const { photos, caption } = validateMetaPhotoPost(post, 'instagram', { jpegOnly: true })
  if (post.mediaType !== 'carousel' || !Array.isArray(childIds) || childIds.length !== photos.length || new Set(childIds).size !== childIds.length) throw new MetaPublishingError('SOCIAL_IG_CHILDREN_INVALID')
  childIds.forEach(id => metaId(id, 'SOCIAL_IG_CONTAINER_INVALID'))
  let pending = false
  for (const containerId of childIds) {
    const { status } = await readInstagramContainer({ containerId, userToken, fetchImpl })
    if (status === 'IN_PROGRESS') pending = true
    else if (status !== 'FINISHED') throw new MetaPublishingError('SOCIAL_IG_CHILD_NOT_USABLE')
  }
  if (pending) return { state: 'pending', childIds: [...childIds] }
  const result = await requestMetaGraph({ path: `${instagramId}/media`, token: userToken, method: 'POST', params: { media_type: 'CAROUSEL', children: childIds.join(','), caption }, fetchImpl })
  return { state: 'container_created', containerId: metaCreatedId(result) }
}

export async function publishInstagramContainer({ instagramId, userToken, containerId, fetchImpl } = {}) {
  metaId(instagramId, 'SOCIAL_IG_ACCOUNT_INVALID')
  const { status } = await readInstagramContainer({ containerId, userToken, fetchImpl })
  if (status === 'IN_PROGRESS') return { state: 'pending', containerId }
  if (status === 'PUBLISHED') throw new MetaPublishingError('SOCIAL_IG_ALREADY_PUBLISHED_UNKNOWN_ID', { uncertain: true })
  if (status !== 'FINISHED') throw new MetaPublishingError('SOCIAL_IG_CONTAINER_NOT_USABLE')
  const response = await requestMetaGraph({ path: `${instagramId}/media_publish`, token: userToken, method: 'POST', params: { creation_id: containerId }, fetchImpl })
  return { state: 'published', postId: metaCreatedId(response) }
}
