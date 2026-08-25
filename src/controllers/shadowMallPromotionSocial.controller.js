import { supabase } from '../config/supabase.js'

const COMMENT_LIMIT = 1000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 30

const ALLOWED_REACTIONS = new Set([
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
])

const REACTION_ORDER = [
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
]

const DESTINATIONS = new Set([
  'feed',
  'shadow',
  'reader',
  'circle',
])

const AUDIENCES = new Set([
  'public',
  'followers',
  'close-readers',
  'only-me',
])

function getUserId(req) {
  return String(
    req.user?.user_id ||
      req.user?.id ||
      ''
  ).trim()
}

function getPromotionId(value) {
  const id = Number(value)

  if (!Number.isInteger(id) || id <= 0) {
    return null
  }

  return id
}

function normalizeReactionType(value) {
  return String(value || 'love')
    .trim()
    .toLowerCase()
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function cleanText(value, maxLength = 280) {
  return String(value || '')
    .trim()
    .slice(0, maxLength)
}

function normalizeChoice(
  value,
  allowed,
  fallback
) {
  const choice = String(
    value || fallback
  )
    .trim()
    .toLowerCase()

  return allowed.has(choice)
    ? choice
    : fallback
}

function getPagination(req) {
  const page = Math.max(
    1,
    Number.parseInt(req.query.page, 10) || 1
  )
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(req.query.limit, 10) ||
        DEFAULT_PAGE_SIZE
    )
  )

  return {
    page,
    limit,
    from: (page - 1) * limit,
    to: page * limit - 1,
  }
}

function buildReactionSummary(rows = []) {
  const rank = new Map(
    REACTION_ORDER.map(
      (type, index) => [type, index]
    )
  )
  const counts = new Map()

  for (const row of rows) {
    const type = normalizeReactionType(
      row?.reaction_type
    )

    if (!ALLOWED_REACTIONS.has(type)) {
      continue
    }

    counts.set(
      type,
      Number(counts.get(type) || 0) + 1
    )
  }

  return [...counts.entries()]
    .map(([type, count]) => ({
      type,
      count,
    }))
    .sort((first, second) => {
      if (second.count !== first.count) {
        return second.count - first.count
      }

      return (
        Number(rank.get(first.type) ?? 99) -
        Number(rank.get(second.type) ?? 99)
      )
    })
    .slice(0, 3)
}

function publicUser(user, fallbackId = null) {
  const row = Array.isArray(user)
    ? user[0]
    : user

  return {
    id: row?.id || fallbackId,
    name:
      row?.name ||
      row?.username ||
      'Reader',
    username: row?.username || '',
    avatar_url: row?.avatar_url || '',
  }
}

function publicComment(
  comment,
  reactionMap = new Map()
) {
  if (!comment) return null

  const user = Array.isArray(comment.user)
    ? comment.user[0]
    : comment.user

  const reactionType =
    reactionMap.get(
      String(comment.id)
    ) || null

  return {
    id: comment.id,
    promotion_id: comment.promotion_id,
    post_id: String(
      comment.promotion_id || ''
    ),
    user_id: comment.user_id,
    parent_id: comment.parent_id || null,
    text: comment.text || '',
    likes: Number(comment.likes || 0),
    liked: Boolean(reactionType),
    reaction_type: reactionType,
    is_hidden: Boolean(
      comment.is_hidden
    ),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: user
      ? {
          id: user.id,
          name:
            user.name ||
            user.username ||
            'Reader',
          username:
            user.username || '',
          avatar_url:
            user.avatar_url || '',
          role: user.role || 'reader',
        }
      : {
          id: comment.user_id,
          name: 'Reader',
          username: '',
          avatar_url: '',
          role: 'reader',
        },
    replies: Array.isArray(
      comment.replies
    )
      ? comment.replies.map((reply) =>
          publicComment(
            reply,
            reactionMap
          )
        )
      : [],
  }
}

function publicEcho(item) {
  return {
    id: item.id,
    promotion_id: item.promotion_id,
    post_id: String(
      item.promotion_id || ''
    ),
    user_id: item.user_id,
    echo_text: item.echo_text || '',
    destination:
      item.destination || 'feed',
    audience: item.audience || 'public',
    created_at: item.created_at,
    user: publicUser(
      item.user,
      item.user_id
    ),
  }
}

async function readPromotion(
  promotionId,
  activeOnly = true
) {
  let query = supabase
    .from('shadow_mall_ads')
    .select(
      'id, sponsor, title, description, profile_image_url, is_active, like_count, comment_count, echo_count'
    )
    .eq('id', promotionId)

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } =
    await query.maybeSingle()

  if (error) throw error

  return data
}

async function readUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select(
      'id, name, username, avatar_url, is_active'
    )
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error

  if (
    !data ||
    data.is_active === false
  ) {
    return null
  }

  return data
}

async function readReactionRows(
  promotionId
) {
  const { data, error } = await supabase
    .from(
      'shadow_mall_promotion_reactions'
    )
    .select('user_id, reaction_type')
    .eq('promotion_id', promotionId)

  if (error) throw error

  return data || []
}

async function updatePromotionLikeCount(
  promotionId,
  likeCount
) {
  const { error } = await supabase
    .from('shadow_mall_ads')
    .update({
      like_count: Number(
        likeCount || 0
      ),
    })
    .eq('id', promotionId)

  if (error) throw error
}

async function countVisibleComments(
  promotionId
) {
  const { count, error } = await supabase
    .from(
      'shadow_mall_promotion_comments'
    )
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('promotion_id', promotionId)
    .eq('is_hidden', false)

  if (error) throw error

  return Number(count || 0)
}

async function updatePromotionCommentCount(
  promotionId,
  commentCount
) {
  const { error } = await supabase
    .from('shadow_mall_ads')
    .update({
      comment_count: Number(
        commentCount || 0
      ),
    })
    .eq('id', promotionId)

  if (error) throw error
}

async function readCommentReactionMap(
  userId,
  commentIds
) {
  if (
    !userId ||
    !commentIds.length
  ) {
    return new Map()
  }

  const { data, error } = await supabase
    .from(
      'shadow_mall_promotion_comment_likes'
    )
    .select(
      'comment_id, reaction_type'
    )
    .eq('user_id', userId)
    .in('comment_id', commentIds)

  if (error) throw error

  const reactionMap = new Map()

  for (const item of data || []) {
    const reactionType =
      normalizeReactionType(
        item.reaction_type
      )

    if (
      ALLOWED_REACTIONS.has(
        reactionType
      )
    ) {
      reactionMap.set(
        String(item.comment_id),
        reactionType
      )
    }
  }

  return reactionMap
}

async function readEchoCount(
  promotionId
) {
  const { count, error } = await supabase
    .from(
      'shadow_mall_promotion_echoes'
    )
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('promotion_id', promotionId)

  if (error) throw error

  return Number(count || 0)
}

async function updatePromotionEchoCount(
  promotionId,
  echoCount
) {
  const { error } = await supabase
    .from('shadow_mall_ads')
    .update({
      echo_count: Number(
        echoCount || 0
      ),
    })
    .eq('id', promotionId)

  if (error) throw error
}

import PublicPostDetailView from '../social/posts/PublicPostDetailView'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ImageDropZone from '../common/ImageDropZone'
import ReaderPostOptionsSheet, {
  ReaderPostDeleteConfirmSheet,
} from './ReaderPostOptionsSheet'
import ReaderPostCommentsModal from './ReaderPostCommentsModal'
import ReaderPostCommentsSection from './ReaderPostCommentsSection'
import EchoShareSheetV2Connected from '../social/EchoShareSheetV2Connected'
import ReactionAction from '../social/reactions/ReactionAction'
import ReactionSummary from '../social/reactions/ReactionSummary'
import {
  ProfessionalSinglePostImage,
} from '../common/ProfessionalPostContent'
import ReaderDiscoverPostText from './ReaderDiscoverPostText'
import {
  deleteSavedPostBySource,
  fetchSavedPostStatus,
  saveSavedPost,
} from '../../services/savedPostsApi'

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

const MAX_POST_LENGTH = 10000
const MAX_POST_PHOTOS = 5
const MAX_PHOTO_CAPTION_LENGTH = 2000
const MAX_PHOTO_ALT_TEXT_LENGTH = 500
const MAX_POST_IMAGE_BYTES = 800 * 1024
const HARD_MAX_IMAGE_BYTES = 220 * 1024
const MAX_IMAGE_WIDTH = 1080
const MAX_IMAGE_HEIGHT = 1350
const TARGET_IMAGE_BYTES = 150 * 1024

function getAuthToken() {
  return (
    localStorage.getItem(
      'shadow_reader_token'
    ) ||
    sessionStorage.getItem(
      'shadow_reader_token'
    ) ||
    ''
  )
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return '0KB'
  }

  if (value >= 1024 * 1024) {
    return `${(
      value /
      1024 /
      1024
    ).toFixed(1)}MB`
  }

  return `${Math.max(
    1,
    Math.round(value / 1024)
  )}KB`
}

function loadImageFromFile(file) {
  return new Promise(
    (resolve, reject) => {
      const image = new Image()
      const url =
        URL.createObjectURL(file)

      image.onload = () => {
        URL.revokeObjectURL(url)
        resolve(image)
      }

      image.onerror = () => {
        URL.revokeObjectURL(url)
        reject(
          new Error(
            'Failed to load image'
          )
        )
      }

      image.src = url
    }
  )
}

function canvasToBlob(
  canvas,
  type,
  quality
) {
  return new Promise((resolve) =>
    canvas.toBlob(
      resolve,
      type,
      quality
    )
  )
}

async function compressImageFile(file) {
  if (
    !file?.type?.startsWith(
      'image/'
    )
  ) {
    return null
  }

  const image =
    await loadImageFromFile(file)
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH / image.width,
    MAX_IMAGE_HEIGHT / image.height
  )
  let width = Math.max(
    1,
    Math.round(image.width * scale)
  )
  let height = Math.max(
    1,
    Math.round(image.height * scale)
  )
  let quality = 0.82
  let blob = null

  for (
    let attempt = 0;
    attempt < 10;
    attempt += 1
  ) {
    const canvas =
      document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context =
      canvas.getContext('2d')

    if (!context) {
      throw new Error(
        'Could not prepare this image'
      )
    }

    context.drawImage(
      image,
      0,
      0,
      width,
      height
    )

    blob = await canvasToBlob(
      canvas,
      'image/webp',
      quality
    )

    if (
      blob &&
      blob.size <=
        TARGET_IMAGE_BYTES
    ) {
      break
    }

    if (
      blob &&
      blob.size <=
        HARD_MAX_IMAGE_BYTES &&
      quality <= 0.68
    ) {
      break
    }

    if (quality > 0.62) {
      quality = Math.max(
        0.62,
        quality - 0.07
      )
    } else {
      width = Math.max(
        1,
        Math.round(width * 0.9)
      )
      height = Math.max(
        1,
        Math.round(height * 0.9)
      )
    }
  }

  if (!blob) return file

  if (
    blob.size >
    HARD_MAX_IMAGE_BYTES
  ) {
    throw new Error(
      `Photo is still too large after compression. Selected: ${formatBytes(
        blob.size
      )} / Limit: ${formatBytes(
        HARD_MAX_IMAGE_BYTES
      )}.`
    )
  }

  return new File(
    [blob],
    file.name.replace(
      /\.[^.]+$/,
      '.webp'
    ),
    {
      type: 'image/webp',
      lastModified: Date.now(),
    }
  )
}

