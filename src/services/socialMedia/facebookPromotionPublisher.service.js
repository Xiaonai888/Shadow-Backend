import { publishFacebookPagePost } from './facebookGraph.service.js'
import { requestMetaGraph, metaId, metaCreatedId, validateMetaPhotoPost } from './metaGraphTransport.service.js'

export async function publishFacebookPromotion({ pageId, pageToken, post, fetchImpl } = {}) {
  metaId(pageId, 'SOCIAL_META_PAGE_INVALID')
  const { photos, caption } = validateMetaPhotoPost(post, 'facebook')
  if (photos.length === 1) return publishFacebookPagePost({ pageId, pageToken, photoUrl: photos[0], message: caption, fetchImpl })
  const ids = []
  for (const photo of photos) {
    const response = await requestMetaGraph({ path: `${pageId}/photos`, token: pageToken, method: 'POST', params: { url: photo, published: 'false', temporary: 'true' }, fetchImpl })
    ids.push(metaCreatedId(response))
  }
  if (new Set(ids).size !== ids.length) {
    const error = new Error('SOCIAL_META_PHOTO_ID_DUPLICATE')
    error.code = 'SOCIAL_META_PHOTO_ID_DUPLICATE'
    throw error
  }
  const params = { message: caption, published: 'true' }
  ids.forEach((id, index) => { params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id }) })
  const result = await requestMetaGraph({ path: `${pageId}/feed`, token: pageToken, method: 'POST', params, fetchImpl })
  return { postId: metaCreatedId(result, { post: true }) }
}