async function uploadReaderPostImage(
  file
) {
  const token = getAuthToken()

  if (!token) {
    throw new Error(
      'Please login first'
    )
  }

  const formData = new FormData()
  formData.append('image', file)
  formData.append(
    'folder',
    'reader_post_image'
  )

  const response = await fetch(
    `${API_BASE_URL}/api/story-media/upload-image`,
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${token}`,
      },
      body: formData,
    }
  )

  const data = await response
    .json()
    .catch(() => ({}))

  if (
    !response.ok ||
    data.ok === false
  ) {
    throw new Error(
      data.message ||
        'Failed to upload photo'
    )
  }

  const imageUrl =
    data.image_url ||
    data.imageUrl ||
    ''

  if (!imageUrl) {
    throw new Error(
      'Upload completed without an image URL'
    )
  }

  return imageUrl
}

const POST_TOKEN_PATTERN = /(https?:\/\/[^\s]+|#[\p{L}\p{N}\p{M}_]+)/giu
const POST_URL_ONLY_PATTERN = /^https?:\/\/[^\s]+$/i
const POST_HASHTAG_ONLY_PATTERN = /^#[\p{L}\p{N}\p{M}_]+$/u
function renderPostTextWithLinks(text) {
  return String(text || '').split(POST_TOKEN_PATTERN).map((part, index) => {
    if (POST_URL_ONLY_PATTERN.test(part)) return <a key={`${part}-${index}`} href={part} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="break-all text-[#1877f2]">{part}</a>
    if (POST_HASHTAG_ONLY_PATTERN.test(part)) return <a key={`${part}-${index}`} href={`/discover/search?q=${encodeURIComponent(part)}&type=posts`} onClick={(e) => e.stopPropagation()} className="text-[#1877f2]">{part}</a>
    return part
  })
}

function getStoredUser() {
  try {
    return JSON.parse(
      localStorage.getItem(
        'shadow_reader_user'
      ) ||
        sessionStorage.getItem(
          'shadow_reader_user'
        ) ||
        'null'
    )
  } catch {
    return null
  }
}

function formatCompactNumber(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) {
    return '0'
  }

  if (number >= 1000000) {
    return `${(
      number / 1000000
    ).toFixed(
      number >= 10000000 ? 0 : 1
    )}M`
  }

  if (number >= 1000) {
    return `${(
      number / 1000
    ).toFixed(
      number >= 10000 ? 0 : 1
    )}k`
  }

  return String(number)
}

function formatPostTime(value) {
  const timestamp =
    new Date(value || 0).getTime()

  if (!timestamp) return 'Just now'

  const difference = Math.max(
    0,
    Date.now() - timestamp
  )
  const minutes = Math.floor(
    difference / 60000
  )
  const hours = Math.floor(
    minutes / 60
  )
  const days = Math.floor(
    hours / 24
  )

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  if (days < 7) return `${days}d`

  return new Intl.DateTimeFormat(
    undefined,
    {
      month: 'short',
      day: 'numeric',
      year:
        new Date().getFullYear() !==
        new Date(timestamp).getFullYear()
          ? 'numeric'
          : undefined,
    }
  ).format(new Date(timestamp))
}

function getVisibilityIcon(value) {
  if (
    value === 'only_me' ||
    value === 'private'
  ) {
    return 'fa-solid fa-lock'
  }

  if (value === 'friends') {
    return 'fa-solid fa-user-group'
  }

  if (value === 'followers') {
    return 'fa-solid fa-users'
  }

  return 'fa-solid fa-earth-americas'
}

function ReaderAvatar({ user }) {
  const name = user?.name || 'Reader'

  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#111827] text-[14px] font-semibold text-white">
      {user?.avatar_url ? (
        <img
          src={user.avatar_url}
          alt={name}
          className="h-full w-full object-cover"
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </div>
  )
}

function ReaderPostImages({
  imageUrls,
  photoMetadata,
  onImageClick,
  photoPostView = false,
  selectedPhotoIndex = 0,
}) {
  const images = Array.isArray(
    imageUrls
  )
    ? imageUrls
        .filter(
          (url) =>
            typeof url === 'string' &&
            url.trim()
        )
        .slice(0, 5)
    : []

  if (!images.length) {
    return null
  }

  const metadata = Array.isArray(
    photoMetadata
  )
    ? photoMetadata
    : []

  function getPhotoAltText(
    imageUrl,
    index
  ) {
    const item =
      metadata.find(
        (entry) =>
          String(entry?.url || '') ===
          String(imageUrl || '')
      ) ||
      metadata[index] ||
      {}

    return String(
      item?.alt_text ??
        item?.alt ??
        ''
    )
  }

  const safeSelectedIndex = Math.min(
    images.length - 1,
    Math.max(
      0,
      Number.isFinite(
        Number(selectedPhotoIndex)
      )
        ? Math.floor(
            Number(selectedPhotoIndex)
          )
        : 0
    )
  )

  if (photoPostView) {
    const selectedImage =
      images[safeSelectedIndex]

    return (
      <button
        type="button"
        onClick={() =>
          onImageClick?.(
            safeSelectedIndex
          )
        }
        className="block w-full bg-[#f3f4f6]"
        aria-label="Open photo fullscreen"
      >
        <img
          src={selectedImage}
          alt={getPhotoAltText(
            selectedImage,
            safeSelectedIndex
          )}
          loading="eager"
          decoding="async"
          className="max-h-[72dvh] min-h-[260px] w-full object-contain"
        />
      </button>
    )
  }

  if (images.length === 1) {
    return (
      <ProfessionalSinglePostImage
        src={images[0]}
        alt={getPhotoAltText(
          images[0],
          0
        )}
        onClick={
          onImageClick
            ? () => onImageClick(0)
            : undefined
        }
      />
    )
  }

  return (
    <div className="grid grid-cols-2 gap-1 overflow-hidden bg-white">
      {images.map(
        (imageUrl, index) => {
          const isWideLastImage =
            images.length % 2 === 1 &&
            index ===
              images.length - 1

          return (
            <button
              type="button"
              key={`${imageUrl}-${index}`}
              onClick={() =>
                onImageClick?.(index)
              }
              className={
                isWideLastImage
                  ? 'col-span-2 aspect-[2/1] bg-[#f3f4f6]'
                  : 'aspect-square bg-[#f3f4f6]'
              }
              aria-label={`Open photo ${
                index + 1
              }`}
            >
              <img
                src={imageUrl}
                alt={getPhotoAltText(
                  imageUrl,
                  index
                )}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </button>
          )
        }
      )}
    </div>
  )
}

function EchoPostPreviewImages({
  imageUrls,
  alt = '',
}) {
  const images = Array.isArray(
    imageUrls
  )
    ? imageUrls
        .filter(
          (url) =>
            typeof url === 'string' &&
            url.trim()
        )
        .slice(0, 5)
    : []

  if (!images.length) {
    return (
      <div className="flex min-h-0 items-center justify-center bg-[#f3f4f6] text-[#98a2b3]">
        <i className="fa-regular fa-image text-[28px]" />
      </div>
    )
  }

  if (images.length === 1) {
    return (
      <div className="min-h-0 overflow-hidden bg-[#f3f4f6]">
        <img
          src={images[0]}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </div>
    )
  }

  if (images.length === 2) {
    return (
      <div className="grid min-h-0 grid-cols-2 gap-[2px] bg-white">
        {images.map((imageUrl) => (
          <img
            key={imageUrl}
            src={imageUrl}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="h-full min-h-0 w-full object-cover"
          />
        ))}
      </div>
    )
  }

  if (images.length === 3) {
    return (
      <div className="grid min-h-0 grid-cols-2 gap-[2px] bg-white">
        <img
          src={images[0]}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-full min-h-0 w-full object-cover"
        />

        <div className="grid min-h-0 grid-rows-2 gap-[2px]">
          {images.slice(1).map(
            (imageUrl) => (
              <img
                key={imageUrl}
                src={imageUrl}
                alt={alt}
                loading="lazy"
                decoding="async"
                className="h-full min-h-0 w-full object-cover"
              />
            )
          )}
        </div>
      </div>
    )
  }

  const visibleImages = images.slice(0, 4)
  const hiddenCount = Math.max(
    0,
    images.length - 4
  )

  return (
    <div className="grid min-h-0 grid-cols-2 grid-rows-2 gap-[2px] bg-white">
      {visibleImages.map(
        (imageUrl, index) => (
          <div
            key={imageUrl}
            className="relative min-h-0 overflow-hidden"
          >
            <img
              src={imageUrl}
              alt={alt}
              loading="lazy"
              decoding="async"
              className="h-full min-h-0 w-full object-cover"
            />

            {index === 3 &&
            hiddenCount > 0 ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-[22px] font-semibold text-white">
                +{hiddenCount}
              </div>
            ) : null}
          </div>
        )
      )}
    </div>
  )
}




function ReaderEchoMenuItem({
  icon,
  title,
  danger = false,
  onClick,
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[14px] px-3 py-3 text-left active:bg-black/[0.04]"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center ${
          danger
            ? 'text-[#e5484d]'
            : 'text-[#111827]'
        }`}
      >
        <i className={`${icon} text-[17px]`} />
      </span>

      <span
        className={`text-[14px] font-normal ${
          danger
            ? 'text-[#e5484d]'
            : 'text-[#111827]'
        }`}
      >
        {title}
      </span>
    </button>
  )
}

function resolveReaderPostEchoSource(
  post,
  user
) {
  const source = post?.source || {}
  const sourceType = String(
  post?.source_type || post?.echo_type || source?.type ||
  (post?.source_episode?.id ? 'episode' :
    post?.source_story?.id ? 'story' : '')
)
  .trim().toLowerCase()
  .replaceAll('-', '_')
  const sourceId = String(
    post?.source_id ||
      source?.id ||
      ''
  ).trim()

  const useOriginalSource =
    Boolean(post?.is_echo) &&
    Boolean(sourceType) &&
    Boolean(sourceId)

  if (!useOriginalSource) {
    const username = String(
      user?.username || ''
    ).trim()

    return {
      type: 'reader_post',
      id: post?.id,
      name:
        user?.name ||
        username ||
        'Reader',
      avatarUrl:
        user?.avatar_url || '',
      content:
        post?.content ||
        'Reader post',
      imageUrl:
        Array.isArray(
          post?.image_urls
        )
          ? post.image_urls[0] || ''
          : '',
      label: 'reader post',
      shareUrl:
        `${window.location.origin}${
          username
            ? `/profile?username=${encodeURIComponent(
                username
              )}`
            : '/profile'
        }#reader-post-${post?.id || ''}`,
    }
  }

  const owner =
    source?.owner ||
    post?.source_author_post
      ?.author_page ||
    post?.source_reader_post?.user ||
    post?.source_story?.author_page ||
    {}

  const sourceName =
    source?.name ||
    post?.source_story?.title ||
    post?.source_episode?.title ||
    owner?.page_name ||
    owner?.name ||
    'Shared content'

  const sourcePath = String(
    post?.source_url ||
      source?.url ||
      ''
  ).trim()

  const shareUrl = sourcePath
    ? /^https?:\/\//i.test(sourcePath)
      ? sourcePath
      : `${window.location.origin}${sourcePath}`
    : window.location.href

  return {
    type: sourceType,
    id: sourceId,
    name: sourceName,
    avatarUrl:
      owner?.avatar_url ||
      owner?.profile_image_url ||
      '',
    content:
      source?.content ||
      post?.source_episode?.title ||
      post?.source_author_post
        ?.content ||
      post?.source_reader_post
        ?.content ||
      sourceName,
    imageUrl:
      source?.image_url ||
      source?.image_urls?.[0] ||
      post?.source_story
        ?.landscape_thumbnail_url ||
      post?.source_story?.cover_url ||
      post?.source_episode?.cover_url ||
      post?.source_author_post
        ?.image_urls?.[0] ||
      post?.source_reader_post
        ?.image_urls?.[0] ||
      '',
    label:
      source?.label ||
      sourceType.replaceAll('_', ' '),
    shareUrl,
  }
}

function ReaderEchoSourceBlock({ post }) {
  const navigate = useNavigate()
  const location = useLocation()
  const source = post?.source || {}
  const story = post?.source_story || {}
  const episode = post?.source_episode || {}
  const readerPost =
    post?.source_reader_post || {}
  const authorPost =
    post?.source_author_post || {}
  const sourceType = String(
  post?.source_type || post?.echo_type || source?.type ||
  (post?.source_episode?.id ? 'episode' :
    post?.source_story?.id ? 'story' : '')
)
  .trim().toLowerCase()
  .replaceAll('-', '_')
  const sourceOwner =
    source?.owner ||
    readerPost?.user ||
    authorPost?.author_page ||
    story?.author_page ||
    {}
  const sourceUrl =
    post?.source_url ||
    source?.url ||
    (sourceType === 'episode' &&
    story?.id &&
    episode?.id
      ? `/story/${story.id}/episode/${episode.id}`
      : sourceType === 'story' && story?.id
        ? `/story/${story.id}`
        : sourceType === 'reader_post' &&
            readerPost?.id
          ? readerPost?.user?.username
            ? `/profile?username=${encodeURIComponent(
                readerPost.user.username
              )}#reader-post-${readerPost.id}`
            : `/profile#reader-post-${readerPost.id}`
          : sourceType === 'author_post' &&
              authorPost?.author_page?.page_username
            ? `/author/page/${encodeURIComponent(
                authorPost.author_page
                  .page_username
              )}?post=${encodeURIComponent(
                authorPost.id || ''
              )}`
            : '')

  function openSource() {
    if (sourceUrl) {
      navigate(sourceUrl)
    }
  }

  function handleKeyDown(event) {
    if (
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault()
      openSource()
    }
  }

  if (
    sourceType === 'story' ||
    sourceType === 'episode'
  ) {
    const imageCandidates = [
      ...(Array.isArray(source?.image_urls)
        ? source.image_urls
        : []),
      source?.image_url,
      story?.landscape_thumbnail_url,
      story?.cover_url,
      episode?.cover_url,
    ].filter(Boolean)
    const coverUrl = imageCandidates[0] || ''
    const sourceLabel =
      sourceType === 'episode'
        ? 'episode'
        : 'story'
    const placeholderIcon =
      sourceType === 'episode'
        ? 'fa-solid fa-book-open-reader'
        : 'fa-solid fa-book-open'
    const sourceTitle =
      story?.title ||
      source?.name ||
      'Story'
    const sourceSummary =
      sourceType === 'episode'
        ? episode?.title ||
          source?.content ||
          `Episode ${Number(
            episode?.episode_number || 0
          )}`
        : sourceOwner?.page_name ||
          sourceOwner?.name ||
          story?.main_genre ||
          'Story'
    const sourceDetail =
      sourceType === 'episode'
        ? sourceOwner?.page_name ||
          story?.main_genre ||
          ''
        : story?.main_genre || ''

    return (
      <button
        type="button"
        onClick={openSource}
        disabled={!sourceUrl}
        className="mx-4 mb-4 block w-[calc(100%-2rem)] overflow-hidden rounded-[10px] bg-[#f7f7fa] text-left ring-1 ring-black/10 active:scale-[0.995] disabled:cursor-default"
      >
        {coverUrl ? (
          <div className="aspect-video w-full overflow-hidden bg-[#eceef2]">
            <img
              src={coverUrl}
              alt={sourceTitle}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </div>
        ) : (
          <div className="flex h-28 w-full items-center justify-center bg-gradient-to-br from-[#111827] via-[#312e81] to-[#7c3aed]">
            <i
              className={`${placeholderIcon} text-[30px] text-white/90`}
            />
          </div>
        )}

        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#98a2b3]">
              {sourceLabel}
            </div>

            <div className="mt-1 line-clamp-2 text-[15px] font-semibold leading-5 text-[#111827]">
              {sourceTitle}
            </div>

            {sourceSummary ? (
              <div className="mt-1 line-clamp-2 text-[12px] font-normal leading-5 text-[#667085]">
                {sourceSummary}
              </div>
            ) : null}

            {sourceDetail &&
            sourceDetail !== sourceSummary ? (
              <div className="mt-1 text-[11px] font-normal text-[#98a2b3]">
                {sourceDetail}
              </div>
            ) : null}
          </div>

          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#111827] shadow-sm ring-1 ring-black/5">
            <i className="fa-solid fa-chevron-right text-[12px]" />
          </div>
        </div>
      </button>
    )
  }

  if (
    sourceType ===
    'shadow_mall_promotion'
  ) {
    const promotion =
      source?.promotion || {}
    const imageUrl =
      promotion.image_url ||
      source?.image_url ||
      source?.image_urls?.[0] ||
      ''
    const sponsor =
      promotion.sponsor ||
      source?.owner?.name ||
      source?.name ||
      'Shadow Mall'
    const title =
      promotion.title ||
      source?.name ||
      'Promotion'
    const description =
      promotion.description ||
      source?.content ||
      ''

    return (
      <button
        type="button"
        onClick={openSource}
        disabled={!sourceUrl}
        className="mx-4 mb-4 block w-[calc(100%-2rem)] overflow-hidden rounded-[10px] border border-[#e5e7eb] bg-white text-left active:scale-[0.995] disabled:cursor-default"
      >
        {imageUrl ? (
          <div className="aspect-video w-full overflow-hidden bg-[#f3f4f6]">
            <img
              src={imageUrl}
              alt={title}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </div>
        ) : null}

        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#8b5cf6]">
            Shadow Mall promotion
          </div>

          <div className="mt-1 line-clamp-1 text-[13px] font-semibold text-[#667085]">
            {sponsor}
          </div>

          <div className="mt-1 line-clamp-2 text-[15px] font-semibold leading-5 text-[#111827]">
            {title}
          </div>

          {description ? (
            <p className="mt-2 line-clamp-3 text-[12px] font-normal leading-5 text-[#667085]">
              {description}
            </p>
          ) : null}
        </div>
      </button>
    )
  }

  const previewUser =
    sourceType === 'author_post'
      ? {
          name:
            authorPost?.author_page
              ?.page_name ||
            source?.name ||
            'Author Page',
          avatar_url:
            authorPost?.author_page
              ?.avatar_url ||
            authorPost?.author_page
              ?.profile_image_url ||
            authorPost?.author_page
              ?.profile_picture_url ||
            authorPost?.author_page
              ?.page_avatar_url ||
            '',
        }
      : {
          name:
            readerPost?.user?.name ||
            readerPost?.user?.username ||
            source?.name ||
            'Reader',
          avatar_url:
            readerPost?.user
              ?.avatar_url || '',
        }

  const previewTime =
    sourceType === 'author_post'
      ? authorPost?.created_at ||
        source?.created_at ||
        ''
      : readerPost?.created_at ||
        readerPost?.publish_at ||
        source?.created_at ||
        ''

  const previewVisibility =
    sourceType === 'author_post'
      ? 'public'
      : readerPost?.visibility || 'public'

  const previewText = String(
    sourceType === 'author_post'
      ? authorPost?.content ||
          source?.content ||
          ''
      : readerPost?.content ||
          source?.content ||
          ''
  ).trim()

  const previewImages =
    sourceType === 'author_post'
      ? Array.isArray(
          authorPost?.image_urls
        )
        ? authorPost.image_urls
        : Array.isArray(source?.image_urls)
          ? source.image_urls
          : source?.image_url
            ? [source.image_url]
            : []
      : Array.isArray(
          readerPost?.image_urls
        )
        ? readerPost.image_urls
        : Array.isArray(source?.image_urls)
          ? source.image_urls
          : source?.image_url
            ? [source.image_url]
            : []

  return (
    <div
      role="button"
      tabIndex={sourceUrl ? 0 : -1}
      onClick={openSource}
      onKeyDown={handleKeyDown}
      className="mx-4 mb-4 grid aspect-square w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[10px] border border-[#e5e7eb] bg-white text-left active:scale-[0.995]"
    >
      <div className="min-w-0 bg-white">
        <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3.5">
          <ReaderAvatar user={previewUser} />

          <div className="min-w-0 flex-1">
            <div className="line-clamp-1 text-[14px] font-semibold text-[#111827]">
              {previewUser.name || 'Post'}
            </div>

            <div className="mt-0.5 flex items-center gap-1 text-[11px] font-normal text-gray-400">
              <span>
                {formatPostTime(previewTime)}
              </span>
              <span>·</span>
              <i
                className={`${getVisibilityIcon(previewVisibility)} text-[10px]`}
              />
            </div>
          </div>
        </div>

        {previewText ? (
          <div className="px-3.5 pb-3">
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-[14px] font-normal leading-5 text-[#111827]">
              {renderPostTextWithLinks(
                previewText
              )}
            </p>
          </div>
        ) : null}
      </div>

      <EchoPostPreviewImages
        imageUrls={previewImages}
        alt={previewUser.name || 'Post'}
      />
    </div>
  )
}



function EditorAvatar({ user }) {
  const name = user?.name || 'Reader'

  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#eef0f4] ring-1 ring-black/5">
      {user?.avatar_url ? (
        <img
          src={user.avatar_url}
          alt={name}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="text-[16px] font-semibold text-[#111827]">
          {name
            .slice(0, 1)
            .toUpperCase()}
        </span>
      )}
    </span>
  )
}

function EditImagePreview({
  imageUrls,
  onRemove,
}) {
  if (!imageUrls.length) {
    return null
  }

  if (imageUrls.length === 1) {
    return (
      <div className="mx-[-16px] mt-4 bg-white">
        <div className="relative flex min-h-[260px] items-center justify-center bg-white">
          <img
            src={imageUrls[0]}
            alt=""
            className="max-h-[560px] w-full object-contain"
          />

          <button
            type="button"
            onClick={() =>
              onRemove(imageUrls[0])
            }
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white"
            aria-label="Remove photo"
          >
            <i className="fa-solid fa-xmark text-[12px]" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-4 grid grid-cols-2 gap-1 overflow-hidden rounded-[16px]">
      {imageUrls.map(
        (imageUrl, index) => (
          <div
            key={`${imageUrl}-${index}`}
            className="relative aspect-square bg-[#f3f4f6]"
          >
            <img
              src={imageUrl}
              alt=""
              className="h-full w-full object-cover"
            />

            <button
              type="button"
              onClick={() =>
                onRemove(imageUrl)
              }
              className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-white"
              aria-label="Remove photo"
            >
              <i className="fa-solid fa-xmark text-[11px]" />
            </button>
          </div>
        )
      )}
    </div>
  )
}

function StandardReaderPostCard({
  onFullPostClose,
  post,
  onUpdated,
  onDeleted,
  onHidden,
  onFollowChanged,
  fullPostView = false,
  photoPostView = false,
  selectedPhotoIndex = 0,
}) {
  const navigate = useNavigate()
  const reactionMessageTimerRef =
    useRef(null)
  const editFileInputRef =
    useRef(null)

  const storedUser = useMemo(
    () => getStoredUser(),
    []
  )

  const [menuOpen, setMenuOpen] =
    useState(false)
  const [deleteOpen, setDeleteOpen] =
    useState(false)
  const [editorOpen, setEditorOpen] =
    useState(false)
  const [commentOpen, setCommentOpen] =
    useState(false)
  const [echoOpen, setEchoOpen] =
    useState(false)
  const [content, setContent] =
    useState(post?.content || '')
  const [
    editImageUrls,
    setEditImageUrls,
  ] = useState([])
  const [
    uploadingImages,
    setUploadingImages,
  ] = useState(false)
  const [saving, setSaving] =
    useState(false)
  const [deleting, setDeleting] =
    useState(false)
  const [message, setMessage] =
    useState('')
  
  const [
    reactionBusy,
    setReactionBusy,
  ] = useState(false)
  const [
    reactionType,
    setReactionType,
  ] = useState(
    post?.my_reaction || null
  )
  const [
    reactionCount,
    setReactionCount,
  ] = useState(
    Number(post?.like_count || 0)
  )
  const [
    reactionSummary,
    setReactionSummary,
  ] = useState(
    Array.isArray(post?.reaction_summary)
      ? post.reaction_summary
      : []
  )
  const [
    reactionMessage,
    setReactionMessage,
  ] = useState('')
  const [commentCount, setCommentCount] =
    useState(Number(post?.comment_count || 0))
  const [echoCount, setEchoCount] =
    useState(Number(post?.echo_count || 0))
  const [isSaved, setIsSaved] =
  useState(Boolean(post?.is_saved))
  const [saveBusy, setSaveBusy] =
    useState(false)
  const [followBusy, setFollowBusy] =
    useState(false)
  const [
    fullscreenPhotoOpen,
    setFullscreenPhotoOpen,
  ] = useState(false)
  const [
  fullscreenPhotoIndex,
  setFullscreenPhotoIndex,
] = useState(0)
  const [
    fullscreenControlsVisible,
    setFullscreenControlsVisible,
  ] = useState(true)
  const [
    fullscreenPhotoMenuOpen,
    setFullscreenPhotoMenuOpen,
  ] = useState(false)
  const [
    photoActionMessage,
    setPhotoActionMessage,
  ] = useState('')
  const [
    photoDeleteConfirmOpen,
    setPhotoDeleteConfirmOpen,
  ] = useState(false)
  const [
    photoDeleteBusy,
    setPhotoDeleteBusy,
  ] = useState(false)
  const [
    photoCaptionEditorOpen,
    setPhotoCaptionEditorOpen,
  ] = useState(false)
  const [
    photoCaption,
    setPhotoCaption,
  ] = useState('')
  const [
    photoCaptionSaving,
    setPhotoCaptionSaving,
  ] = useState(false)
  const [
    photoAltEditorOpen,
    setPhotoAltEditorOpen,
  ] = useState(false)
  const [
    photoAltText,
    setPhotoAltText,
  ] = useState('')
  const [
    photoAltSaving,
    setPhotoAltSaving,
  ] = useState(false)

  const user = post?.user || {}
  const isOwner =
    Boolean(post?.is_owner) ||
    String(storedUser?.id || '') ===
      String(post?.user_id || '')
  const isDiscoverView =
    window.location.pathname === '/discover'
  const isFollowing =
    Boolean(user?.is_following)
  const showFollow =
    isDiscoverView &&
    !isOwner &&
    !isFollowing &&
    Boolean(user?.username)
  const isEchoPost =
    Boolean(post?.is_echo)
  const isLegacyEcho =
    isEchoPost &&
    !post?.reader_post_id
  const reactionStateLoaded =
  Boolean(post?.reaction_state_loaded)
const savedStateLoaded =
  Boolean(post?.saved_state_loaded)
const echoStateLoaded =
  Boolean(post?.echo_state_loaded)

  const postText = String(
    post?.content || ''
  )
  const imageUrls =
    Array.isArray(
      post?.image_urls
    )
      ? post.image_urls
          .filter(
            (url) =>
              typeof url === 'string' &&
              url.trim()
          )
          .slice(0, 5)
      : []
  const activePhotoIndex =
  photoPostView
    ? selectedPhotoIndex
    : fullscreenPhotoIndex

const safeSelectedPhotoIndex =
  imageUrls.length
    ? Math.min(
        imageUrls.length - 1,
        Math.max(
          0,
          Number.isFinite(
            Number(activePhotoIndex)
          )
            ? Math.floor(
                Number(activePhotoIndex)
              )
            : 0
        )
      )
    : 0
  const selectedPhotoUrl =
    imageUrls[
      safeSelectedPhotoIndex
    ] || ''
  const photoMetadata =
    Array.isArray(
      post?.photo_metadata
    )
      ? post.photo_metadata
      : []
  const selectedPhotoMetadata =
    photoMetadata.find(
      (item) =>
        String(item?.url || '') ===
        String(selectedPhotoUrl || '')
    ) ||
    photoMetadata[
      safeSelectedPhotoIndex
    ] ||
    {}
  const selectedPhotoCaption =
    String(
      selectedPhotoMetadata?.caption ||
        ''
    )
  const selectedPhotoAltText =
    String(
      selectedPhotoMetadata?.alt_text ??
        selectedPhotoMetadata?.alt ??
        ''
    )

  const echoShareSource = useMemo(
    () =>
      resolveReaderPostEchoSource(
        post,
        user
      ),
    [post, user]
  )

  const editRemainingPhotos =
    MAX_POST_PHOTOS -
    editImageUrls.length
  const canSaveEdit = Boolean(
    isEchoPost ||
      content.trim() ||
      editImageUrls.length
  )

  useEffect(() => {
    setReactionCount(
      Number(post?.like_count || 0)
    )
  }, [post?.like_count])

  useEffect(() => {
    setReactionSummary(
      Array.isArray(post?.reaction_summary)
        ? post.reaction_summary
        : []
    )
  }, [post?.reaction_summary])

  useEffect(() => {
    setReactionType(
      post?.my_reaction || null
    )
  }, [post?.my_reaction])

  useEffect(() => {
    setCommentCount(
      Number(post?.comment_count || 0)
    )
  }, [post?.comment_count])


  useEffect(() => {
    if (
      echoStateLoaded ||
      !echoShareSource.type ||
      !echoShareSource.id
    ) {
      setEchoCount(
        Number(post?.echo_count || 0)
      )
    }
  }, [
    echoShareSource.id,
    echoShareSource.type,
    echoStateLoaded,
    post?.echo_count,
  ])

  useEffect(() => {
    const sourceType = String(
      echoShareSource.type || ''
    )
      .trim()
      .toLowerCase()
    const sourceId = String(
      echoShareSource.id || ''
    ).trim()

    if (!sourceType || !sourceId) {
      return undefined
    }

    const controller =
      new AbortController()
    const token = getAuthToken()
    let ignore = false

    async function loadSourceEchoCount() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/echo-v2/source/${encodeURIComponent(
            sourceType
          )}/${encodeURIComponent(
            sourceId
          )}?page=1&limit=1`,
          {
            headers: token
              ? {
                  Authorization:
                    `Bearer ${token}`,
                }
              : {},
            cache: 'no-store',
            signal: controller.signal,
          }
        )

        const data = await response
          .json()
          .catch(() => ({}))

        if (
          ignore ||
          !response.ok ||
          data.ok === false
        ) {
          return
        }

        setEchoCount(
          Math.max(
            0,
            Number(
              data.echo_count ??
                data.total ??
                0
            )
          )
        )
      } catch (error) {
        if (
          error?.name !== 'AbortError'
        ) {
          return
        }
      }
    }

    function handleEchoV2Updated(event) {
      const detail = event?.detail || {}

      if (
        String(
          detail.sourceType || ''
        )
          .trim()
          .toLowerCase() === sourceType &&
        String(
          detail.sourceId || ''
        ).trim() === sourceId
      ) {
        setEchoCount(
          Math.max(
            0,
            Number(
              detail.echoCount || 0
            )
          )
        )
      }
    }

    window.addEventListener(
      'shadow:echo-v2-updated',
      handleEchoV2Updated
    )

    if (!echoStateLoaded) {
      loadSourceEchoCount()
    }

    return () => {
      ignore = true
      controller.abort()
      window.removeEventListener(
        'shadow:echo-v2-updated',
        handleEchoV2Updated
      )
    }
  }, [
    echoShareSource.id,
    echoShareSource.type,
    echoStateLoaded,
  ])

  useEffect(() => {
    if (savedStateLoaded) {
      setIsSaved(Boolean(post?.is_saved))
      return undefined
    }

    const token = getAuthToken()
    const controller = new AbortController()
    let ignore = false

    if (!post?.id || !token) {
      setIsSaved(false)
      return undefined
    }

    fetchSavedPostStatus(
      'reader_post',
      post.id,
      controller.signal
    )
      .then((data) => {
        if (!ignore) {
          setIsSaved(Boolean(data.saved))
        }
      })
      .catch((error) => {
        if (
          !ignore &&
          error?.name !== 'AbortError'
        ) {
          setIsSaved(false)
        }
      })

    return () => {
      ignore = true
      controller.abort()
    }
  }, [
    post?.id,
    post?.is_saved,
    savedStateLoaded,
  ])

  useEffect(() => {
    if (reactionStateLoaded) {
      return undefined
    }

    let ignore = false
    const token = getAuthToken()

    if (!post?.id || !token) {
      return undefined
    }

    async function loadReactionStatus() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/reader-posts/${encodeURIComponent(post.id)}/reaction`,
          {
            headers: {
              Authorization:
                `Bearer ${token}`,
            },
            cache: 'no-store',
          }
        )

        const data = await response
          .json()
          .catch(() => ({}))

        if (
          ignore ||
          !response.ok ||
          data.ok === false
        ) {
          return
        }

        setReactionType(
          data.my_reaction || null
        )
        setReactionCount(
          Number(data.like_count || 0)
        )
        setReactionSummary(
          Array.isArray(data.reaction_summary)
            ? data.reaction_summary
            : []
        )
      } catch {
        return
      }
    }

    loadReactionStatus()

    return () => {
      ignore = true
    }
  }, [
    post?.id,
    reactionStateLoaded,
  ])

  useEffect(() => {
    return () => {
      if (
        reactionMessageTimerRef.current
      ) {
        window.clearTimeout(
          reactionMessageTimerRef.current
        )
      }
    }
  }, [])

  useEffect(() => {
    if (!fullscreenPhotoOpen) {
      return undefined
    }

    const previousOverflow =
      document.body.style.overflow

    document.body.style.overflow =
      'hidden'

    function handleKeyDown(event) {
      if (event.key !== 'Escape') {
        return
      }

      if (photoAltEditorOpen) {
        if (!photoAltSaving) {
          setPhotoAltEditorOpen(false)
        }
        return
      }

      if (photoCaptionEditorOpen) {
        if (!photoCaptionSaving) {
          setPhotoCaptionEditorOpen(false)
        }
        return
      }

      if (photoDeleteConfirmOpen) {
        if (!photoDeleteBusy) {
          setPhotoDeleteConfirmOpen(false)
        }
        return
      }

      if (fullscreenPhotoMenuOpen) {
        setFullscreenPhotoMenuOpen(false)
        return
      }

      setFullscreenPhotoOpen(false)
      setFullscreenControlsVisible(true)
      setFullscreenPhotoMenuOpen(false)
      setPhotoDeleteConfirmOpen(false)
      setPhotoActionMessage('')
    }

    window.addEventListener(
      'keydown',
      handleKeyDown
    )

    return () => {
      document.body.style.overflow =
        previousOverflow
      window.removeEventListener(
        'keydown',
        handleKeyDown
      )
    }
  }, [
    fullscreenPhotoOpen,
    fullscreenPhotoMenuOpen,
    photoAltEditorOpen,
    photoAltSaving,
    photoCaptionEditorOpen,
    photoCaptionSaving,
    photoDeleteConfirmOpen,
    photoDeleteBusy,
  ])

  useEffect(() => {
    if (!photoActionMessage) {
      return undefined
    }

    const timer = window.setTimeout(
      () => setPhotoActionMessage(''),
      1800
    )

    return () =>
      window.clearTimeout(timer)
  }, [photoActionMessage])

  function showReactionMessage(text) {
    setReactionMessage(text)

    if (
      reactionMessageTimerRef.current
    ) {
      window.clearTimeout(
        reactionMessageTimerRef.current
      )
    }

    reactionMessageTimerRef.current =
      window.setTimeout(() => {
        setReactionMessage('')
      }, 1800)
  }

  async function updateReaction(
    nextReactionType
  ) {
    if (!post?.id || reactionBusy) {
      return
    }

    const token = getAuthToken()

    if (!token) {
      showReactionMessage(
        'Please login first.'
      )
      return
    }

    try {
      setReactionBusy(true)

      const response = await fetch(
        `${API_BASE_URL}/api/reader-posts/${encodeURIComponent(post.id)}/reaction`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${token}`,
          },
          body: JSON.stringify({
            reaction_type:
              nextReactionType,
          }),
        }
      )

      const data = await response
        .json()
        .catch(() => ({}))

      if (
        !response.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.message ||
            'Failed to update reaction'
        )
      }

      const nextType = data.reacted
        ? data.reaction_type ||
          nextReactionType
        : null
      const nextCount = Number(
        data.like_count || 0
      )

      setReactionType(nextType)
      setReactionCount(nextCount)
      setReactionSummary(
        Array.isArray(data.reaction_summary)
          ? data.reaction_summary
          : []
      )

      onUpdated?.({
        ...post,
        like_count: nextCount,
        my_reaction: nextType,
        reaction_summary:
          Array.isArray(
            data.reaction_summary
          )
            ? data.reaction_summary
            : [],
      })
    } catch (error) {
      showReactionMessage(
        error.message ||
          'Failed to update reaction.'
      )
    } finally {
      setReactionBusy(false)
    }
  }

  async function handlePickEditImages(
    fileList
  ) {
    const files = Array.from(
      fileList || []
    )
    const imageFiles =
      files.filter((file) =>
        file?.type?.startsWith(
          'image/'
        )
      )

    if (!imageFiles.length) {
      setMessage(
        'Only image files can be uploaded.'
      )
      return
    }

    if (
      imageFiles.length >
      editRemainingPhotos
    ) {
      setMessage(
        `You can add up to ${MAX_POST_PHOTOS} photos per post.`
      )
      return
    }

    try {
      setUploadingImages(true)
      setMessage(
        'Preparing photos...'
      )

      const compressedFiles =
        await Promise.all(
          imageFiles.map((file) =>
            compressImageFile(file)
          )
        )

      const validFiles =
        compressedFiles.filter(Boolean)
      const totalSize =
        validFiles.reduce(
          (sum, file) =>
            sum +
            Number(file.size || 0),
          0
        )

      if (
        totalSize >
        MAX_POST_IMAGE_BYTES
      ) {
        throw new Error(
          `Photos are too large. Selected: ${formatBytes(
            totalSize
          )} / Limit: ${formatBytes(
            MAX_POST_IMAGE_BYTES
          )}.`
        )
      }

      const uploadedUrls = []

      for (const file of validFiles) {
        const imageUrl =
          await uploadReaderPostImage(
            file
          )
        uploadedUrls.push(
          imageUrl
        )
      }

      setEditImageUrls(
        (current) => [
          ...current,
          ...uploadedUrls,
        ].slice(0, MAX_POST_PHOTOS)
      )
      setMessage('')
    } catch (error) {
      setMessage(
        error.message ||
          'Could not upload these photos.'
      )
    } finally {
      setUploadingImages(false)
    }
  }

  function removeEditImage(imageUrl) {
    setEditImageUrls((current) =>
      current.filter(
        (item) =>
          item !== imageUrl
      )
    )
    setMessage('')
  }

  async function updatePost() {
    const text = content.trim()

    if (!canSaveEdit) {
      setMessage(
        'Post text or image is required.'
      )
      return
    }

    try {
      setSaving(true)
      setMessage('')

      const response = await fetch(
        `${API_BASE_URL}/api/reader-posts/me/${encodeURIComponent(post.id)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${getAuthToken()}`,
          },
          body: JSON.stringify({
            content: text,
            image_urls:
              editImageUrls,
          }),
        }
      )

      const data = await response
        .json()
        .catch(() => ({}))

      if (
        !response.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.message ||
            'Failed to update post'
        )
      }

      if (data.post) {
        onUpdated?.(data.post)
      }

      setEditorOpen(false)
      setMenuOpen(false)
    } catch (error) {
      setMessage(
        error.message ||
          'Failed to update post'
      )
    } finally {
      setSaving(false)
    }
  }

  async function deletePost() {
    try {
      setDeleting(true)

      const endpoint =
        isLegacyEcho && post?.echo_id
          ? `${API_BASE_URL}/api/echoes/${encodeURIComponent(
              post.echo_id
            )}`
          : `${API_BASE_URL}/api/reader-posts/me/${encodeURIComponent(
              post.id
            )}`

      const response = await fetch(
        endpoint,
        {
          method: 'DELETE',
          headers: {
            Authorization:
              `Bearer ${getAuthToken()}`,
          },
        }
      )

      const data = await response
        .json()
        .catch(() => ({}))

      if (
        !response.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.message ||
            'Failed to delete post'
        )
      }

      onDeleted?.(post.id)
      setDeleteOpen(false)
    } catch (error) {
      window.alert(
        error.message ||
          'Failed to delete post'
      )
    } finally {
      setDeleting(false)
      setMenuOpen(false)
    }
  }

  function openEditor() {
    if (isLegacyEcho) {
      window.alert(
        'Delete this old Echo and Echo it again to edit it as a normal post.'
      )
      setMenuOpen(false)
      return
    }

    setContent(post.content || '')
    setEditImageUrls(
      Array.isArray(
        post.image_urls
      )
        ? post.image_urls
            .filter(
              (url) =>
                typeof url ===
                  'string' &&
                url.trim()
            )
            .slice(
              0,
              MAX_POST_PHOTOS
            )
        : []
    )
    setMessage('')
    setMenuOpen(false)
    setEditorOpen(true)
  }

  function hidePost() {
    onHidden?.(post.id)
    setMenuOpen(false)
  }

  function openFullPost() {
  if (
    !isDiscoverView ||
    !post?.id
  ) {
    return
  }

  navigate(
    `/reader/post/${encodeURIComponent(
      post.id
    )}`,
    {
      state: {
        backgroundLocation: location,
      },
    }
  )
}

  

  function handlePostImageClick(index) {
  const photoIndex = Math.max(
    0,
    Number.isFinite(Number(index))
      ? Math.floor(Number(index))
      : 0
  )

  setFullscreenPhotoIndex(photoIndex)
  setFullscreenControlsVisible(true)
  setFullscreenPhotoMenuOpen(false)
  setPhotoDeleteConfirmOpen(false)
  setPhotoCaptionEditorOpen(false)
  setPhotoAltEditorOpen(false)
  setPhotoActionMessage('')
  setFullscreenPhotoOpen(true)
}

  function openPhotoCaptionEditor(event) {
    event?.stopPropagation()

    if (!isOwner || !selectedPhotoUrl) {
      return
    }

    setPhotoCaption(
      selectedPhotoCaption
    )
    setFullscreenPhotoMenuOpen(false)
    setPhotoCaptionEditorOpen(true)
  }

  async function savePhotoCaption(event) {
    event?.stopPropagation()

    if (
      !isOwner ||
      !selectedPhotoUrl ||
      photoCaptionSaving
    ) {
      return
    }

    const token = getAuthToken()

    if (!token) {
      setPhotoCaptionEditorOpen(false)
      setFullscreenPhotoOpen(false)
      navigate('/login')
      return
    }

    const nextCaption =
      photoCaption
        .slice(
          0,
          MAX_PHOTO_CAPTION_LENGTH
        )
        .trim()

    const metadataByUrl = new Map(
      photoMetadata
        .filter(
          (item) =>
            item &&
            typeof item === 'object'
        )
        .map((item) => [
          String(item.url || ''),
          item,
        ])
    )

    const nextPhotoMetadata =
      imageUrls.map((url, index) => {
        const existing =
          metadataByUrl.get(
            String(url)
          ) ||
          photoMetadata[index] ||
          {}

        return {
          url,
          caption:
            index ===
            safeSelectedPhotoIndex
              ? nextCaption
              : String(
                  existing.caption ||
                    ''
                ),
          alt_text: String(
            existing.alt_text ??
              existing.alt ??
              ''
          ),
        }
      })

    try {
      setPhotoCaptionSaving(true)

      const response = await fetch(
        `${API_BASE_URL}/api/reader-posts/me/${encodeURIComponent(
          post.id
        )}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${token}`,
          },
          body: JSON.stringify({
            photo_metadata:
              nextPhotoMetadata,
          }),
        }
      )

      const data = await response
        .json()
        .catch(() => ({}))

      if (
        !response.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.message ||
            'Failed to save caption'
        )
      }

      if (data.post) {
        onUpdated?.(data.post)
      } else {
        onUpdated?.({
          ...post,
          photo_metadata:
            nextPhotoMetadata,
        })
      }

      setPhotoCaptionEditorOpen(false)
      setPhotoActionMessage(
        nextCaption
          ? 'Caption saved.'
          : 'Caption removed.'
      )
    } catch (error) {
      setPhotoActionMessage(
        error.message ||
          'Failed to save caption.'
      )
    } finally {
      setPhotoCaptionSaving(false)
    }
  }

  function openPhotoAltEditor(event) {
    event?.stopPropagation()

    if (!isOwner || !selectedPhotoUrl) {
      return
    }

    setPhotoAltText(
      selectedPhotoAltText
    )
    setFullscreenPhotoMenuOpen(false)
    setPhotoAltEditorOpen(true)
  }

  async function savePhotoAltText(event) {
    event?.stopPropagation()

    if (
      !isOwner ||
      !selectedPhotoUrl ||
      photoAltSaving
    ) {
      return
    }

    const token = getAuthToken()

    if (!token) {
      setPhotoAltEditorOpen(false)
      setFullscreenPhotoOpen(false)
      navigate('/login')
      return
    }

    const nextAltText =
      photoAltText
        .slice(
          0,
          MAX_PHOTO_ALT_TEXT_LENGTH
        )
        .trim()

    const metadataByUrl = new Map(
      photoMetadata
        .filter(
          (item) =>
            item &&
            typeof item === 'object'
        )
        .map((item) => [
          String(item.url || ''),
          item,
        ])
    )

    const nextPhotoMetadata =
      imageUrls.map((url, index) => {
        const existing =
          metadataByUrl.get(
            String(url)
          ) ||
          photoMetadata[index] ||
          {}

        return {
          url,
          caption: String(
            existing.caption || ''
          ),
          alt_text:
            index ===
            safeSelectedPhotoIndex
              ? nextAltText
              : String(
                  existing.alt_text ??
                    existing.alt ??
                    ''
                ),
        }
      })

    try {
      setPhotoAltSaving(true)

      const response = await fetch(
        `${API_BASE_URL}/api/reader-posts/me/${encodeURIComponent(
          post.id
        )}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${token}`,
          },
          body: JSON.stringify({
            photo_metadata:
              nextPhotoMetadata,
          }),
        }
      )

      const data = await response
        .json()
        .catch(() => ({}))

      if (
        !response.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.message ||
            'Failed to save alt text'
        )
      }

      if (data.post) {
        onUpdated?.(data.post)
      } else {
        onUpdated?.({
          ...post,
          photo_metadata:
            nextPhotoMetadata,
        })
      }

      setPhotoAltEditorOpen(false)
      setPhotoActionMessage(
        nextAltText
          ? 'Alt text saved.'
          : 'Alt text removed.'
      )
    } catch (error) {
      setPhotoActionMessage(
        error.message ||
          'Failed to save alt text.'
      )
    } finally {
      setPhotoAltSaving(false)
    }
  }

  async function deleteSelectedPhoto(event) {
    event?.stopPropagation()

    if (
      !isOwner ||
      !selectedPhotoUrl ||
      photoDeleteBusy
    ) {
      return
    }

    const remainingImageUrls =
      imageUrls.filter(
        (_, index) =>
          index !== safeSelectedPhotoIndex
      )
    const currentContent = String(
      post?.content || ''
    ).trim()

    if (
      !remainingImageUrls.length &&
      !currentContent
    ) {
      setPhotoDeleteConfirmOpen(false)
      setFullscreenPhotoMenuOpen(false)
      setPhotoActionMessage(
        'This post needs text or a photo. Delete the post instead.'
      )
      return
    }

    const token = getAuthToken()

    if (!token) {
      setPhotoDeleteConfirmOpen(false)
      setFullscreenPhotoMenuOpen(false)
      setFullscreenPhotoOpen(false)
      navigate('/login')
      return
    }

    try {
      setPhotoDeleteBusy(true)

      const response = await fetch(
        `${API_BASE_URL}/api/reader-posts/me/${encodeURIComponent(
          post.id
        )}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${token}`,
          },
          body: JSON.stringify({
            content: currentContent,
            image_urls:
              remainingImageUrls,
          }),
        }
      )

      const data = await response
        .json()
        .catch(() => ({}))

      if (
        !response.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.message ||
            'Failed to delete photo'
        )
      }

      const updatedPost =
        data.post || {
          ...post,
          content: currentContent,
          image_urls:
            remainingImageUrls,
        }

      onUpdated?.(updatedPost)
      setPhotoDeleteConfirmOpen(false)
      setFullscreenPhotoMenuOpen(false)

      if (!remainingImageUrls.length) {
        setFullscreenPhotoOpen(false)
        setFullscreenControlsVisible(true)
        setPhotoActionMessage('')

        if (photoPostView) {
          navigate(
            `/reader/post/${encodeURIComponent(
              post.id
            )}`,
            {
              replace: true,
            }
          )
        }

        return
      }

      const nextPhotoIndex =
        Math.min(
          safeSelectedPhotoIndex,
          remainingImageUrls.length - 1
        )

      setPhotoActionMessage(
        'Photo deleted.'
      )

      if (photoPostView) {
        navigate(
          `/reader/post/${encodeURIComponent(
            post.id
          )}?photo=${nextPhotoIndex}`,
          {
            replace: true,
          }
        )
      } else {
        setFullscreenPhotoIndex(
          nextPhotoIndex
        )
      }
    } catch (error) {
      setPhotoDeleteConfirmOpen(false)
      setFullscreenPhotoMenuOpen(false)
      setPhotoActionMessage(
        error.message ||
          'Failed to delete photo.'
      )
    } finally {
      setPhotoDeleteBusy(false)
    }
  }

  async function saveSelectedPhoto(event) {
    event?.stopPropagation()

    if (!selectedPhotoUrl) {
      return
    }

    try {
      const response = await fetch(
        selectedPhotoUrl,
        {
          cache: 'no-store',
        }
      )

      if (!response.ok) {
        throw new Error(
          'Could not download photo'
        )
      }

      const blob = await response.blob()
      const objectUrl =
        URL.createObjectURL(blob)
      const extension =
        String(blob.type || '')
          .split('/')[1]
          ?.split(';')[0]
          ?.replace('jpeg', 'jpg') ||
        'jpg'
      const link =
        document.createElement('a')

      link.href = objectUrl
      link.download =
        `shadow-reader-photo-${post.id}-${safeSelectedPhotoIndex + 1}.${extension}`
      document.body.appendChild(link)
      link.click()
      link.remove()

      window.setTimeout(
        () => URL.revokeObjectURL(objectUrl),
        1000
      )

      setFullscreenPhotoMenuOpen(false)
      setPhotoActionMessage(
        'Photo saved.'
      )
    } catch {
      const link =
        document.createElement('a')

      link.href = selectedPhotoUrl
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.download =
        `shadow-reader-photo-${post.id}-${safeSelectedPhotoIndex + 1}`
      document.body.appendChild(link)
      link.click()
      link.remove()

      setFullscreenPhotoMenuOpen(false)
      setPhotoActionMessage(
        'Photo opened for saving.'
      )
    }
  }

  async function shareSelectedPhoto(event) {
    event?.stopPropagation()

    if (!selectedPhotoUrl) {
      return
    }

    const shareData = {
      title:
        `${user?.name || 'Reader'} photo`,
      url: selectedPhotoUrl,
    }

    if (navigator.share) {
      try {
        await navigator.share(shareData)
        setFullscreenPhotoMenuOpen(false)
        return
      } catch (error) {
        if (error?.name === 'AbortError') {
          return
        }
      }
    }

    if (
      navigator.clipboard?.writeText
    ) {
      try {
        await navigator.clipboard.writeText(
          selectedPhotoUrl
        )
        setFullscreenPhotoMenuOpen(false)
        setPhotoActionMessage(
          'Photo link copied.'
        )
        return
      } catch {
        return
      }
    }

    window.open(
      selectedPhotoUrl,
      '_blank',
      'noopener,noreferrer'
    )
    setFullscreenPhotoMenuOpen(false)
  }

  function viewReaderProfile(event) {
    event?.stopPropagation()

    const username = String(
      user?.username || ''
    ).trim()

    setMenuOpen(false)

    if (username) {
      navigate(
        `/profile?username=${encodeURIComponent(username)}`
      )
    }
  }

  async function followReaderFromPost(event) {
    event?.stopPropagation()
    if (
      followBusy ||
      isOwner ||
      isFollowing ||
      !user?.username
    ) {
      return
    }

    const token = getAuthToken()

    if (!token) {
      navigate('/login')
      return
    }

    try {
      setFollowBusy(true)

      const response = await fetch(
        `${API_BASE_URL}/api/users/${encodeURIComponent(
          user.username
        )}/follow`,
        {
          method: 'POST',
          headers: {
            Authorization:
              `Bearer ${token}`,
          },
        }
      )

      const data = await response
        .json()
        .catch(() => ({}))

      if (
        !response.ok ||
        data.ok === false
      ) {
        throw new Error(
          data.message ||
            'Failed to follow reader'
        )
      }

      onFollowChanged?.(
        post.user_id,
        true
      )
    } catch (error) {
      showReactionMessage(
        error.message ||
          'Failed to follow reader.'
      )
    } finally {
      setFollowBusy(false)
    }
  }

  async function toggleSavedPost() {
    if (!post?.id || saveBusy) return

    if (!getAuthToken()) {
      setMenuOpen(false)
      navigate('/login')
      return
    }

    try {
      setSaveBusy(true)

      if (isSaved) {
        await deleteSavedPostBySource(
          'reader_post',
          post.id
        )

        setIsSaved(false)
        showReactionMessage(
          'Removed from saved.'
        )
      } else {
        await saveSavedPost({
          source_type: 'reader_post',
          source_id: String(post.id),
          source_url:
            `${window.location.pathname}${window.location.search}` +
            `#reader-post-${post.id}`,
          snapshot_data: {
            content: post.content || '',
            author_name:
              user?.name || 'Reader',
            username:
              user?.username || '',
            avatar_url:
              user?.avatar_url || '',
          },
          original_created_at:
            post.created_at || null,
        })

        setIsSaved(true)
        showReactionMessage('Post saved.')
      }

      setMenuOpen(false)
    } catch (error) {
      showReactionMessage(
        error.message ||
          'Failed to update saved post.'
      )
    } finally {
      setSaveBusy(false)
    }
  }

  return (
    <>


      {fullPostView && !photoPostView ? (
  <PublicPostDetailView
    pageName={
      user?.name ||
      user?.username ||
      'Reader'
    }
    pageAvatarUrl={
      user?.avatar_url || ''
    }
    authorName={
      user?.name ||
      user?.username ||
      'Reader'
    }
    authorAvatarUrl={
      user?.avatar_url || ''
    }
    createdAt={post.created_at}
    visibility={
      post.visibility || 'public'
    }
    isEdited={Boolean(post.is_edited)}
    content={
      postText ? (
        <span>
          {renderPostTextWithLinks(
            postText
          )}
        </span>
      ) : null
    }
    sourcePreview={
      isEchoPost ? (
        <ReaderEchoSourceBlock
          post={post}
        />
      ) : null
    }
    media={
      !isEchoPost ? (
        <ReaderPostImages
          imageUrls={imageUrls}
          photoMetadata={
            photoMetadata
          }
          onImageClick={
            handlePostImageClick
          }
        />
      ) : null
    }
    reactionControl={
      <div className="inline-flex items-center gap-2">
        <ReactionAction
          reactionType={
            reactionType
          }
          count={reactionCount}
          busy={reactionBusy}
          onReact={updateReaction}
          showCount={false}
          idleLabel="Like"
          buttonClassName="text-[#65676b]"
        />

        <button
          type="button"
          onClick={() =>
            updateReaction(
              reactionType || 'love'
            )
          }
          disabled={reactionBusy}
          className="text-[14px] font-normal text-[#65676b] disabled:opacity-60"
        >
          Like
        </button>
      </div>
    }
    echoControl={
      <button
        type="button"
        onClick={() =>
          setEchoOpen(true)
        }
        className="inline-flex items-center gap-2 text-[14px] font-normal text-[#65676b] active:opacity-70"
      >
        <img
          src="/assets/Icons/echo.svg"
          alt=""
          aria-hidden="true"
          className="h-[18px] w-[18px] object-contain opacity-70"
        />
        <span>Echo</span>
      </button>
    }
    reactionSummary={
      reactionSummary
    }
    likeCount={reactionCount}
    commentCount={commentCount}
    echoCount={echoCount}
    comments={
      <ReaderPostCommentsSection
        postId={post.id}
        postOwnerId={post.user_id}
        commentsPermission={
          post.comments_permission
        }
        commentCount={commentCount}
        onTotalChange={(nextTotal) => {
          setCommentCount(nextTotal)
          onUpdated?.({
            ...post,
            comment_count: nextTotal,
          })
        }}
      />
    }
    onClose={
      onFullPostClose ||
      (() => {
        if (
          window.history.length > 1
        ) {
          navigate(-1)
          return
        }

        navigate('/discover', {
          replace: true,
        })
      })
    }
    onSearch={() =>
      navigate(
        `/discover/search?q=${encodeURIComponent(
          user?.username ||
            user?.name ||
            ''
        )}&type=posts`
      )
    }
    onOpenProfile={
      viewReaderProfile
    }
    onOptions={() =>
      setMenuOpen(true)
    }
    onComment={() =>
      document
        .getElementById(
          'reader-post-comment-input'
        )
        ?.focus()
    }
    onOpenReactions={() =>
      navigate(
        `/interactions/reader_post/${encodeURIComponent(
          post.id
        )}/likes`,
        {
          state: {
            sourceName:
              user?.name ||
              user?.username ||
              'Reader Post',
          },
        }
      )
    }
    onOpenComments={() =>
      document
        .getElementById(
          'reader-post-comment-input'
        )
        ?.scrollIntoView({
          block: 'center',
          behavior: 'smooth',
        })
    }
    onOpenEchoes={() => {
      const sourceType =
        String(
          echoShareSource.type ||
            'reader_post'
        )
          .trim()
          .toLowerCase()
      const sourceId =
        String(
          echoShareSource.id ||
            post.id ||
            ''
        ).trim()

      if (
        !sourceType ||
        !sourceId
      ) {
        return
      }

      navigate(
        `/interactions/${encodeURIComponent(
          sourceType
        )}/${encodeURIComponent(
          sourceId
        )}/echoes`,
        {
          state: {
            sourceName:
              echoShareSource.name ||
              user?.name ||
              'Reader Post',
          },
        }
      )
    }}
  />
) : (

      <article
        id={`reader-post-${post.id}`}
        className="bg-white sm:rounded-[12px]"
      >
        <div
          onClick={
            isDiscoverView
              ? openFullPost
              : undefined
          }
          className={`flex items-start gap-2 px-4 pb-3 pt-4 ${
            isDiscoverView
              ? 'cursor-pointer'
              : ''
          }`}
        >
  <button
    type="button"
    onClick={viewReaderProfile}
    className="shrink-0 rounded-full active:opacity-70"
  >
    <ReaderAvatar user={user} />
  </button>

  <div className="min-w-0 flex-1">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div
          className={
            isDiscoverView
              ? 'flex flex-wrap items-baseline gap-x-1'
              : ''
          }
        >
          <button
            type="button"
            onClick={viewReaderProfile}
            className={
              isDiscoverView
                ? 'max-w-full whitespace-normal break-words text-left text-[14px] font-semibold leading-5 text-[#111827] active:opacity-70'
                : 'block max-w-full truncate text-left text-[14px] font-semibold text-[#111827] active:opacity-70'
            }
          >
            {user.name || 'Reader'}
          </button>

          {showFollow ? (
            <>
              <span className="text-[14px] font-normal text-[#65676b]">
                ·
              </span>

              <button
                type="button"
                disabled={followBusy}
                onClick={followReaderFromPost}
                className="text-[14px] font-semibold text-[#0866ff] active:opacity-70 disabled:opacity-50"
              >
                Follow
              </button>
            </>
          ) : null}
        </div>

        <div className="mt-0.5 flex items-center gap-1 text-[11px] font-normal text-gray-400">
          <span>
            {formatPostTime(
              post.created_at
            )}
          </span>

          {post.is_edited ? (
            <>
              <span>·</span>
              <span>Edited</span>
            </>
          ) : null}

          <span>·</span>

          <i
            className={`${getVisibilityIcon(
              post.visibility
            )} text-[10px]`}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen(true)
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 active:bg-gray-100"
        aria-label="Post options"
      >
        <i className="fa-solid fa-ellipsis text-[14px]" />
      </button>
    </div>
  </div>
</div>

        {postText ? (
          <div className="px-4 pb-4">
            {photoPostView ? (
              <ReaderDiscoverPostText
                text={postText}
                renderText={
                  renderPostTextWithLinks
                }
                className="text-[14px] font-normal leading-6 text-[#111827]"
              />
            ) : fullPostView ? (
              <p className="whitespace-pre-wrap break-words text-[14px] font-normal leading-6 text-[#111827]">
                {renderPostTextWithLinks(
                  postText
                )}
              </p>
            ) : isDiscoverView ? (
              <ReaderDiscoverPostText
                text={postText}
                renderText={
                  renderPostTextWithLinks
                }
                className="text-[14px] font-normal leading-6 text-[#111827]"
              />
            ) : (
              <ReaderDiscoverPostText
  text={postText}
  renderText={renderPostTextWithLinks}
  className="text-[14px] font-normal leading-6 text-[#111827]"
/>
            )}
          </div>
        ) : null}
        {isEchoPost ? (
          <ReaderEchoSourceBlock
            post={post}
          />
        ) : null}

        {!isEchoPost ? (
          <ReaderPostImages
            imageUrls={imageUrls}
            photoMetadata={
              photoMetadata
            }
            onImageClick={
              handlePostImageClick
            }
            photoPostView={
              photoPostView
            }
            selectedPhotoIndex={
              selectedPhotoIndex
            }
          />
        ) : null}

        {isEchoPost ? (
  <div className="mt-2 px-4 pb-1">
    <div className="flex items-center justify-between pb-2 text-[12px] text-[#65676b]">
      <button
        type="button"
        onClick={() =>
          navigate(
            `/interactions/reader_post/${post.id}/likes`,
            {
              state: {
                sourceName:
                  user?.name ||
                  'Reader Post',
              },
            }
          )
        }
        className="flex items-center active:opacity-60"
      >
        <ReactionSummary
          summary={reactionSummary}
          likeCount={reactionCount}
          myReaction={reactionType}
        />
      </button>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setCommentOpen(true)}
          className="active:opacity-60"
        >
          {formatCompactNumber(commentCount)} comments
        </button>

        <span>
          {formatCompactNumber(echoCount)} echoes
        </span>
      </div>
    </div>

    <div className="grid grid-cols-3 items-center py-1.5 text-[14px] font-normal text-[#65676b]">
      <div className="flex items-center justify-center py-2">
        <ReactionAction
          reactionType={reactionType}
          count={reactionCount}
          busy={reactionBusy}
          onReact={updateReaction}
          showCount={false}
          idleLabel="Like"
          buttonClassName="gap-2 after:content-['Like'] [&>i]:!text-[18px] [&>img]:!h-[18px] [&>img]:!w-[18px]"
        />
      </div>

      <button
        type="button"
        onClick={() => setCommentOpen(true)}
        className="flex items-center justify-center gap-2 py-2 active:bg-[#f2f2f2]"
      >
        <i className="fa-regular fa-comment text-[18px]" />
        <span>Comment</span>
      </button>

      <button
        type="button"
        onClick={() => setEchoOpen(true)}
        className="flex items-center justify-center gap-2 py-2 active:bg-[#f2f2f2]"
      >
        <img
          src="/assets/Icons/echo.svg"
          alt=""
          aria-hidden="true"
          className="h-[18px] w-[18px] object-contain opacity-75"
        />
        <span>Echo</span>
      </button>
    </div>
  </div>
) : (
  <div className="mt-2 px-4 pb-1">
  <div className="flex items-center justify-between pb-2 text-[12px] text-[#65676b]">
    <button
      type="button"
      onClick={() =>
        navigate(
          `/interactions/reader_post/${post.id}/likes`,
          {
            state: {
              sourceName:
                user?.name ||
                'Reader Post',
            },
          }
        )
      }
      className="flex items-center active:opacity-60"
    >
      <ReactionSummary
        summary={reactionSummary}
        likeCount={reactionCount}
        myReaction={reactionType}
      />
    </button>

    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => setCommentOpen(true)}
        className="active:opacity-60"
      >
        {formatCompactNumber(commentCount)} comments
      </button>

      <span>
        {formatCompactNumber(echoCount)} echoes
      </span>
    </div>
  </div>

  <div className="grid grid-cols-3 items-center py-1.5 text-[14px] font-normal text-[#65676b]">
    <div className="flex items-center justify-center py-2">
      <ReactionAction
        reactionType={reactionType}
        count={reactionCount}
        busy={reactionBusy}
        onReact={updateReaction}
        showCount={false}
        idleLabel="Like"
        buttonClassName="gap-2 after:content-['Like'] [&>i]:!text-[18px] [&>img]:!h-[18px] [&>img]:!w-[18px]"
      />
    </div>

    <button
      type="button"
      onClick={() => setCommentOpen(true)}
      className="flex items-center justify-center gap-2 py-2 active:bg-[#f2f2f2]"
    >
      <i className="fa-regular fa-comment text-[18px]" />
      <span>Comment</span>
    </button>

    <button
      type="button"
      onClick={() => setEchoOpen(true)}
      className="flex items-center justify-center gap-2 py-2 active:bg-[#f2f2f2]"
    >
      <img
        src="/assets/Icons/echo.svg"
        alt=""
        aria-hidden="true"
        className="h-[18px] w-[18px] object-contain opacity-75"
      />
      <span>Echo</span>
    </button>
  </div>
</div>

)}
      </article>
      )}

      {fullscreenPhotoOpen &&
      imageUrls.length ? (
        <div
          className="fixed inset-0 z-[1000000] bg-black"
          onClick={() => {
            if (
              photoAltEditorOpen ||
              photoCaptionEditorOpen
            ) {
              return
            }

            if (photoDeleteConfirmOpen) {
              if (!photoDeleteBusy) {
                setPhotoDeleteConfirmOpen(
                  false
                )
              }
              return
            }

            if (fullscreenPhotoMenuOpen) {
              setFullscreenPhotoMenuOpen(false)
              return
            }

            setFullscreenControlsVisible(
              (current) => !current
            )
          }}
        >
          {fullscreenControlsVisible ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setFullscreenPhotoOpen(false)
                  setFullscreenControlsVisible(true)
                  setFullscreenPhotoMenuOpen(false)
                  setPhotoDeleteConfirmOpen(false)
                  setPhotoCaptionEditorOpen(false)
                  setPhotoAltEditorOpen(false)
                  setPhotoActionMessage('')
                }}
                className="absolute left-4 top-[max(16px,env(safe-area-inset-top))] z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white transition-opacity active:bg-black/75"
                aria-label="Close fullscreen photo"
              >
                <i className="fa-solid fa-xmark text-[20px]" />
              </button>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setFullscreenPhotoMenuOpen(
                    true
                  )
                }}
                className="absolute right-4 top-[max(16px,env(safe-area-inset-top))] z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white transition-opacity active:bg-black/75"
                aria-label="Photo options"
              >
                <i className="fa-solid fa-ellipsis text-[18px]" />
              </button>
            </>
          ) : null}

          <div className="flex h-[100dvh] w-full items-center justify-center overflow-hidden">
            <img
              src={selectedPhotoUrl}
              alt={selectedPhotoAltText}
              loading="eager"
              decoding="async"
              className="max-h-[100dvh] max-w-full select-none object-contain"
              draggable="false"
            />
          </div>

          {fullscreenControlsVisible &&
!fullscreenPhotoMenuOpen &&
!photoCaptionEditorOpen &&
!photoAltEditorOpen &&
!photoDeleteConfirmOpen ? (
  <div
    className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black via-black/90 to-transparent pt-8"
    onClick={(event) =>
      event.stopPropagation()
    }
  >
    <div className="mx-auto flex max-w-[620px] items-center justify-between px-5 pb-1 text-[11px] font-normal text-white/70">
      <span>
        {formatCompactNumber(
          reactionCount
        )}{' '}
        reactions
      </span>

      <span>
        {formatCompactNumber(
          commentCount
        )}{' '}
        comments
      </span>

      <span>
        {formatCompactNumber(
          echoCount
        )}{' '}
        shares
      </span>
    </div>

    <div className="mx-auto flex max-w-[620px] items-center border-t border-white/15 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-1">
      <ReactionAction
        reactionType={reactionType}
        count={reactionCount}
        busy={reactionBusy}
        onReact={updateReaction}
        showCount={false}
        idleLabel="Like"
        className="flex-1 justify-center"
        buttonClassName="h-12 min-w-[88px] justify-center gap-2 text-white after:content-['Like'] after:text-[14px] after:font-medium [&>i]:!text-[20px] [&>img]:!h-5 [&>img]:!w-5"
      />

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()

          setFullscreenPhotoOpen(
            false
          )
          setFullscreenControlsVisible(
            true
          )
          setFullscreenPhotoMenuOpen(
            false
          )
          setCommentOpen(true)
        }}
        className="flex h-12 flex-1 items-center justify-center gap-2 text-[14px] font-medium text-white active:bg-white/10"
      >
        <i className="fa-regular fa-comment text-[20px]" />
        <span>Comment</span>
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()

          setFullscreenPhotoOpen(
            false
          )
          setFullscreenControlsVisible(
            true
          )
          setFullscreenPhotoMenuOpen(
            false
          )
          setEchoOpen(true)
        }}
        className="flex h-12 flex-1 items-center justify-center gap-2 text-[14px] font-medium text-white active:bg-white/10"
      >
        <i className="fa-solid fa-share text-[19px]" />
        <span>Share</span>
      </button>
    </div>
  </div>
) : null}

          {fullscreenControlsVisible &&
          selectedPhotoCaption &&
          !fullscreenPhotoMenuOpen &&
          !photoCaptionEditorOpen &&
          !photoAltEditorOpen &&
          !photoDeleteConfirmOpen ? (
            <div className="absolute bottom-[calc(env(safe-area-inset-bottom)+92px)] left-0 right-0 z-20 px-5 text-center">
              <p className="mx-auto max-w-[720px] whitespace-pre-wrap break-words text-[13px] font-normal leading-5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                {selectedPhotoCaption}
              </p>
            </div>
          ) : null}

          {photoActionMessage ? (
            <div className="absolute bottom-[calc(env(safe-area-inset-bottom)+94px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-white/95 px-4 py-2 text-[12px] font-medium text-[#111827] shadow-xl">
              {photoActionMessage}
            </div>
          ) : null}

          {fullscreenPhotoMenuOpen ? (
            <div
              className="absolute inset-0 z-40 flex items-end bg-black/35"
              onClick={(event) => {
                event.stopPropagation()
                setFullscreenPhotoMenuOpen(
                  false
                )
              }}
            >
              <div
                className="w-full rounded-t-[22px] bg-white px-3 pb-[max(18px,env(safe-area-inset-bottom))] pt-2 shadow-2xl"
                onClick={(event) =>
                  event.stopPropagation()
                }
              >
                <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-[#d1d5db]" />

                {isOwner ? (
  <button
    type="button"
    onClick={
      openPhotoCaptionEditor
    }
    className="flex w-full items-center gap-3 px-3 py-3.5 text-left active:bg-[#f3f4f6]"
  >
    <span className="flex h-9 w-9 items-center justify-center text-[#4b5563]">
      <i className="fa-solid fa-pencil text-[19px]" />
    </span>

    <span className="text-[15px] font-normal text-[#111827]">
      Edit caption
    </span>
  </button>
) : null}

{isOwner ? (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation()

      setFullscreenPhotoMenuOpen(
        false
      )
      setPhotoDeleteConfirmOpen(
        true
      )
    }}
    className="flex w-full items-center gap-3 px-3 py-3.5 text-left active:bg-[#f3f4f6]"
  >
    <span className="flex h-9 w-9 items-center justify-center text-[#4b5563]">
      <i className="fa-regular fa-trash-can text-[20px]" />
    </span>

    <span className="text-[15px] font-normal text-[#111827]">
      Delete photo
    </span>
  </button>
) : null}

<button
  type="button"
  onClick={saveSelectedPhoto}
  className="flex w-full items-center gap-3 px-3 py-3.5 text-left active:bg-[#f3f4f6]"
>
  <span className="flex h-9 w-9 items-center justify-center text-[#4b5563]">
    <i className="fa-solid fa-arrow-down text-[19px]" />
  </span>

  <span className="text-[15px] font-normal text-[#111827]">
    Save to phone
  </span>
</button>

<button
  type="button"
  onClick={shareSelectedPhoto}
  className="flex w-full items-center gap-3 px-3 py-3.5 text-left active:bg-[#f3f4f6]"
>
  <span className="flex h-9 w-9 items-center justify-center text-[#4b5563]">
    <i className="fa-solid fa-share text-[19px]" />
  </span>

  <span className="text-[15px] font-normal text-[#111827]">
    Share external
  </span>
</button>

{isOwner ? (
  <button
    type="button"
    onClick={
      openPhotoAltEditor
    }
    className="flex w-full items-center gap-3 px-3 py-3.5 text-left active:bg-[#f3f4f6]"
  >
    <span className="flex h-9 w-9 items-center justify-center">
      <span className="flex h-6 w-6 items-center justify-center rounded-[5px] border-2 border-[#6b7280] text-[14px] font-semibold leading-none text-[#4b5563]">
        A
      </span>
    </span>

    <span className="text-[15px] font-normal text-[#111827]">
      Edit alt text
    </span>
  </button>
) : null}

              </div>
            </div>
          ) : null}

          {photoAltEditorOpen ? (
            <div
              className="absolute inset-0 z-50 flex items-end bg-black/45"
              onClick={(event) => {
                event.stopPropagation()

                if (!photoAltSaving) {
                  setPhotoAltEditorOpen(
                    false
                  )
                }
              }}
            >
              <div
                className="w-full rounded-t-[22px] bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-2xl"
                onClick={(event) =>
                  event.stopPropagation()
                }
              >
                <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#d1d5db]" />

                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[16px] font-semibold text-[#111827]">
                      Edit alt text
                    </div>
                    <p className="mt-1 text-[12px] font-normal leading-5 text-[#667085]">
                      Describe what is shown in this photo for accessibility.
                    </p>
                  </div>

                  <span className="shrink-0 text-[11px] font-normal text-[#98a2b3]">
                    {photoAltText.length} / {MAX_PHOTO_ALT_TEXT_LENGTH}
                  </span>
                </div>

                <textarea
                  autoFocus
                  value={photoAltText}
                  maxLength={
                    MAX_PHOTO_ALT_TEXT_LENGTH
                  }
                  onChange={(event) =>
                    setPhotoAltText(
                      event.target.value.slice(
                        0,
                        MAX_PHOTO_ALT_TEXT_LENGTH
                      )
                    )
                  }
                  placeholder="Describe this photo..."
                  className="mt-4 min-h-[130px] w-full resize-none rounded-[14px] border border-[#e5e7eb] bg-[#f9fafb] px-3.5 py-3 text-[14px] font-normal leading-5 text-[#111827] outline-none focus:border-[#111827]"
                />

                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    disabled={photoAltSaving}
                    onClick={() =>
                      setPhotoAltEditorOpen(
                        false
                      )
                    }
                    className="h-11 flex-1 rounded-full bg-[#eef0f4] text-[14px] font-semibold text-[#111827] disabled:opacity-50"
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    disabled={photoAltSaving}
                    onClick={savePhotoAltText}
                    className="h-11 flex-1 rounded-full bg-[#111827] text-[14px] font-semibold text-white disabled:opacity-50"
                  >
                    {photoAltSaving
                      ? 'Saving...'
                      : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {photoCaptionEditorOpen ? (
            <div
              className="absolute inset-0 z-50 flex items-end bg-black/45"
              onClick={(event) => {
                event.stopPropagation()

                if (!photoCaptionSaving) {
                  setPhotoCaptionEditorOpen(
                    false
                  )
                }
              }}
            >
              <div
                className="w-full rounded-t-[22px] bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-2xl"
                onClick={(event) =>
                  event.stopPropagation()
                }
              >
                <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#d1d5db]" />

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[16px] font-semibold text-[#111827]">
                      Edit caption
                    </div>
                    <div className="mt-1 text-[12px] font-normal text-[#98a2b3]">
                      Photo {safeSelectedPhotoIndex + 1}
                    </div>
                  </div>

                  <span className="text-[11px] font-normal text-[#98a2b3]">
                    {photoCaption.length} / {MAX_PHOTO_CAPTION_LENGTH}
                  </span>
                </div>

                <textarea
                  autoFocus
                  value={photoCaption}
                  maxLength={
                    MAX_PHOTO_CAPTION_LENGTH
                  }
                  onChange={(event) =>
                    setPhotoCaption(
                      event.target.value.slice(
                        0,
                        MAX_PHOTO_CAPTION_LENGTH
                      )
                    )
                  }
                  placeholder="Write a caption for this photo..."
                  className="mt-4 min-h-[130px] w-full resize-none rounded-[14px] border border-[#e5e7eb] bg-[#f9fafb] px-3.5 py-3 text-[14px] font-normal leading-5 text-[#111827] outline-none focus:border-[#111827]"
                />

                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    disabled={
                      photoCaptionSaving
                    }
                    onClick={() =>
                      setPhotoCaptionEditorOpen(
                        false
                      )
                    }
                    className="h-11 flex-1 rounded-full bg-[#eef0f4] text-[14px] font-semibold text-[#111827] disabled:opacity-50"
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    disabled={
                      photoCaptionSaving
                    }
                    onClick={savePhotoCaption}
                    className="h-11 flex-1 rounded-full bg-[#111827] text-[14px] font-semibold text-white disabled:opacity-50"
                  >
                    {photoCaptionSaving
                      ? 'Saving...'
                      : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {photoDeleteConfirmOpen ? (
            <div
              className="absolute inset-0 z-50 flex items-end bg-black/45"
              onClick={(event) => {
                event.stopPropagation()

                if (!photoDeleteBusy) {
                  setPhotoDeleteConfirmOpen(
                    false
                  )
                }
              }}
            >
              <div
                className="w-full rounded-t-[22px] bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-2xl"
                onClick={(event) =>
                  event.stopPropagation()
                }
              >
                <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#d1d5db]" />

                <div className="text-[16px] font-semibold text-[#111827]">
                  Delete this photo?
                </div>

                <p className="mt-1.5 text-[13px] font-normal leading-5 text-[#667085]">
                  This photo will be removed from this Reader post.
                </p>

                <div className="mt-5 flex gap-3">
                  <button
                    type="button"
                    disabled={photoDeleteBusy}
                    onClick={() =>
                      setPhotoDeleteConfirmOpen(
                        false
                      )
                    }
                    className="h-11 flex-1 rounded-full bg-[#eef0f4] text-[14px] font-semibold text-[#111827] disabled:opacity-50"
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    disabled={photoDeleteBusy}
                    onClick={deleteSelectedPhoto}
                    className="h-11 flex-1 rounded-full bg-[#e5484d] text-[14px] font-semibold text-white disabled:opacity-50"
                  >
                    {photoDeleteBusy
                      ? 'Deleting...'
                      : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {reactionMessage ? (
        <div className="fixed left-1/2 top-20 z-[300] -translate-x-1/2 whitespace-nowrap rounded-full bg-[#111827] px-4 py-2 text-[12px] font-normal text-white shadow-2xl">
          {reactionMessage}
        </div>
      ) : null}

      <ReaderPostCommentsModal
        open={commentOpen}
        postId={post.id}
        postName={
          user?.name ||
          user?.username ||
          'Reader Post'
        }
        echoSourceType={
          echoShareSource.type
        }
        echoSourceId={
          echoShareSource.id
        }
        echoSourceName={
          echoShareSource.name
        }
        postOwnerId={post.user_id}
        commentsPermission={
          post.comments_permission
        }
        reactionCount={reactionCount}
        commentCount={commentCount}
        echoCount={echoCount}
        onClose={() => setCommentOpen(false)}
        onTotalChange={(nextTotal) => {
          setCommentCount(nextTotal)
          onUpdated?.({
            ...post,
            comment_count: nextTotal,
          })
        }}
      />

      <EchoShareSheetV2Connected
        open={echoOpen}
        sourceType={
          echoShareSource.type
        }
        sourceId={
          echoShareSource.id
        }
        sourceName={
          echoShareSource.name
        }
        sourceAvatarUrl={
          echoShareSource.avatarUrl
        }
        sourceContent={
          echoShareSource.content
        }
        sourceImageUrl={
          echoShareSource.imageUrl
        }
        sourceLabel={
          echoShareSource.label
        }
        shareUrl={
          echoShareSource.shareUrl
        }
        onClose={() =>
          setEchoOpen(false)
        }
        onEchoed={(
          nextEcho,
          nextTotal
        ) => {
          const total = Math.max(
            0,
            Number(
              nextTotal ??
                (nextEcho
                  ? echoCount + 1
                  : echoCount)
            )
          )

          setEchoCount(total)

          if (!isEchoPost) {
            onUpdated?.({
              ...post,
              echo_count: total,
            })
          }
        }}
      />

      <ReaderPostOptionsSheet
        open={menuOpen}
        post={post}
        isOwner={isOwner}
        onClose={() =>
          setMenuOpen(false)
        }
        onEdit={openEditor}
        onDelete={() => {
          setMenuOpen(false)
          setDeleteOpen(true)
        }}
        onHide={hidePost}
        onViewProfile={
          viewReaderProfile
        }
        isSaved={isSaved}
        onSave={toggleSavedPost}
        onMessage={(text) =>
          window.alert(text)
        }
      />

      <ReaderPostDeleteConfirmSheet
        open={deleteOpen}
        deleting={deleting}
        onCancel={() =>
          setDeleteOpen(false)
        }
        onConfirm={deletePost}
      />

      {editorOpen ? (
        <>
          <input
            ref={editFileInputRef}
            type="file"
            accept="image/*"
            multiple
            disabled={
              saving ||
              uploadingImages ||
              editRemainingPhotos <= 0
            }
            className="hidden"
            onChange={(event) => {
              handlePickEditImages(
                event.target.files
              )
              event.target.value = ''
            }}
          />

          <ImageDropZone
            onFiles={
              handlePickEditImages
            }
            onRejectedFiles={() =>
              setMessage(
                `Only images are allowed, with a maximum of ${MAX_POST_PHOTOS} photos.`
              )
            }
            disabled={
              saving ||
              uploadingImages ||
              editRemainingPhotos <= 0
            }
            multiple
            maxFiles={Math.max(
              1,
              editRemainingPhotos
            )}
            accept="image/*"
            className="fixed inset-0 z-[200000] overflow-y-auto bg-white"
            label="Drop photos here"
          >
            <header className="sticky top-0 z-20 border-b border-[#eef0f4] bg-white">
              <div className="mx-auto flex h-14 max-w-[620px] items-center justify-between px-4">
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !saving &&
                      !uploadingImages
                    ) {
                      setEditorOpen(false)
                    }
                  }}
                  disabled={
                    saving ||
                    uploadingImages
                  }
                  className="flex h-10 w-10 items-center justify-center rounded-full text-[#111827] active:bg-[#f3f4f6] disabled:opacity-50"
                  aria-label="Close editor"
                >
                  <i className="fa-solid fa-xmark text-[22px]" />
                </button>

                <div className="line-clamp-1 px-2 text-center text-[16px] font-semibold text-[#111827]">
                  Edit Reader Post
                </div>

                <button
                  type="button"
                  onClick={updatePost}
                  disabled={
                    saving ||
                    uploadingImages ||
                    !canSaveEdit
                  }
                  className="h-9 rounded-full bg-[#111827] px-4 text-[13px] font-semibold text-white disabled:bg-[#e5e7eb] disabled:text-[#9ca3af]"
                >
                  {saving
                    ? 'Saving'
                    : uploadingImages
                      ? 'Uploading'
                      : 'Save'}
                </button>
              </div>
            </header>

            <main className="mx-auto flex min-h-[calc(100vh-56px)] max-w-[620px] flex-col bg-white">
              <div className="flex-1 px-4 pt-5">
                <div className="mb-5 flex items-center gap-3">
                  <EditorAvatar
                    user={user}
                  />

                  <div className="min-w-0">
                    <div className="line-clamp-1 text-[15px] font-semibold text-[#111827]">
                      {user?.name ||
                        'Reader'}
                    </div>

                    <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-[#eef0f4] px-2.5 py-1 text-[11px] font-normal text-[#374151]">
                      <i
                        className={`${getVisibilityIcon(
                          post.visibility
                        )} text-[10px]`}
                      />
                      {post.visibility ===
                      'only_me'
                        ? 'Only me'
                        : post.visibility ===
                            'friends'
                          ? 'Friends'
                          : post.visibility ===
                              'followers'
                            ? 'Followers'
                            : 'Public'}
                    </div>
                  </div>
                </div>

                <textarea
                  autoFocus
                  value={content}
                  maxLength={
                    MAX_POST_LENGTH
                  }
                  onChange={(event) =>
                    setContent(
                      event.target.value.slice(
                        0,
                        MAX_POST_LENGTH
                      )
                    )
                  }
                  placeholder="Share your thoughts..."
                  className="min-h-[210px] w-full resize-none border-0 bg-white p-0 text-[16px] font-normal leading-6 text-[#111827] outline-none placeholder:text-[#9ca3af]"
                />

                <EditImagePreview
                  imageUrls={
                    editImageUrls
                  }
                  onRemove={
                    removeEditImage
                  }
                />

                {message ? (
                  <div className="mt-3 rounded-[12px] bg-[#fff7ed] px-3 py-2 text-[12px] font-normal leading-5 text-[#9a3412]">
                    {message}
                  </div>
                ) : null}
              </div>

              <div className="border-t border-[#eef0f4] bg-white px-4 py-4">
                <div
                  className={`mb-3 text-right text-[11px] font-normal ${
                    content.length >=
                    MAX_POST_LENGTH
                      ? 'text-[#dc2626]'
                      : content.length >=
                          MAX_POST_LENGTH -
                            500
                        ? 'text-[#d97706]'
                        : 'text-[#9ca3af]'
                  }`}
                >
                  {content.length.toLocaleString()}{' '}
                  /{' '}
                  {MAX_POST_LENGTH.toLocaleString()}
                </div>

                <button
                  type="button"
                  disabled={
                    saving ||
                    uploadingImages ||
                    editRemainingPhotos <= 0
                  }
                  onClick={() =>
                    editFileInputRef.current?.click()
                  }
                  className="flex h-[82px] w-[112px] flex-col items-center justify-center gap-2 rounded-[18px] border border-[#e5e7eb] bg-white text-[#111827] shadow-[0_4px_14px_rgba(17,24,39,0.14)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Open Gallery"
                >
                  <svg
                    className="h-[27px] w-[27px]"
                    viewBox="0 0 22 26"
                    fill="none"
                    aria-hidden="true"
                  >
                    <rect
                      x="3"
                      y="3"
                      width="16"
                      height="20"
                      rx="3"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <circle
                      cx="7.5"
                      cy="8.8"
                      r="1.45"
                      fill="currentColor"
                    />
                    <path
                      d="M5 18.8l4-4.3 3 3.2 2.2-2.4 3 3.5H5z"
                      fill="currentColor"
                    />
                  </svg>

                  <span className="text-[14px] font-normal">
                    {uploadingImages
                      ? 'Uploading'
                      : editRemainingPhotos <=
                          0
                        ? '5 photos'
                        : 'Gallery'}
                  </span>
                </button>
              </div>
            </main>
          </ImageDropZone>
        </>
      ) : null}
    </>
  )
}


export default function ReaderPostCard(
  props
) {
  return (
    <StandardReaderPostCard
      {...props}
    />
  )
}



export async function getShadowMallPromotionReactionStatus(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const rows =
      await readReactionRows(
        promotionId
      )
    const myReaction =
      rows.find(
        (row) =>
          String(row.user_id || '') ===
          userId
      )?.reaction_type || null

    return res.status(200).json({
      ok: true,
      my_reaction: myReaction,
      like_count: rows.length,
      reaction_summary:
        buildReactionSummary(rows),
    })
  } catch (error) {
    console.error(
      'GET SHADOW MALL PROMOTION REACTION STATUS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load promotion reaction',
      error: error.message,
    })
  }
}

export async function setShadowMallPromotionReaction(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const reactionType =
      normalizeReactionType(
        req.body?.reaction_type ||
          req.body?.reactionType
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    if (
      !ALLOWED_REACTIONS.has(
        reactionType
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Invalid reaction type',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const {
      data: existingReaction,
      error: existingError,
    } = await supabase
      .from(
        'shadow_mall_promotion_reactions'
      )
      .select('id, reaction_type')
      .eq(
        'promotion_id',
        promotionId
      )
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) {
      throw existingError
    }

    let reacted = true
    let nextReactionType =
      reactionType

    if (
      existingReaction?.reaction_type ===
      reactionType
    ) {
      const { error: deleteError } =
        await supabase
          .from(
            'shadow_mall_promotion_reactions'
          )
          .delete()
          .eq('id', existingReaction.id)

      if (deleteError) {
        throw deleteError
      }

      reacted = false
      nextReactionType = null
    } else if (
      existingReaction?.id
    ) {
      const { error: updateError } =
        await supabase
          .from(
            'shadow_mall_promotion_reactions'
          )
          .update({
            reaction_type:
              reactionType,
            updated_at:
              new Date().toISOString(),
          })
          .eq('id', existingReaction.id)

      if (updateError) {
        throw updateError
      }
    } else {
      const { error: insertError } =
        await supabase
          .from(
            'shadow_mall_promotion_reactions'
          )
          .insert({
            promotion_id:
              promotionId,
            user_id: userId,
            reaction_type:
              reactionType,
          })

      if (insertError) {
        throw insertError
      }
    }

    const rows =
      await readReactionRows(
        promotionId
      )
    const likeCount = rows.length
    const reactionSummary =
      buildReactionSummary(rows)

    await updatePromotionLikeCount(
      promotionId,
      likeCount
    )

    return res.status(200).json({
      ok: true,
      reacted,
      reaction_type:
        nextReactionType,
      like_count: likeCount,
      reaction_summary:
        reactionSummary,
      promotion: {
        id: promotionId,
        like_count: likeCount,
        my_reaction:
          nextReactionType,
        reaction_summary:
          reactionSummary,
      },
      post: {
        id: promotionId,
        like_count: likeCount,
        my_reaction:
          nextReactionType,
        reaction_summary:
          reactionSummary,
      },
    })
  } catch (error) {
    console.error(
      'SET SHADOW MALL PROMOTION REACTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update promotion reaction',
      error: error.message,
    })
  }
}

export async function getShadowMallPromotionComments(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const sort = String(
      req.query.sort || 'top'
    )
      .trim()
      .toLowerCase()
    const {
      page,
      limit,
      from,
      to,
    } = getPagination(req)

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    let parentQuery = supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .eq(
        'promotion_id',
        promotionId
      )
      .eq('is_hidden', false)
      .is('parent_id', null)

    if (sort === 'top') {
      parentQuery = parentQuery
        .order('likes', {
          ascending: false,
        })
        .order('created_at', {
          ascending: false,
        })
    } else {
      parentQuery =
        parentQuery.order(
          'created_at',
          {
            ascending: false,
          }
        )
    }

    const {
      data: parentComments,
      error: parentError,
    } = await parentQuery.range(
      from,
      to
    )

    if (parentError) {
      throw parentError
    }

    const parentIds = (
      parentComments || []
    )
      .map((comment) => comment.id)
      .filter(Boolean)

    let replies = []

    if (parentIds.length) {
      const { data, error } =
        await supabase
          .from(
            'shadow_mall_promotion_comments'
          )
          .select(
            '*, user:users(id, name, username, avatar_url, role)'
          )
          .eq(
            'promotion_id',
            promotionId
          )
          .eq('is_hidden', false)
          .in('parent_id', parentIds)
          .order('created_at', {
            ascending: true,
          })

      if (error) throw error

      replies = data || []
    }

    const repliesByParent =
      new Map()

    for (const reply of replies) {
      const key = String(
        reply.parent_id || ''
      )
      const current =
        repliesByParent.get(key) || []

      current.push(reply)
      repliesByParent.set(
        key,
        current
      )
    }

    const combined = (
      parentComments || []
    ).map((comment) => ({
      ...comment,
      replies:
        repliesByParent.get(
          String(comment.id)
        ) || [],
    }))

    const allCommentIds =
      combined.flatMap((comment) => [
        comment.id,
        ...(comment.replies || []).map(
          (reply) => reply.id
        ),
      ])

    const reactionMap =
      await readCommentReactionMap(
        userId,
        allCommentIds
      )
    const total =
      await countVisibleComments(
        promotionId
      )

    const {
      count: parentCount,
      error: parentCountError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq(
        'promotion_id',
        promotionId
      )
      .eq('is_hidden', false)
      .is('parent_id', null)

    if (parentCountError) {
      throw parentCountError
    }

    return res.status(200).json({
      ok: true,
      comments: combined.map(
        (comment) =>
          publicComment(
            comment,
            reactionMap
          )
      ),
      page,
      limit,
      total,
      has_more:
        page * limit <
        Number(parentCount || 0),
    })
  } catch (error) {
    console.error(
      'GET SHADOW MALL PROMOTION COMMENTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load comments',
    })
  }
}

export async function createShadowMallPromotionComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const text = normalizeText(
      req.body.text
    )
    const parentId =
      String(
        req.body.parent_id ||
          req.body.parentId ||
          ''
      ).trim() || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message:
          'Comment text is required',
      })
    }

    if (text.length > COMMENT_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `Comment must be ${COMMENT_LIMIT} characters or fewer`,
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    if (parentId) {
      const {
        data: parentComment,
        error: parentError,
      } = await supabase
        .from(
          'shadow_mall_promotion_comments'
        )
        .select(
          'id, promotion_id, parent_id, is_hidden'
        )
        .eq('id', parentId)
        .eq(
          'promotion_id',
          promotionId
        )
        .eq('is_hidden', false)
        .maybeSingle()

      if (parentError) {
        throw parentError
      }

      if (
        !parentComment ||
        parentComment.parent_id
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Reply target is not valid',
        })
      }
    }

    const {
      data: createdComment,
      error: createError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .insert({
        promotion_id: promotionId,
        user_id: userId,
        parent_id: parentId,
        text,
      })
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .single()

    if (createError) {
      throw createError
    }

    const commentCount =
      await countVisibleComments(
        promotionId
      )

    await updatePromotionCommentCount(
      promotionId,
      commentCount
    )

    return res.status(201).json({
      ok: true,
      comment: publicComment(
        createdComment
      ),
      comment_count: commentCount,
    })
  } catch (error) {
    console.error(
      'CREATE SHADOW MALL PROMOTION COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to create comment',
    })
  }
}

export async function updateOwnShadowMallPromotionComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()
    const text = normalizeText(
      req.body.text
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message:
          'Comment text is required',
      })
    }

    if (text.length > COMMENT_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `Comment must be ${COMMENT_LIMIT} characters or fewer`,
      })
    }

    const {
      data: existingComment,
      error: findError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select(
        'id, user_id, is_hidden'
      )
      .eq('id', commentId)
      .maybeSingle()

    if (findError) throw findError

    if (
      !existingComment ||
      existingComment.is_hidden
    ) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    if (
      String(
        existingComment.user_id
      ) !== String(userId)
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'You can only edit your own comment',
      })
    }

    const {
      data: updatedComment,
      error: updateError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .update({
        text,
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', commentId)
      .eq('user_id', userId)
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .single()

    if (updateError) {
      throw updateError
    }

    const { data: reaction } =
      await supabase
        .from(
          'shadow_mall_promotion_comment_likes'
        )
        .select(
          'comment_id, reaction_type'
        )
        .eq(
          'comment_id',
          commentId
        )
        .eq('user_id', userId)
        .maybeSingle()

    const reactionMap = new Map()

    if (reaction?.comment_id) {
      const reactionType =
        normalizeReactionType(
          reaction.reaction_type
        )

      if (
        ALLOWED_REACTIONS.has(
          reactionType
        )
      ) {
        reactionMap.set(
          String(reaction.comment_id),
          reactionType
        )
      }
    }

    return res.status(200).json({
      ok: true,
      comment: publicComment(
        updatedComment,
        reactionMap
      ),
    })
  } catch (error) {
    console.error(
      'UPDATE SHADOW MALL PROMOTION COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to update comment',
    })
  }
}

export async function deleteOwnShadowMallPromotionComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const {
      data: existingComment,
      error: findError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select(
        'id, promotion_id, user_id, parent_id'
      )
      .eq('id', commentId)
      .maybeSingle()

    if (findError) throw findError

    if (!existingComment) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    if (
      String(
        existingComment.user_id
      ) !== String(userId)
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'You can only delete your own comment',
      })
    }

    const { error: deleteError } =
      await supabase
        .from(
          'shadow_mall_promotion_comments'
        )
        .delete()
        .eq('id', commentId)
        .eq('user_id', userId)

    if (deleteError) {
      throw deleteError
    }

    const commentCount =
      await countVisibleComments(
        existingComment.promotion_id
      )

    await updatePromotionCommentCount(
      existingComment.promotion_id,
      commentCount
    )

    return res.status(200).json({
      ok: true,
      message: 'Comment deleted',
      comment_count: commentCount,
    })
  } catch (error) {
    console.error(
      'DELETE SHADOW MALL PROMOTION COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to delete comment',
    })
  }
}

export async function toggleShadowMallPromotionCommentLike(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()
    const reactionType =
      normalizeReactionType(
        req.body?.reaction_type ||
          req.body?.reactionType
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (
      !ALLOWED_REACTIONS.has(
        reactionType
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Invalid reaction type',
      })
    }

    const {
      data: comment,
      error: commentError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select('id, is_hidden')
      .eq('id', commentId)
      .maybeSingle()

    if (commentError) {
      throw commentError
    }

    if (
      !comment ||
      comment.is_hidden
    ) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    const {
      data: existingLike,
      error: likeLookupError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comment_likes'
      )
      .select(
        'id, reaction_type'
      )
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle()

    if (likeLookupError) {
      throw likeLookupError
    }

    let liked = true
    let activeReactionType =
      reactionType

    if (
      existingLike?.reaction_type ===
      reactionType
    ) {
      const { error } =
        await supabase
          .from(
            'shadow_mall_promotion_comment_likes'
          )
          .delete()
          .eq('id', existingLike.id)

      if (error) throw error

      liked = false
      activeReactionType = null
    } else if (existingLike?.id) {
      const { error } =
        await supabase
          .from(
            'shadow_mall_promotion_comment_likes'
          )
          .update({
            reaction_type:
              reactionType,
          })
          .eq('id', existingLike.id)

      if (error) throw error
    } else {
      const { error } =
        await supabase
          .from(
            'shadow_mall_promotion_comment_likes'
          )
          .insert({
            comment_id: commentId,
            user_id: userId,
            reaction_type:
              reactionType,
          })

      if (error) throw error
    }

    const {
      count,
      error: countError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comment_likes'
      )
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('comment_id', commentId)

    if (countError) {
      throw countError
    }

    const likes = Number(count || 0)

    const { error: updateError } =
      await supabase
        .from(
          'shadow_mall_promotion_comments'
        )
        .update({ likes })
        .eq('id', commentId)

    if (updateError) {
      throw updateError
    }

    return res.status(200).json({
      ok: true,
      comment_id: commentId,
      liked,
      reaction_type:
        activeReactionType,
      likes,
    })
  } catch (error) {
    console.error(
      'TOGGLE SHADOW MALL PROMOTION COMMENT REACTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to update reaction',
    })
  }
}

export async function getShadowMallPromotionEchoes(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const page = Math.max(
      1,
      Number(req.query.page || 1)
    )
    const limit = Math.min(
      50,
      Math.max(
        1,
        Number(req.query.limit || 20)
      )
    )
    const from =
      (page - 1) * limit
    const to = from + limit - 1

    if (!viewerId) {
      return res.status(401).json({
        ok: false,
        message:
          'Login is required',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const { data, error, count } =
      await supabase
        .from(
          'shadow_mall_promotion_echoes'
        )
        .select(
          'id, promotion_id, user_id, echo_text, destination, audience, created_at, user:users(id, name, username, avatar_url)',
          { count: 'exact' }
        )
        .eq(
          'promotion_id',
          promotionId
        )
        .or(
          `audience.eq.public,user_id.eq.${viewerId}`
        )
        .order('created_at', {
          ascending: false,
        })
        .range(from, to)

    if (error) throw error

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      promotion: {
        id: promotion.id,
        sponsor:
          promotion.sponsor ||
          'Shadow Mall',
        title:
          promotion.title || '',
        description:
          promotion.description || '',
        echo_count: Number(
          promotion.echo_count || 0
        ),
      },
      post: {
        id: String(promotion.id),
        user_id: null,
        content:
          promotion.description ||
          promotion.title ||
          '',
        echo_count: Number(
          promotion.echo_count || 0
        ),
        user: {
          id: null,
          name:
            promotion.sponsor ||
            'Shadow Mall',
          username: '',
          avatar_url:
            promotion.profile_image_url ||
            '',
        },
      },
      total,
      page,
      limit,
      has_more:
        to + 1 < total,
      echoes: (data || []).map(
        publicEcho
      ),
    })
  } catch (error) {
    console.error(
      'GET SHADOW MALL PROMOTION ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load promotion echoes',
    })
  }
}

export async function createShadowMallPromotionEcho(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message:
          'Login is required',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const echoText = cleanText(
      req.body?.echo_text,
      280
    )
    const destination =
      normalizeChoice(
        req.body?.destination,
        DESTINATIONS,
        'feed'
      )
    const audience =
      normalizeChoice(
        req.body?.audience,
        AUDIENCES,
        'public'
      )

    const { data, error } =
      await supabase
        .from(
          'shadow_mall_promotion_echoes'
        )
        .insert({
          promotion_id:
            promotionId,
          user_id: userId,
          echo_text: echoText,
          destination,
          audience,
        })
        .select(
          'id, promotion_id, user_id, echo_text, destination, audience, created_at'
        )
        .single()

    if (error) throw error

    const echoCount =
      await readEchoCount(
        promotionId
      )

    await updatePromotionEchoCount(
      promotionId,
      echoCount
    )

    const reader =
      await readUser(userId)

    return res.status(201).json({
      ok: true,
      echo_count: echoCount,
      echo: publicEcho({
        ...data,
        user: reader,
      }),
    })
  } catch (error) {
    console.error(
      'CREATE SHADOW MALL PROMOTION ECHO ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to echo promotion',
    })
  }
}
