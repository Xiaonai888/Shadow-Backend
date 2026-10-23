import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'
import {
  getCachedMyAuthorPage,
  invalidateMyAuthorPageCache,
} from '../services/myAuthorPageCache.service.js'
import {
  createAuthorPageNotificationSafely,
  deleteAuthorPageNotificationBySourceKeySafely,
} from '../services/authorPageNotifications.service.js'
import {
  applyAdultStoryVisibility,
  getReaderAgeAccess,
} from '../services/storyAgeAccess.service.js'

function normalizePageUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}
function isValidPageUsername(username) {
  return /^[a-z0-9_]+$/.test(username)
}

function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name,
    page_username: page.page_username,
    page_slug: page.page_slug,
    bio: page.bio,
    avatar_url: page.avatar_url,
    cover_url: page.cover_url,
    slide_urls: Array.isArray(page.slide_urls) ? page.slide_urls : [],
profile_details: page.profile_details || {},
status: page.status,
    total_stories: page.total_stories,
    total_followers: page.total_followers,
    created_at: page.created_at,
    updated_at: page.updated_at,
  }
}

function publicAuthorWork(story) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    story_status: story.story_status || 'New',
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

async function getAuthorPageWorks(
  authorPageId,
  canViewAdultStories = false
) {
  if (!authorPageId) return []

  let query = supabase
    .from('stories')
    .select(
      'id, author_id, user_id, title, story_language, main_genre, story_status, tags, description, is_adult, cover_url, status, access_type, total_episodes, total_views, total_likes, total_comments, created_at, updated_at'
    )
    .eq('author_id', authorPageId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('updated_at', {
      ascending: false,
    })

  query = applyAdultStoryVisibility(query, {
    can_view_adult_stories:
      canViewAdultStories,
  })

  const { data, error } = await query

  if (error) throw error

  return (data || []).map(publicAuthorWork)
}

function getOptionalUserId(req) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : ''

    if (!token) return null

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    if (decoded.type !== 'reader') return null

    return decoded.user_id || null
  } catch {
    return null
  }
}

async function getFollowCount(authorPageId) {
  const { count, error } = await supabase
    .from('author_page_follows')
    .select('id', { count: 'exact', head: true })
    .eq('author_page_id', authorPageId)

  if (error) throw error

  return Number(count || 0)
}

async function syncAuthorFollowerCount(authorPageId) {
  const totalFollowers = await getFollowCount(authorPageId)

  const { data, error } = await supabase
    .from('author_pages')
    .update({
      total_followers: totalFollowers,
      updated_at: new Date().toISOString(),
    })
    .eq('id', authorPageId)
    .select()
    .single()

  if (error) throw error

  return data
}

async function getFollowStatus(authorPageId, userId) {
  if (!authorPageId || !userId) return false

  const { data, error } = await supabase
    .from('author_page_follows')
    .select('id')
    .eq('author_page_id', authorPageId)
    .eq('follower_user_id', userId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data)
}

async function getExactAuthorRank(authorPage) {
  if (!authorPage?.id || String(authorPage.status || '').toLowerCase() !== 'active') {
    return null
  }

  const totalFollowers = Number(authorPage.total_followers || 0)
  const updatedAt = authorPage.updated_at || authorPage.created_at || new Date(0).toISOString()

  const [
    greaterFollowersResult,
    sameFollowersNewerResult,
    exactTieEarlierIdResult,
  ] = await Promise.all([
    supabase
      .from('author_pages')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .gt('total_followers', totalFollowers),

    supabase
      .from('author_pages')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .eq('total_followers', totalFollowers)
      .gt('updated_at', updatedAt),

    supabase
      .from('author_pages')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .eq('total_followers', totalFollowers)
      .eq('updated_at', updatedAt)
      .lt('id', authorPage.id),
  ])

  if (greaterFollowersResult.error) throw greaterFollowersResult.error
  if (sameFollowersNewerResult.error) throw sameFollowersNewerResult.error
  if (exactTieEarlierIdResult.error) throw exactTieEarlierIdResult.error

  return (
    Number(greaterFollowersResult.count || 0) +
    Number(sameFollowersNewerResult.count || 0) +
    Number(exactTieEarlierIdResult.count || 0) +
    1
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthorPageFooterVisibility } from '../../components/AuthorPageFooterShell'
import { SalesReportsSettingsMenuItem, SalesReportsSettingsPage } from './SalesReportsSettings'
import { getDisplayLanguageId, getDisplayText, useDisplayTranslation } from '../../utils/displayLanguage'
import { registerTranslationNamespace } from '../../i18n/registerTranslations'
import { optimizeImageForUpload } from '../../utils/imageUploadOptimizer'
import { uploadMediaWithFallback } from '../../utils/uploadMediaWithFallback'
import { createUploadQueueManager } from '../../utils/uploadQueueManager'
import { readMediaUploadFile, requestUploadStoragePersistence } from '../../utils/uploadQueueDB'
import AuthorStoreAvailableWithdrawalCard from './AuthorStoreAvailableWithdrawalCard'
import AuthorPdfUploadProgress from '../../components/author/AuthorPdfUploadProgress'
import {
  AUTHOR_STORE_PRODUCT_PAGE_SIZE,
  fetchAuthorStoreProductPage,
  readAuthorStoreProductCache,
  rememberAuthorStoreProductView,
  invalidateAuthorStoreProductCache,
} from '../../utils/authorStoreProductsCache'
import {
  fetchAuthorStoreResource,
  readAuthorStoreResourceCache,
  invalidateAuthorStoreResourceCache,
  writeAuthorStoreResourceCache,
} from '../../utils/authorStoreResourceCache'

registerTranslationNamespace('authorStoreManager', {
  "en": {
    "pleaseLogin": "Please login first",
    "uploadCoverFailed": "Failed to upload cover image",
    "uploadGalleryFailed": "Failed to upload gallery image",
    "pdfRequired": "PDF file is required",
    "uploadPdfFailed": "Failed to upload private PDF",
    "productIdRequired": "Product ID is required",
    "pdfStorageMissing": "Private PDF storage key is missing",
    "attachPdfFailed": "Failed to attach private PDF",
    "loadProductsFailed": "Failed to load products",
    "loadPromotionFailed": "Failed to load promotion",
    "loadOrdersFailed": "Failed to load orders",
    "markPreparingFailed": "Failed to mark preparing",
    "loadDeliveryFailed": "Failed to load delivery settings",
    "loadTelegramFailed": "Failed to load Telegram settings",
    "connectTelegramFailed": "Failed to create Telegram connect link",
    "unlinkTelegramFailed": "Failed to unlink Telegram group",
    "loadSalesReportsFailed": "Failed to load Sales Reports settings",
    "connectSheetFailed": "Failed to connect Google Sheet",
    "syncSalesReportsFailed": "Failed to sync Sales Reports",
    "disconnectSheetFailed": "Failed to disconnect Google Sheet",
    "updateDeliveryFailed": "Failed to update delivery settings",
    "loadCategoriesFailed": "Failed to load categories",
    "createCategoryFailed": "Failed to create category",
    "updateCategoryFailed": "Failed to update category",
    "deleteCategoryFailed": "Failed to delete category",
    "saveCategoryOrderFailed": "Failed to save category order",
    "author": "Author",
    "untitledProduct": "Untitled product",
    "productOptions": "Product options",
    "closeProductMenu": "Close product menu",
    "edit": "Edit",
    "delete": "Delete",
    "stockCount": "{{count}} stock",
    "pageCountPdf": "{{count}} pages • PDF",
    "orderItem": "Order item",
    "reader": "Reader",
    "orderNumber": "Order #{{number}}",
    "income": "Income {{amount}}",
    "item": "item",
    "items": "items",
    "preparing": "Preparing ✓",
    "saving": "Saving...",
    "markPreparing": "Mark Preparing",
    "pdfOrder": "PDF order",
    "closeMenu": "Close menu",
    "authorMenu": "Author Menu",
    "switchProfile": "Switch Profile",
    "finance": "Finance",
    "settings": "Settings",
    "orders": "Orders",
    "netIncome": "Net income",
    "serviceFeePromotion": "0% Service Fee Promotion",
    "book": "Book",
    "pdf": "PDF",
    "records": "Records",
    "bookRecords": "Book Records",
    "searchManageProducts": "Search, filter, and manage your author store products.",
    "productsCount": "{{count}} products",
    "searchProducts": "Search title, category, product ID...",
    "filterProductRecords": "Filter product records",
    "closeRecordFilter": "Close record filter",
    "newestFirst": "Newest first",
    "recentlyUpdated": "Recently updated",
    "lowStock": "Low stock",
    "soldOut": "Sold out",
    "oldestFirst": "Oldest first",
    "all": "All",
    "active": "Active",
    "draft": "Draft",
    "hidden": "Hidden",
    "loadingProducts": "Loading products...",
    "noMatchingProducts": "No matching products",
    "tryAnotherSearch": "Try another search or filter.",
    "createFirstProduct": "Create your first product",
    "createFirstProductHelp": "Add a book or PDF and start selling from your author page.",
    "addProduct": "Add product",
    "preOrder": "Pre-order",
    "storeSettings": "Store Settings",
    "storeSettingsHelp": "Manage store sections and checkout settings.",
    "categoryManagement": "Category Management",
    "categoryManagementHelp": "Categories, hidden sections, and order.",
    "deliveryCompany": "Delivery Company",
    "deliveryCompanyHelp": "J&T fee, VET fee, and checkout delivery.",
    "telegramBot": "Telegram Bot",
    "telegramBotHelp": "Connect order approval notifications to your Telegram group.",
    "createCustomCategory": "Create custom category",
    "customCategoryHelp": "You can create up to 5 custom categories.",
    "categoryName": "Category name",
    "categoryLimitReached": "Custom category limit reached",
    "add": "Add",
    "categoryLimitHelp": "Custom category limit reached. Delete one custom category before creating a new one.",
    "categories": "Categories",
    "saveOrder": "Save order",
    "system": "System",
    "show": "Show",
    "hide": "Hide",
    "save": "Save",
    "cancel": "Cancel",
    "setDeliveryFees": "Set delivery fees for reader checkout.",
    "deliveryFees": "Delivery fees",
    "deliveryFeesHelp": "These fees will be added to checkout total.",
    "jntHelp": "J&T Express delivery for printed books.",
    "vetHelp": "Virak Buntham Express delivery option.",
    "deliveryFee": "Delivery fee",
    "deliveryFeesSaved": "Delivery fees saved.",
    "saveDeliveryFailed": "Failed to save delivery fees.",
    "saveDeliveryFees": "Save delivery fees",
    "receiveTelegram": "Receive Telegram Notifications",
    "receiveTelegramHelp": "Link this author page to one Telegram group for order approval alerts. You can change groups only after unlinking the current one.",
    "telegramLinkMissing": "Telegram connect link was created, but the link was missing.",
    "openTelegramFailed": "Failed to open Telegram connect link.",
    "telegramUnlinked": "Telegram group unlinked. You can connect a new group now.",
    "unlinkTelegramFailedUi": "Failed to unlink Telegram group.",
    "linkedGroup": "Linked group",
    "groupId": "Group ID: {{id}}",
    "linkedAt": "Linked: {{date}}",
    "oneTelegramGroup": "This author page can use only one Telegram group. To connect another group, unlink this group first.",
    "unlinking": "Unlinking...",
    "unlinkGroup": "Unlink group",
    "howToConnect": "How to connect",
    "telegramStep1": "Tap Connect Telegram Group.",
    "telegramStep2": "Telegram will open and ask you to choose a group.",
    "telegramStep3": "Add @{{bot}} to that group.",
    "telegramStep4": "The bot will confirm when the group is linked.",
    "openingTelegram": "Opening Telegram...",
    "loading": "Loading...",
    "connectTelegramGroup": "Connect Telegram Group",
    "orderHistory": "Order history",
    "orderHistoryHelp": "Orders checked by admin from your author store.",
    "searchOrders": "Search order, buyer, product...",
    "filterOrders": "Filter orders",
    "closeOrderFilter": "Close order filter",
    "allOrders": "All",
    "toPrepare": "To prepare",
    "preparingFilter": "Preparing",
    "loadingOrders": "Loading orders...",
    "previous": "Previous",
    "next": "Next",
    "pageOf": "Page {{page}} / {{total}}",
    "noOrders": "No orders yet",
    "noOrdersHelp": "New confirmed orders from your author store will appear here.",
    "imageNumber": "Image {{number}}",
    "choose": "Choose",
    "clear": "Clear",
    "coverRecommendation": "Recommended vertical 2:3 ratio, JPG, PNG, or WEBP.",
    "bookCoverPreview": "Book Cover Preview",
    "vertical23": "2:3 vertical",
    "clearBookCover": "Clear Book Cover",
    "galleryHelp": "Maximum 5 vertical gallery images. These help readers see more details before buying.",
    "bookInformation": "Book Information",
    "bookInformationHelp": "Add book details for your author store.",
    "productType": "Product type",
    "bookTitle": "Book title",
    "authorName": "Author name",
    "publisher": "Publisher",
    "novelType": "Novel type",
    "category": "Category",
    "selectCategory": "Select category",
    "genre": "Genre",
    "condition": "Condition",
    "paperType": "Paper type",
    "coverType": "Cover type",
    "pageCount": "Page count",
    "conditionNote": "Condition note",
    "conditionNoteHelp": "Enter the estimated book quality from 1% to 100%.",
    "salePrice": "Sale price",
    "originalPrice": "Original price",
    "stockQuantity": "Stock quantity",
    "sortOrder": "Sort order",
    "preOrderProduct": "Pre-order product",
    "bestSellerProduct": "Best seller product",
    "discountProduct": "Discount product",
    "pdfFile": "PDF file",
    "pdfSelected": "PDF selected",
    "pdfAttached": "PDF attached",
    "accessRule": "Access rule",
    "conditionLabel": "Condition label",
    "description": "Description",
    "createProduct": "Create Product",
    "saveProduct": "Save Product",
    "editProduct": "Edit Product",
    "store": "Store",
    "newBooks": "New Books",
    "secondHand": "Second Hand",
    "bestSeller": "Best Seller",
    "pdfBooks": "PDF Books",
    "authorPicks": "Author Picks",
    "newRelease": "New Release",
    "normalPaper": "Normal Paper",
    "premiumPaper": "Premium Paper",
    "matteCover": "Matte Cover",
    "glossyCover": "Glossy Cover",
    "new": "New",
    "readOnlineOnly": "Read online only",
    "downloadAfterPayment": "Download after payment",
    "downloadAndReadOnline": "Download and read online",
    "selectImageFile": "Please select an image file.",
    "imageTooLarge": "Image must be 5MB or smaller.",
    "selectPdfFile": "Please select a PDF file.",
    "pdfTooLarge": "PDF file is too large.",
    "titleRequired": "Product title is required.",
    "authorRequired": "Author name is required.",
    "categoryRequired": "Category is required.",
    "salePriceRequired": "Sale price is required.",
    "coverRequired": "Book cover is required.",
    "pdfFileRequired": "PDF file is required.",
    "deleteProductConfirm": "Delete “{{title}}”?",
    "deleteProductFailed": "Failed to delete product",
    "productSaved": "Product saved.",
    "productSaveFailed": "Failed to save product",
    "productCreated": "Product created.",
    "productCreateFailed": "Failed to create product",
    "activeLabel": "Active",
    "closeMessage": "Close message",
    "paperBook": "Printed book",
    "productDetails": "Product details",
    "galleryImages": "Gallery images",
    "replacePdf": "Replace PDF",
    "choosePdf": "Choose PDF",
    "selectFile": "Select file",
    "pdfHelp": "Upload a private PDF for readers who purchase this product.",
    "qualityPercent": "Quality %",
    "deliveryNote": "Delivery note",
    "deliveryNotePlaceholder": "Optional delivery information",
    "coverImage": "Cover image",
    "galleryImage": "Gallery image",
    "noImage": "No image",
    "orderSearchPlaceholder": "Search orders...",
    "recordsSearchPlaceholder": "Search products...",
    "productId": "ID: {{id}}",
    "stockDetail": "{{count}} stock • {{condition}}",
    "stockQualityDetail": "{{count}} stock • {{condition}} • {{quality}}%",
    "pagePdfDetail": "{{count}} pages • PDF",
    "bookInformationDivider": "Book information",
    "saleStock": "Sale & stock",
    "coverSectionTitle": "Book Cover",
    "coverSectionHelp": "Upload the vertical cover shown on product cards.",
    "mainCover": "Main cover",
    "coverPreview": "Cover preview",
    "chooseReplaceCover": "Click or drop to replace cover",
    "chooseCover": "Click or drop book cover here",
    "gallerySectionTitle": "Book Gallery",
    "gallerySectionHelp": "Upload extra vertical images shown on the product detail page.",
    "extraBookImages": "Extra book images",
    "enterBookTitle": "Enter book title",
    "authorNamePlaceholder": "Author name",
    "publisherPlaceholder": "Publisher",
    "novelTypePlaceholder": "Example: Khmer, English, Chinese...",
    "genrePlaceholder": "Romance, fantasy, mystery...",
    "paperTypePlaceholder": "Example: Normal paper, glossy paper, cream paper...",
    "coverTypePlaceholder": "Example: Paperback, hardcover...",
    "pageCountPlaceholder": "Example: 436",
    "qualityPlaceholder": "Example: 85",
    "salePricePlaceholder": "Example: 8.75",
    "originalPricePlaceholder": "Leave empty if no discount",
    "stockPlaceholder": "Example: 10",
    "validCoverImage": "Please upload a valid cover image.",
    "validGalleryImage": "Please upload a valid gallery image.",
    "validPdf": "Please upload a valid PDF file.",
    "pdfSizeLimit": "PDF file must be 50 MB or smaller.",
    "replaceAttachedPdf": "Replace attached PDF",
    "pageCountPdfPlaceholder": "Example: 120",
    "conditionPlaceholder": "New, Like new, Good, Fair...",
    "descriptionPlaceholder": "Book details, condition, delivery note, or pre-order note...",
    "bookTitleRequired": "Book title is required.",
    "sellPriceRequired": "Sell price is required.",
    "stockNonNegative": "Stock quantity cannot be negative.",
    "qualityRange": "Book quality must be between 1% and 100%.",
    "pdfUploadTryAgain": "PDF upload failed. Please try again.",
    "pdfUploadedReady": "PDF uploaded successfully. Ready to create product.",
    "pdfUploadingWait": "Wait until the PDF upload finishes.",
    "pdfRetryUpload": "Retry PDF upload",
    "pdfInvalidContents": "The selected file is not a valid PDF.",
    "pdfEmptyFile": "The PDF file is empty.",
    "pdfAttachNotConfirmed": "PDF could not be verified on the product. Please try again.",
    "saveTryAgain": "Save failed. Please try again.",
    "loadProductsUiFailed": "Failed to load products",
    "loadCategoriesUiFailed": "Failed to load categories",
    "createCategoryUiFailed": "Failed to create category",
    "updateCategoryUiFailed": "Failed to update category",
    "deleteCategoryUiFailed": "Failed to delete category",
    "saveCategoryOrderUiFailed": "Failed to save category order",
    "productNotSaved": "Product was not saved",
    "savedSuccessfully": "Saved successfully",
    "deleteThisProduct": "this product",
    "searchOrderPlaceholder": "Search order ID, buyer name, phone...",
    "storeTitle": "Store",
    "mainCoverAlt": "Book cover",
    "galleryImageAlt": "Image {{number}}",
    "searching": "Searching..."
  },
  "km": {
    "pleaseLogin": "សូមចូលគណនីជាមុន",
    "uploadCoverFailed": "មិនអាចបង្ហោះរូបគម្របបានទេ",
    "uploadGalleryFailed": "មិនអាចបង្ហោះរូបវិចិត្រសាលបានទេ",
    "pdfRequired": "ត្រូវការឯកសារ PDF",
    "uploadPdfFailed": "មិនអាចបង្ហោះ PDF ឯកជនបានទេ",
    "productIdRequired": "ត្រូវការ Product ID",
    "pdfStorageMissing": "បាត់ storage key របស់ PDF ឯកជន",
    "attachPdfFailed": "មិនអាចភ្ជាប់ PDF ឯកជនបានទេ",
    "loadProductsFailed": "មិនអាចផ្ទុកផលិតផលបានទេ",
    "loadPromotionFailed": "មិនអាចផ្ទុកប្រម៉ូសិនបានទេ",
    "loadOrdersFailed": "មិនអាចផ្ទុកការបញ្ជាទិញបានទេ",
    "markPreparingFailed": "មិនអាចសម្គាល់ថាកំពុងរៀបចំបានទេ",
    "loadDeliveryFailed": "មិនអាចផ្ទុកការកំណត់ដឹកជញ្ជូនបានទេ",
    "loadTelegramFailed": "មិនអាចផ្ទុកការកំណត់ Telegram បានទេ",
    "connectTelegramFailed": "មិនអាចបង្កើតតំណភ្ជាប់ Telegram បានទេ",
    "unlinkTelegramFailed": "មិនអាចផ្តាច់ក្រុម Telegram បានទេ",
    "loadSalesReportsFailed": "មិនអាចផ្ទុកការកំណត់ Sales Reports បានទេ",
    "connectSheetFailed": "មិនអាចភ្ជាប់ Google Sheet បានទេ",
    "syncSalesReportsFailed": "មិនអាច Sync Sales Reports បានទេ",
    "disconnectSheetFailed": "មិនអាចផ្តាច់ Google Sheet បានទេ",
    "updateDeliveryFailed": "មិនអាចកែការកំណត់ដឹកជញ្ជូនបានទេ",
    "loadCategoriesFailed": "មិនអាចផ្ទុកប្រភេទបានទេ",
    "createCategoryFailed": "មិនអាចបង្កើតប្រភេទបានទេ",
    "updateCategoryFailed": "មិនអាចកែប្រភេទបានទេ",
    "deleteCategoryFailed": "មិនអាចលុបប្រភេទបានទេ",
    "saveCategoryOrderFailed": "មិនអាចរក្សាទុកលំដាប់ប្រភេទបានទេ",
    "author": "អ្នកនិពន្ធ",
    "untitledProduct": "ផលិតផលគ្មានចំណងជើង",
    "productOptions": "ជម្រើសផលិតផល",
    "closeProductMenu": "បិទម៉ឺនុយផលិតផល",
    "edit": "កែ",
    "delete": "លុប",
    "stockCount": "ស្តុក {{count}}",
    "pageCountPdf": "{{count}} ទំព័រ • PDF",
    "orderItem": "ទំនិញក្នុងការបញ្ជាទិញ",
    "reader": "អ្នកអាន",
    "orderNumber": "ការបញ្ជាទិញ #{{number}}",
    "income": "ចំណូល {{amount}}",
    "item": "ទំនិញ",
    "items": "ទំនិញ",
    "preparing": "កំពុងរៀបចំ ✓",
    "saving": "កំពុងរក្សាទុក...",
    "markPreparing": "សម្គាល់ថាកំពុងរៀបចំ",
    "pdfOrder": "ការបញ្ជាទិញ PDF",
    "closeMenu": "បិទម៉ឺនុយ",
    "authorMenu": "ម៉ឺនុយអ្នកនិពន្ធ",
    "switchProfile": "ប្តូរប្រវត្តិរូប",
    "finance": "ហិរញ្ញវត្ថុ",
    "settings": "ការកំណត់",
    "orders": "ការបញ្ជាទិញ",
    "netIncome": "ចំណូលសុទ្ធ",
    "serviceFeePromotion": "ប្រម៉ូសិនថ្លៃសេវា 0%",
    "book": "សៀវភៅ",
    "pdf": "PDF",
    "records": "កំណត់ត្រា",
    "bookRecords": "កំណត់ត្រាសៀវភៅ",
    "searchManageProducts": "ស្វែងរក តម្រង និងគ្រប់គ្រងផលិតផលក្នុងហាងអ្នកនិពន្ធ។",
    "productsCount": "ផលិតផល {{count}}",
    "searchProducts": "ស្វែងរកចំណងជើង ប្រភេទ ឬ Product ID...",
    "filterProductRecords": "តម្រងកំណត់ត្រាផលិតផល",
    "closeRecordFilter": "បិទតម្រងកំណត់ត្រា",
    "newestFirst": "ថ្មីបំផុតមុន",
    "recentlyUpdated": "ទើបកែថ្មីៗ",
    "lowStock": "ស្តុកតិច",
    "soldOut": "អស់ស្តុក",
    "oldestFirst": "ចាស់បំផុតមុន",
    "all": "ទាំងអស់",
    "active": "សកម្ម",
    "draft": "ព្រាង",
    "hidden": "បានលាក់",
    "loadingProducts": "កំពុងផ្ទុកផលិតផល...",
    "noMatchingProducts": "រកមិនឃើញផលិតផលដែលត្រូវគ្នា",
    "tryAnotherSearch": "សាកស្វែងរក ឬតម្រងផ្សេង។",
    "createFirstProduct": "បង្កើតផលិតផលដំបូងរបស់អ្នក",
    "createFirstProductHelp": "បន្ថែមសៀវភៅ ឬ PDF ហើយចាប់ផ្តើមលក់ពីទំព័រអ្នកនិពន្ធ។",
    "addProduct": "បន្ថែមផលិតផល",
    "preOrder": "កក់ទុកមុន",
    "storeSettings": "ការកំណត់ហាង",
    "storeSettingsHelp": "គ្រប់គ្រងផ្នែកហាង និងការកំណត់ Checkout។",
    "categoryManagement": "គ្រប់គ្រងប្រភេទ",
    "categoryManagementHelp": "ប្រភេទ ផ្នែកដែលលាក់ និងលំដាប់។",
    "deliveryCompany": "ក្រុមហ៊ុនដឹកជញ្ជូន",
    "deliveryCompanyHelp": "ថ្លៃ J&T ថ្លៃ VET និងការដឹកជញ្ជូនពេល Checkout។",
    "telegramBot": "Telegram Bot",
    "telegramBotHelp": "ភ្ជាប់ការជូនដំណឹងអនុម័តការបញ្ជាទិញទៅក្រុម Telegram របស់អ្នក។",
    "createCustomCategory": "បង្កើតប្រភេទផ្ទាល់ខ្លួន",
    "customCategoryHelp": "អ្នកអាចបង្កើតប្រភេទផ្ទាល់ខ្លួនបានរហូតដល់ 5។",
    "categoryName": "ឈ្មោះប្រភេទ",
    "categoryLimitReached": "ដល់កំណត់ប្រភេទផ្ទាល់ខ្លួន",
    "add": "បន្ថែម",
    "categoryLimitHelp": "បានដល់កំណត់ប្រភេទផ្ទាល់ខ្លួន។ សូមលុបមួយសិន មុនបង្កើតថ្មី។",
    "categories": "ប្រភេទ",
    "saveOrder": "រក្សាទុកលំដាប់",
    "system": "ប្រព័ន្ធ",
    "show": "បង្ហាញ",
    "hide": "លាក់",
    "save": "រក្សាទុក",
    "cancel": "បោះបង់",
    "setDeliveryFees": "កំណត់ថ្លៃដឹកជញ្ជូនសម្រាប់ Checkout របស់អ្នកអាន។",
    "deliveryFees": "ថ្លៃដឹកជញ្ជូន",
    "deliveryFeesHelp": "ថ្លៃទាំងនេះនឹងបន្ថែមទៅសរុប Checkout។",
    "jntHelp": "ដឹកជញ្ជូនសៀវភៅបោះពុម្ពតាម J&T Express។",
    "vetHelp": "ជម្រើសដឹកជញ្ជូន Virak Buntham Express។",
    "deliveryFee": "ថ្លៃដឹកជញ្ជូន",
    "deliveryFeesSaved": "បានរក្សាទុកថ្លៃដឹកជញ្ជូន។",
    "saveDeliveryFailed": "មិនអាចរក្សាទុកថ្លៃដឹកជញ្ជូនបានទេ។",
    "saveDeliveryFees": "រក្សាទុកថ្លៃដឹកជញ្ជូន",
    "receiveTelegram": "ទទួលការជូនដំណឹងតាម Telegram",
    "receiveTelegramHelp": "ភ្ជាប់ទំព័រអ្នកនិពន្ធនេះទៅក្រុម Telegram មួយសម្រាប់ការជូនដំណឹងអនុម័តការបញ្ជាទិញ។ អ្នកអាចប្តូរក្រុមបាន បន្ទាប់ពីផ្តាច់ក្រុមបច្ចុប្បន្ន។",
    "telegramLinkMissing": "បានបង្កើតតំណភ្ជាប់ Telegram ប៉ុន្តែរកមិនឃើញតំណ។",
    "openTelegramFailed": "មិនអាចបើកតំណភ្ជាប់ Telegram បានទេ។",
    "telegramUnlinked": "បានផ្តាច់ក្រុម Telegram។ ឥឡូវអ្នកអាចភ្ជាប់ក្រុមថ្មីបាន។",
    "unlinkTelegramFailedUi": "មិនអាចផ្តាច់ក្រុម Telegram បានទេ។",
    "linkedGroup": "ក្រុមដែលបានភ្ជាប់",
    "groupId": "Group ID: {{id}}",
    "linkedAt": "បានភ្ជាប់៖ {{date}}",
    "oneTelegramGroup": "ទំព័រអ្នកនិពន្ធនេះអាចប្រើក្រុម Telegram តែមួយ។ ដើម្បីភ្ជាប់ក្រុមផ្សេង សូមផ្តាច់ក្រុមនេះជាមុន។",
    "unlinking": "កំពុងផ្តាច់...",
    "unlinkGroup": "ផ្តាច់ក្រុម",
    "howToConnect": "របៀបភ្ជាប់",
    "telegramStep1": "ចុច ភ្ជាប់ក្រុម Telegram។",
    "telegramStep2": "Telegram នឹងបើក ហើយឱ្យអ្នកជ្រើសក្រុម។",
    "telegramStep3": "បន្ថែម @{{bot}} ទៅក្នុងក្រុមនោះ។",
    "telegramStep4": "Bot នឹងបញ្ជាក់ពេលក្រុមត្រូវបានភ្ជាប់។",
    "openingTelegram": "កំពុងបើក Telegram...",
    "loading": "កំពុងផ្ទុក...",
    "connectTelegramGroup": "ភ្ជាប់ក្រុម Telegram",
    "orderHistory": "ប្រវត្តិបញ្ជាទិញ",
    "orderHistoryHelp": "ការបញ្ជាទិញពីហាងអ្នកនិពន្ធដែល Admin បានពិនិត្យ។",
    "searchOrders": "ស្វែងរកការបញ្ជាទិញ អ្នកទិញ ឬផលិតផល...",
    "filterOrders": "តម្រងការបញ្ជាទិញ",
    "closeOrderFilter": "បិទតម្រងការបញ្ជាទិញ",
    "allOrders": "ទាំងអស់",
    "toPrepare": "ត្រូវរៀបចំ",
    "preparingFilter": "កំពុងរៀបចំ",
    "loadingOrders": "កំពុងផ្ទុកការបញ្ជាទិញ...",
    "previous": "មុន",
    "next": "បន្ទាប់",
    "pageOf": "ទំព័រ {{page}} / {{total}}",
    "noOrders": "មិនទាន់មានការបញ្ជាទិញ",
    "noOrdersHelp": "ការបញ្ជាទិញថ្មីដែលបានបញ្ជាក់ពីហាងអ្នកនិពន្ធនឹងបង្ហាញនៅទីនេះ។",
    "imageNumber": "រូប {{number}}",
    "choose": "ជ្រើស",
    "clear": "សម្អាត",
    "coverRecommendation": "ណែនាំរូបបញ្ឈរ 2:3 ប្រភេទ JPG, PNG ឬ WEBP។",
    "bookCoverPreview": "មើលគម្របសៀវភៅជាមុន",
    "vertical23": "បញ្ឈរ 2:3",
    "clearBookCover": "សម្អាតគម្របសៀវភៅ",
    "galleryHelp": "អាចដាក់រូបវិចិត្រសាលបញ្ឈរបានអតិបរមា 5 រូប ដើម្បីឱ្យអ្នកអានឃើញព័ត៌មានបន្ថែមមុនទិញ។",
    "bookInformation": "ព័ត៌មានសៀវភៅ",
    "bookInformationHelp": "បន្ថែមព័ត៌មានសៀវភៅសម្រាប់ហាងអ្នកនិពន្ធ។",
    "productType": "ប្រភេទផលិតផល",
    "bookTitle": "ចំណងជើងសៀវភៅ",
    "authorName": "ឈ្មោះអ្នកនិពន្ធ",
    "publisher": "អ្នកបោះពុម្ព",
    "novelType": "ប្រភេទប្រលោមលោក",
    "category": "ប្រភេទ",
    "selectCategory": "ជ្រើសប្រភេទ",
    "genre": "ចំណាត់ថ្នាក់",
    "condition": "ស្ថានភាព",
    "paperType": "ប្រភេទក្រដាស",
    "coverType": "ប្រភេទគម្រប",
    "pageCount": "ចំនួនទំព័រ",
    "conditionNote": "កំណត់សម្គាល់ស្ថានភាព",
    "conditionNoteHelp": "បញ្ចូលគុណភាពសៀវភៅប៉ាន់ស្មានពី 1% ដល់ 100%។",
    "salePrice": "តម្លៃលក់",
    "originalPrice": "តម្លៃដើម",
    "stockQuantity": "ចំនួនស្តុក",
    "sortOrder": "លំដាប់",
    "preOrderProduct": "ផលិតផលកក់មុន",
    "bestSellerProduct": "ផលិតផលលក់ដាច់",
    "discountProduct": "ផលិតផលបញ្ចុះតម្លៃ",
    "pdfFile": "ឯកសារ PDF",
    "pdfSelected": "បានជ្រើស PDF",
    "pdfAttached": "បានភ្ជាប់ PDF",
    "accessRule": "ច្បាប់ចូលប្រើ",
    "conditionLabel": "ស្លាកស្ថានភាព",
    "description": "ការពិពណ៌នា",
    "createProduct": "បង្កើតផលិតផល",
    "saveProduct": "រក្សាទុកផលិតផល",
    "editProduct": "កែផលិតផល",
    "store": "ហាង",
    "newBooks": "សៀវភៅថ្មី",
    "secondHand": "មួយទឹក",
    "bestSeller": "លក់ដាច់",
    "pdfBooks": "សៀវភៅ PDF",
    "authorPicks": "អ្នកនិពន្ធជ្រើស",
    "newRelease": "ចេញថ្មី",
    "normalPaper": "ក្រដាសធម្មតា",
    "premiumPaper": "ក្រដាសពិសេស",
    "matteCover": "គម្របម៉ាត់",
    "glossyCover": "គម្របរលោង",
    "new": "ថ្មី",
    "readOnlineOnly": "អានអនឡាញតែប៉ុណ្ណោះ",
    "downloadAfterPayment": "ទាញយកបន្ទាប់ពីទូទាត់",
    "downloadAndReadOnline": "ទាញយក និងអានអនឡាញ",
    "selectImageFile": "សូមជ្រើសឯកសាររូបភាព។",
    "imageTooLarge": "រូបភាពត្រូវមានទំហំ 5MB ឬតិចជាងនេះ។",
    "selectPdfFile": "សូមជ្រើសឯកសារ PDF។",
    "pdfTooLarge": "ឯកសារ PDF ធំពេក។",
    "titleRequired": "ត្រូវការចំណងជើងផលិតផល។",
    "authorRequired": "ត្រូវការឈ្មោះអ្នកនិពន្ធ។",
    "categoryRequired": "ត្រូវការប្រភេទ។",
    "salePriceRequired": "ត្រូវការតម្លៃលក់។",
    "coverRequired": "ត្រូវការគម្របសៀវភៅ។",
    "pdfFileRequired": "ត្រូវការឯកសារ PDF។",
    "deleteProductConfirm": "លុប “{{title}}”?",
    "deleteProductFailed": "មិនអាចលុបផលិតផលបានទេ",
    "productSaved": "បានរក្សាទុកផលិតផល។",
    "productSaveFailed": "មិនអាចរក្សាទុកផលិតផលបានទេ",
    "productCreated": "បានបង្កើតផលិតផល។",
    "productCreateFailed": "មិនអាចបង្កើតផលិតផលបានទេ",
    "activeLabel": "សកម្ម",
    "closeMessage": "បិទសារ",
    "paperBook": "សៀវភៅបោះពុម្ព",
    "productDetails": "ព័ត៌មានផលិតផល",
    "galleryImages": "រូបវិចិត្រសាល",
    "replacePdf": "ប្តូរ PDF",
    "choosePdf": "ជ្រើស PDF",
    "selectFile": "ជ្រើសឯកសារ",
    "pdfHelp": "បង្ហោះ PDF ឯកជនសម្រាប់អ្នកអានដែលទិញផលិតផលនេះ។",
    "qualityPercent": "គុណភាព %",
    "deliveryNote": "កំណត់សម្គាល់ដឹកជញ្ជូន",
    "deliveryNotePlaceholder": "ព័ត៌មានដឹកជញ្ជូនជាជម្រើស",
    "coverImage": "រូបគម្រប",
    "galleryImage": "រូបវិចិត្រសាល",
    "noImage": "គ្មានរូបភាព",
    "orderSearchPlaceholder": "ស្វែងរកការបញ្ជាទិញ...",
    "recordsSearchPlaceholder": "ស្វែងរកផលិតផល...",
    "productId": "ID: {{id}}",
    "stockDetail": "ស្តុក {{count}} • {{condition}}",
    "stockQualityDetail": "ស្តុក {{count}} • {{condition}} • {{quality}}%",
    "pagePdfDetail": "{{count}} ទំព័រ • PDF",
    "bookInformationDivider": "ព័ត៌មានសៀវភៅ",
    "saleStock": "ការលក់ និងស្តុក",
    "coverSectionTitle": "គម្របសៀវភៅ",
    "coverSectionHelp": "បង្ហោះគម្របបញ្ឈរដែលបង្ហាញលើកាតផលិតផល។",
    "mainCover": "គម្របមេ",
    "coverPreview": "មើលគម្របជាមុន",
    "chooseReplaceCover": "ចុច ឬទម្លាក់រូប ដើម្បីប្តូរគម្រប",
    "chooseCover": "ចុច ឬទម្លាក់គម្របសៀវភៅនៅទីនេះ",
    "gallerySectionTitle": "វិចិត្រសាលសៀវភៅ",
    "gallerySectionHelp": "បង្ហោះរូបបញ្ឈរបន្ថែមដែលបង្ហាញនៅទំព័រលម្អិតផលិតផល។",
    "extraBookImages": "រូបសៀវភៅបន្ថែម",
    "enterBookTitle": "បញ្ចូលចំណងជើងសៀវភៅ",
    "authorNamePlaceholder": "ឈ្មោះអ្នកនិពន្ធ",
    "publisherPlaceholder": "អ្នកបោះពុម្ព",
    "novelTypePlaceholder": "ឧទាហរណ៍៖ ខ្មែរ អង់គ្លេស ចិន...",
    "genrePlaceholder": "Romance, fantasy, mystery...",
    "paperTypePlaceholder": "ឧទាហរណ៍៖ ក្រដាសធម្មតា ក្រដាសរលោង...",
    "coverTypePlaceholder": "ឧទាហរណ៍៖ Paperback, hardcover...",
    "pageCountPlaceholder": "ឧទាហរណ៍៖ 436",
    "qualityPlaceholder": "ឧទាហរណ៍៖ 85",
    "salePricePlaceholder": "ឧទាហរណ៍៖ 8.75",
    "originalPricePlaceholder": "ទុកទទេ បើគ្មានបញ្ចុះតម្លៃ",
    "stockPlaceholder": "ឧទាហរណ៍៖ 10",
    "validCoverImage": "សូមបង្ហោះរូបគម្របដែលត្រឹមត្រូវ។",
    "validGalleryImage": "សូមបង្ហោះរូបវិចិត្រសាលដែលត្រឹមត្រូវ។",
    "validPdf": "សូមបង្ហោះឯកសារ PDF ដែលត្រឹមត្រូវ។",
    "pdfSizeLimit": "ឯកសារ PDF ត្រូវមានទំហំ 50 MB ឬតិចជាងនេះ។",
    "replaceAttachedPdf": "ប្តូរ PDF ដែលបានភ្ជាប់",
    "pageCountPdfPlaceholder": "ឧទាហរណ៍៖ 120",
    "conditionPlaceholder": "ថ្មី ដូចថ្មី ល្អ មធ្យម...",
    "descriptionPlaceholder": "ព័ត៌មានសៀវភៅ ស្ថានភាព ការដឹកជញ្ជូន ឬកំណត់សម្គាល់កក់មុន...",
    "bookTitleRequired": "ត្រូវការចំណងជើងសៀវភៅ។",
    "sellPriceRequired": "ត្រូវការតម្លៃលក់។",
    "stockNonNegative": "ចំនួនស្តុកមិនអាចអវិជ្ជមានបានទេ។",
    "qualityRange": "គុណភាពសៀវភៅត្រូវនៅចន្លោះ 1% ដល់ 100%។",
    "pdfUploadTryAgain": "ការបង្ហោះ PDF បរាជ័យ។ សូមសាកម្តងទៀត។",
    "pdfUploadedReady": "បង្ហោះ PDF ជោគជ័យ។ អាចបង្កើតផលិតផលបានហើយ។",
    "pdfUploadingWait": "សូមរង់ចាំរហូតដល់ PDF បង្ហោះចប់។",
    "pdfRetryUpload": "សាកបង្ហោះ PDF ម្តងទៀត",
    "pdfInvalidContents": "ឯកសារដែលបានជ្រើសមិនមែនជា PDF ត្រឹមត្រូវទេ។",
    "pdfEmptyFile": "ឯកសារ PDF ទទេ។",
    "pdfAttachNotConfirmed": "មិនអាចផ្ទៀងផ្ទាត់ PDF ក្នុងផលិតផលបានទេ។ សូមសាកម្តងទៀត។",
    "saveTryAgain": "ការរក្សាទុកបរាជ័យ។ សូមសាកម្តងទៀត។",
    "loadProductsUiFailed": "មិនអាចផ្ទុកផលិតផលបានទេ",
    "loadCategoriesUiFailed": "មិនអាចផ្ទុកប្រភេទបានទេ",
    "createCategoryUiFailed": "មិនអាចបង្កើតប្រភេទបានទេ",
    "updateCategoryUiFailed": "មិនអាចកែប្រភេទបានទេ",
    "deleteCategoryUiFailed": "មិនអាចលុបប្រភេទបានទេ",
    "saveCategoryOrderUiFailed": "មិនអាចរក្សាទុកលំដាប់ប្រភេទបានទេ",
    "productNotSaved": "ផលិតផលមិនបានរក្សាទុក",
    "savedSuccessfully": "បានរក្សាទុកដោយជោគជ័យ",
    "deleteThisProduct": "ផលិតផលនេះ",
    "searchOrderPlaceholder": "ស្វែងរក Order ID ឈ្មោះអ្នកទិញ លេខទូរស័ព្ទ...",
    "storeTitle": "ហាង",
    "mainCoverAlt": "គម្របសៀវភៅ",
    "galleryImageAlt": "រូប {{number}}",
    "searching": "កំពុងស្វែងរក..."
  },
  "zh": {
    "pleaseLogin": "请先登录",
    "uploadCoverFailed": "无法上传封面图片",
    "uploadGalleryFailed": "无法上传图库图片",
    "pdfRequired": "需要 PDF 文件",
    "uploadPdfFailed": "无法上传私有 PDF",
    "productIdRequired": "需要商品 ID",
    "pdfStorageMissing": "缺少私有 PDF 存储密钥",
    "attachPdfFailed": "无法附加私有 PDF",
    "loadProductsFailed": "无法加载商品",
    "loadPromotionFailed": "无法加载优惠活动",
    "loadOrdersFailed": "无法加载订单",
    "markPreparingFailed": "无法标记为准备中",
    "loadDeliveryFailed": "无法加载配送设置",
    "loadTelegramFailed": "无法加载 Telegram 设置",
    "connectTelegramFailed": "无法创建 Telegram 连接链接",
    "unlinkTelegramFailed": "无法断开 Telegram 群组",
    "loadSalesReportsFailed": "无法加载 Sales Reports 设置",
    "connectSheetFailed": "无法连接 Google Sheet",
    "syncSalesReportsFailed": "无法同步 Sales Reports",
    "disconnectSheetFailed": "无法断开 Google Sheet",
    "updateDeliveryFailed": "无法更新配送设置",
    "loadCategoriesFailed": "无法加载分类",
    "createCategoryFailed": "无法创建分类",
    "updateCategoryFailed": "无法更新分类",
    "deleteCategoryFailed": "无法删除分类",
    "saveCategoryOrderFailed": "无法保存分类顺序",
    "author": "作者",
    "untitledProduct": "未命名商品",
    "productOptions": "商品选项",
    "closeProductMenu": "关闭商品菜单",
    "edit": "编辑",
    "delete": "删除",
    "stockCount": "库存 {{count}}",
    "pageCountPdf": "{{count}} 页 • PDF",
    "orderItem": "订单商品",
    "reader": "读者",
    "orderNumber": "订单 #{{number}}",
    "income": "收入 {{amount}}",
    "item": "件商品",
    "items": "件商品",
    "preparing": "准备中 ✓",
    "saving": "保存中...",
    "markPreparing": "标记为准备中",
    "pdfOrder": "PDF 订单",
    "closeMenu": "关闭菜单",
    "authorMenu": "作者菜单",
    "switchProfile": "切换资料",
    "finance": "财务",
    "settings": "设置",
    "orders": "订单",
    "netIncome": "净收入",
    "serviceFeePromotion": "0% 服务费优惠",
    "book": "图书",
    "pdf": "PDF",
    "records": "记录",
    "bookRecords": "图书记录",
    "searchManageProducts": "搜索、筛选并管理作者商店商品。",
    "productsCount": "{{count}} 个商品",
    "searchProducts": "搜索标题、分类、商品 ID...",
    "filterProductRecords": "筛选商品记录",
    "closeRecordFilter": "关闭记录筛选",
    "newestFirst": "最新优先",
    "recentlyUpdated": "最近更新",
    "lowStock": "库存不足",
    "soldOut": "售罄",
    "oldestFirst": "最旧优先",
    "all": "全部",
    "active": "上架",
    "draft": "草稿",
    "hidden": "已隐藏",
    "loadingProducts": "正在加载商品...",
    "noMatchingProducts": "没有匹配的商品",
    "tryAnotherSearch": "尝试其他搜索或筛选。",
    "createFirstProduct": "创建你的第一个商品",
    "createFirstProductHelp": "添加图书或 PDF，并从作者主页开始销售。",
    "addProduct": "添加商品",
    "preOrder": "预购",
    "storeSettings": "商店设置",
    "storeSettingsHelp": "管理商店分区和结账设置。",
    "categoryManagement": "分类管理",
    "categoryManagementHelp": "分类、隐藏分区和顺序。",
    "deliveryCompany": "配送公司",
    "deliveryCompanyHelp": "J&T 费用、VET 费用和结账配送。",
    "telegramBot": "Telegram Bot",
    "telegramBotHelp": "将订单审核通知连接到你的 Telegram 群组。",
    "createCustomCategory": "创建自定义分类",
    "customCategoryHelp": "最多可创建 5 个自定义分类。",
    "categoryName": "分类名称",
    "categoryLimitReached": "已达到自定义分类上限",
    "add": "添加",
    "categoryLimitHelp": "已达到自定义分类上限。请先删除一个再创建。",
    "categories": "分类",
    "saveOrder": "保存顺序",
    "system": "系统",
    "show": "显示",
    "hide": "隐藏",
    "save": "保存",
    "cancel": "取消",
    "setDeliveryFees": "设置读者结账时的配送费。",
    "deliveryFees": "配送费",
    "deliveryFeesHelp": "这些费用会加入结账总额。",
    "jntHelp": "J&T Express 纸质书配送。",
    "vetHelp": "Virak Buntham Express 配送选项。",
    "deliveryFee": "配送费",
    "deliveryFeesSaved": "配送费已保存。",
    "saveDeliveryFailed": "无法保存配送费。",
    "saveDeliveryFees": "保存配送费",
    "receiveTelegram": "接收 Telegram 通知",
    "receiveTelegramHelp": "将此作者主页连接到一个 Telegram 群组以接收订单审核提醒。断开当前群组后才能更换。",
    "telegramLinkMissing": "已创建 Telegram 连接链接，但未返回链接。",
    "openTelegramFailed": "无法打开 Telegram 连接链接。",
    "telegramUnlinked": "Telegram 群组已断开，现在可以连接新群组。",
    "unlinkTelegramFailedUi": "无法断开 Telegram 群组。",
    "linkedGroup": "已连接群组",
    "groupId": "Group ID: {{id}}",
    "linkedAt": "连接时间：{{date}}",
    "oneTelegramGroup": "此作者主页只能使用一个 Telegram 群组。要连接其他群组，请先断开当前群组。",
    "unlinking": "正在断开...",
    "unlinkGroup": "断开群组",
    "howToConnect": "连接方法",
    "telegramStep1": "点击“连接 Telegram 群组”。",
    "telegramStep2": "Telegram 将打开并让你选择一个群组。",
    "telegramStep3": "将 @{{bot}} 添加到该群组。",
    "telegramStep4": "群组连接后，机器人会确认。",
    "openingTelegram": "正在打开 Telegram...",
    "loading": "加载中...",
    "connectTelegramGroup": "连接 Telegram 群组",
    "orderHistory": "订单历史",
    "orderHistoryHelp": "这里显示管理员已确认的作者商店订单。",
    "searchOrders": "搜索订单、买家、商品...",
    "filterOrders": "筛选订单",
    "closeOrderFilter": "关闭订单筛选",
    "allOrders": "全部",
    "toPrepare": "待准备",
    "preparingFilter": "准备中",
    "loadingOrders": "正在加载订单...",
    "previous": "上一页",
    "next": "下一页",
    "pageOf": "第 {{page}} 页 / 共 {{total}} 页",
    "noOrders": "暂无订单",
    "noOrdersHelp": "作者商店中新确认的订单会显示在这里。",
    "imageNumber": "图片 {{number}}",
    "choose": "选择",
    "clear": "清除",
    "coverRecommendation": "建议使用 2:3 竖图，JPG、PNG 或 WEBP。",
    "bookCoverPreview": "图书封面预览",
    "vertical23": "2:3 竖版",
    "clearBookCover": "清除图书封面",
    "galleryHelp": "最多 5 张竖版图库图片，帮助读者购买前查看更多细节。",
    "bookInformation": "图书信息",
    "bookInformationHelp": "为作者商店添加图书详情。",
    "productType": "商品类型",
    "bookTitle": "书名",
    "authorName": "作者名",
    "publisher": "出版社",
    "novelType": "小说类型",
    "category": "分类",
    "selectCategory": "选择分类",
    "genre": "类型",
    "condition": "成色",
    "paperType": "纸张类型",
    "coverType": "封面类型",
    "pageCount": "页数",
    "conditionNote": "成色说明",
    "conditionNoteHelp": "输入 1% 到 100% 的估计图书质量。",
    "salePrice": "售价",
    "originalPrice": "原价",
    "stockQuantity": "库存数量",
    "sortOrder": "排序",
    "preOrderProduct": "预购商品",
    "bestSellerProduct": "畅销商品",
    "discountProduct": "折扣商品",
    "pdfFile": "PDF 文件",
    "pdfSelected": "已选择 PDF",
    "pdfAttached": "已附加 PDF",
    "accessRule": "访问规则",
    "conditionLabel": "成色标签",
    "description": "描述",
    "createProduct": "创建商品",
    "saveProduct": "保存商品",
    "editProduct": "编辑商品",
    "store": "商店",
    "newBooks": "新书",
    "secondHand": "二手",
    "bestSeller": "畅销",
    "pdfBooks": "PDF 图书",
    "authorPicks": "作者精选",
    "newRelease": "新品",
    "normalPaper": "普通纸",
    "premiumPaper": "高级纸",
    "matteCover": "哑光封面",
    "glossyCover": "亮光封面",
    "new": "全新",
    "readOnlineOnly": "仅在线阅读",
    "downloadAfterPayment": "付款后下载",
    "downloadAndReadOnline": "下载并在线阅读",
    "selectImageFile": "请选择图片文件。",
    "imageTooLarge": "图片大小必须不超过 5MB。",
    "selectPdfFile": "请选择 PDF 文件。",
    "pdfTooLarge": "PDF 文件过大。",
    "titleRequired": "商品标题为必填项。",
    "authorRequired": "作者名为必填项。",
    "categoryRequired": "分类为必填项。",
    "salePriceRequired": "售价为必填项。",
    "coverRequired": "图书封面为必填项。",
    "pdfFileRequired": "PDF 文件为必填项。",
    "deleteProductConfirm": "删除“{{title}}”？",
    "deleteProductFailed": "无法删除商品",
    "productSaved": "商品已保存。",
    "productSaveFailed": "无法保存商品",
    "productCreated": "商品已创建。",
    "productCreateFailed": "无法创建商品",
    "activeLabel": "启用",
    "closeMessage": "关闭消息",
    "paperBook": "纸质书",
    "productDetails": "商品详情",
    "galleryImages": "图库图片",
    "replacePdf": "替换 PDF",
    "choosePdf": "选择 PDF",
    "selectFile": "选择文件",
    "pdfHelp": "上传私有 PDF，供购买此商品的读者使用。",
    "qualityPercent": "质量 %",
    "deliveryNote": "配送说明",
    "deliveryNotePlaceholder": "可选配送信息",
    "coverImage": "封面图片",
    "galleryImage": "图库图片",
    "noImage": "无图片",
    "orderSearchPlaceholder": "搜索订单...",
    "recordsSearchPlaceholder": "搜索商品...",
    "productId": "ID：{{id}}",
    "stockDetail": "库存 {{count}} • {{condition}}",
    "stockQualityDetail": "库存 {{count}} • {{condition}} • {{quality}}%",
    "pagePdfDetail": "{{count}} 页 • PDF",
    "bookInformationDivider": "图书信息",
    "saleStock": "销售与库存",
    "coverSectionTitle": "图书封面",
    "coverSectionHelp": "上传商品卡片上显示的竖版封面。",
    "mainCover": "主封面",
    "coverPreview": "封面预览",
    "chooseReplaceCover": "选择或替换图书封面",
    "chooseCover": "选择图书封面",
    "gallerySectionTitle": "图书图库",
    "gallerySectionHelp": "上传商品详情页显示的额外竖版图片。",
    "extraBookImages": "额外图书图片",
    "enterBookTitle": "输入书名",
    "authorNamePlaceholder": "作者名",
    "publisherPlaceholder": "出版社",
    "novelTypePlaceholder": "例如：高棉语、英语、中文...",
    "genrePlaceholder": "恋爱、奇幻、悬疑...",
    "paperTypePlaceholder": "例如：普通纸、光面纸、米色纸...",
    "coverTypePlaceholder": "例如：平装、精装...",
    "pageCountPlaceholder": "例如：436",
    "qualityPlaceholder": "例如：85",
    "salePricePlaceholder": "例如：8.75",
    "originalPricePlaceholder": "无折扣请留空",
    "stockPlaceholder": "例如：10",
    "validCoverImage": "请上传有效的封面图片。",
    "validGalleryImage": "请上传有效的图库图片。",
    "validPdf": "请上传有效的 PDF 文件。",
    "pdfSizeLimit": "PDF 文件必须小于或等于 50 MB。",
    "replaceAttachedPdf": "替换已附加 PDF",
    "pageCountPdfPlaceholder": "例如：120",
    "conditionPlaceholder": "全新、近新、良好、一般...",
    "descriptionPlaceholder": "图书详情、成色、配送说明或预购说明...",
    "bookTitleRequired": "书名为必填项。",
    "sellPriceRequired": "售价为必填项。",
    "stockNonNegative": "库存数量不能为负数。",
    "qualityRange": "图书质量必须在 1% 到 100% 之间。",
    "pdfUploadTryAgain": "PDF 上传失败，请重试。",
    "pdfUploadedReady": "PDF 上传成功，可以创建商品。",
    "pdfUploadingWait": "请等待 PDF 上传完成。",
    "pdfRetryUpload": "重试 PDF 上传",
    "pdfInvalidContents": "所选文件不是有效的 PDF。",
    "pdfEmptyFile": "PDF 文件为空。",
    "pdfAttachNotConfirmed": "无法确认 PDF 已关联商品，请重试。",
    "saveTryAgain": "保存失败，请重试。",
    "loadProductsUiFailed": "无法加载商品",
    "loadCategoriesUiFailed": "无法加载分类",
    "createCategoryUiFailed": "无法创建分类",
    "updateCategoryUiFailed": "无法更新分类",
    "deleteCategoryUiFailed": "无法删除分类",
    "saveCategoryOrderUiFailed": "无法保存分类顺序",
    "productNotSaved": "商品未保存",
    "savedSuccessfully": "保存成功",
    "deleteThisProduct": "此商品",
    "searchOrderPlaceholder": "搜索订单 ID、买家姓名、电话...",
    "storeTitle": "商店",
    "mainCoverAlt": "图书封面",
    "galleryImageAlt": "图片 {{number}}",
    "searching": "搜索中..."
  },
  "ja": {
    "pleaseLogin": "先にログインしてください",
    "uploadCoverFailed": "表紙画像をアップロードできませんでした",
    "uploadGalleryFailed": "ギャラリー画像をアップロードできませんでした",
    "pdfRequired": "PDFファイルが必要です",
    "uploadPdfFailed": "非公開PDFをアップロードできませんでした",
    "productIdRequired": "商品IDが必要です",
    "pdfStorageMissing": "非公開PDFの保存キーがありません",
    "attachPdfFailed": "非公開PDFを添付できませんでした",
    "loadProductsFailed": "商品を読み込めませんでした",
    "loadPromotionFailed": "プロモーションを読み込めませんでした",
    "loadOrdersFailed": "注文を読み込めませんでした",
    "markPreparingFailed": "準備中に変更できませんでした",
    "loadDeliveryFailed": "配送設定を読み込めませんでした",
    "loadTelegramFailed": "Telegram設定を読み込めませんでした",
    "connectTelegramFailed": "Telegram接続リンクを作成できませんでした",
    "unlinkTelegramFailed": "Telegramグループを解除できませんでした",
    "loadSalesReportsFailed": "Sales Reports設定を読み込めませんでした",
    "connectSheetFailed": "Google Sheetに接続できませんでした",
    "syncSalesReportsFailed": "Sales Reportsを同期できませんでした",
    "disconnectSheetFailed": "Google Sheetを切断できませんでした",
    "updateDeliveryFailed": "配送設定を更新できませんでした",
    "loadCategoriesFailed": "カテゴリを読み込めませんでした",
    "createCategoryFailed": "カテゴリを作成できませんでした",
    "updateCategoryFailed": "カテゴリを更新できませんでした",
    "deleteCategoryFailed": "カテゴリを削除できませんでした",
    "saveCategoryOrderFailed": "カテゴリ順序を保存できませんでした",
    "author": "作者",
    "untitledProduct": "無題の商品",
    "productOptions": "商品オプション",
    "closeProductMenu": "商品メニューを閉じる",
    "edit": "編集",
    "delete": "削除",
    "stockCount": "在庫 {{count}}",
    "pageCountPdf": "{{count}}ページ • PDF",
    "orderItem": "注文商品",
    "reader": "読者",
    "orderNumber": "注文 #{{number}}",
    "income": "収益 {{amount}}",
    "item": "商品",
    "items": "商品",
    "preparing": "準備中 ✓",
    "saving": "保存中...",
    "markPreparing": "準備中にする",
    "pdfOrder": "PDF注文",
    "closeMenu": "メニューを閉じる",
    "authorMenu": "作者メニュー",
    "switchProfile": "プロフィール切替",
    "finance": "収益",
    "settings": "設定",
    "orders": "注文",
    "netIncome": "純収益",
    "serviceFeePromotion": "サービス手数料 0% キャンペーン",
    "book": "書籍",
    "pdf": "PDF",
    "records": "記録",
    "bookRecords": "書籍記録",
    "searchManageProducts": "作者ストアの商品を検索・絞り込み・管理します。",
    "productsCount": "{{count}}商品",
    "searchProducts": "タイトル、カテゴリ、商品IDを検索...",
    "filterProductRecords": "商品記録を絞り込む",
    "closeRecordFilter": "記録フィルターを閉じる",
    "newestFirst": "新しい順",
    "recentlyUpdated": "最近更新",
    "lowStock": "在庫少",
    "soldOut": "売り切れ",
    "oldestFirst": "古い順",
    "all": "すべて",
    "active": "公開中",
    "draft": "下書き",
    "hidden": "非表示",
    "loadingProducts": "商品を読み込み中...",
    "noMatchingProducts": "一致する商品がありません",
    "tryAnotherSearch": "別の検索またはフィルターを試してください。",
    "createFirstProduct": "最初の商品を作成",
    "createFirstProductHelp": "書籍またはPDFを追加し、作者ページから販売を開始します。",
    "addProduct": "商品を追加",
    "preOrder": "予約注文",
    "storeSettings": "ストア設定",
    "storeSettingsHelp": "ストアのセクションと購入設定を管理します。",
    "categoryManagement": "カテゴリ管理",
    "categoryManagementHelp": "カテゴリ、非表示セクション、順序を管理します。",
    "deliveryCompany": "配送会社",
    "deliveryCompanyHelp": "J&T料金、VET料金、購入時の配送設定。",
    "telegramBot": "Telegram Bot",
    "telegramBotHelp": "注文承認通知をTelegramグループに接続します。",
    "createCustomCategory": "カスタムカテゴリを作成",
    "customCategoryHelp": "カスタムカテゴリは最大5個作成できます。",
    "categoryName": "カテゴリ名",
    "categoryLimitReached": "カスタムカテゴリの上限です",
    "add": "追加",
    "categoryLimitHelp": "カスタムカテゴリの上限です。新規作成前に1つ削除してください。",
    "categories": "カテゴリ",
    "saveOrder": "順序を保存",
    "system": "システム",
    "show": "表示",
    "hide": "非表示",
    "save": "保存",
    "cancel": "キャンセル",
    "setDeliveryFees": "読者の購入時に使用する配送料を設定します。",
    "deliveryFees": "配送料",
    "deliveryFeesHelp": "これらの料金は購入合計に追加されます。",
    "jntHelp": "J&T Expressによる印刷書籍の配送。",
    "vetHelp": "Virak Buntham Express配送オプション。",
    "deliveryFee": "配送料",
    "deliveryFeesSaved": "配送料を保存しました。",
    "saveDeliveryFailed": "配送料を保存できませんでした。",
    "saveDeliveryFees": "配送料を保存",
    "receiveTelegram": "Telegram通知を受け取る",
    "receiveTelegramHelp": "注文承認通知用にこの作者ページを1つのTelegramグループへ接続します。現在のグループを解除後に変更できます。",
    "telegramLinkMissing": "Telegram接続リンクを作成しましたが、リンクがありません。",
    "openTelegramFailed": "Telegram接続リンクを開けませんでした。",
    "telegramUnlinked": "Telegramグループを解除しました。新しいグループを接続できます。",
    "unlinkTelegramFailedUi": "Telegramグループを解除できませんでした。",
    "linkedGroup": "接続済みグループ",
    "groupId": "Group ID: {{id}}",
    "linkedAt": "接続：{{date}}",
    "oneTelegramGroup": "この作者ページではTelegramグループを1つだけ使用できます。別のグループを接続するには現在のグループを解除してください。",
    "unlinking": "解除中...",
    "unlinkGroup": "グループ接続を解除",
    "howToConnect": "接続方法",
    "telegramStep1": "「Telegramグループを接続」をタップします。",
    "telegramStep2": "Telegramが開き、グループを選択します。",
    "telegramStep3": "@{{bot}} をそのグループに追加します。",
    "telegramStep4": "グループが接続されるとBotが確認します。",
    "openingTelegram": "Telegramを開いています...",
    "loading": "読み込み中...",
    "connectTelegramGroup": "Telegramグループを接続",
    "orderHistory": "注文履歴",
    "orderHistoryHelp": "管理者が確認した作者ストアの注文です。",
    "searchOrders": "注文、購入者、商品を検索...",
    "filterOrders": "注文を絞り込む",
    "closeOrderFilter": "注文フィルターを閉じる",
    "allOrders": "すべて",
    "toPrepare": "準備待ち",
    "preparingFilter": "準備中",
    "loadingOrders": "注文を読み込み中...",
    "previous": "前へ",
    "next": "次へ",
    "pageOf": "{{page}} / {{total}} ページ",
    "noOrders": "注文はまだありません",
    "noOrdersHelp": "作者ストアで確認された新しい注文がここに表示されます。",
    "imageNumber": "画像 {{number}}",
    "choose": "選択",
    "clear": "クリア",
    "coverRecommendation": "2:3の縦画像（JPG、PNG、WEBP）を推奨します。",
    "bookCoverPreview": "書籍表紙プレビュー",
    "vertical23": "2:3 縦",
    "clearBookCover": "書籍表紙をクリア",
    "galleryHelp": "縦画像は最大5枚。購入前に詳細を見せるために使用します。",
    "bookInformation": "書籍情報",
    "bookInformationHelp": "作者ストア用の書籍情報を追加します。",
    "productType": "商品タイプ",
    "bookTitle": "書名",
    "authorName": "著者名",
    "publisher": "出版社",
    "novelType": "小説タイプ",
    "category": "カテゴリ",
    "selectCategory": "カテゴリを選択",
    "genre": "ジャンル",
    "condition": "状態",
    "paperType": "紙の種類",
    "coverType": "表紙タイプ",
    "pageCount": "ページ数",
    "conditionNote": "状態メモ",
    "conditionNoteHelp": "推定品質を1%〜100%で入力してください。",
    "salePrice": "販売価格",
    "originalPrice": "元の価格",
    "stockQuantity": "在庫数",
    "sortOrder": "表示順",
    "preOrderProduct": "予約商品",
    "bestSellerProduct": "ベストセラー商品",
    "discountProduct": "割引商品",
    "pdfFile": "PDFファイル",
    "pdfSelected": "PDF選択済み",
    "pdfAttached": "PDF添付済み",
    "accessRule": "アクセスルール",
    "conditionLabel": "状態ラベル",
    "description": "説明",
    "createProduct": "商品を作成",
    "saveProduct": "商品を保存",
    "editProduct": "商品を編集",
    "store": "ストア",
    "newBooks": "新刊",
    "secondHand": "中古",
    "bestSeller": "ベストセラー",
    "pdfBooks": "PDF書籍",
    "authorPicks": "作者おすすめ",
    "newRelease": "新着",
    "normalPaper": "普通紙",
    "premiumPaper": "高級紙",
    "matteCover": "マットカバー",
    "glossyCover": "光沢カバー",
    "new": "新品",
    "readOnlineOnly": "オンライン閲覧のみ",
    "downloadAfterPayment": "支払い後にダウンロード",
    "downloadAndReadOnline": "ダウンロードしてオンラインで読む",
    "selectImageFile": "画像ファイルを選択してください。",
    "imageTooLarge": "画像は5MB以下にしてください。",
    "selectPdfFile": "PDFファイルを選択してください。",
    "pdfTooLarge": "PDFファイルが大きすぎます。",
    "titleRequired": "商品タイトルは必須です。",
    "authorRequired": "著者名は必須です。",
    "categoryRequired": "カテゴリは必須です。",
    "salePriceRequired": "販売価格は必須です。",
    "coverRequired": "書籍表紙は必須です。",
    "pdfFileRequired": "PDFファイルは必須です。",
    "deleteProductConfirm": "「{{title}}」を削除しますか？",
    "deleteProductFailed": "商品を削除できませんでした",
    "productSaved": "商品を保存しました。",
    "productSaveFailed": "商品を保存できませんでした",
    "productCreated": "商品を作成しました。",
    "productCreateFailed": "商品を作成できませんでした",
    "activeLabel": "有効",
    "closeMessage": "メッセージを閉じる",
    "paperBook": "印刷書籍",
    "productDetails": "商品詳細",
    "galleryImages": "ギャラリー画像",
    "replacePdf": "PDFを置換",
    "choosePdf": "PDFを選択",
    "selectFile": "ファイルを選択",
    "pdfHelp": "購入した読者向けの非公開PDFをアップロードします。",
    "qualityPercent": "品質 %",
    "deliveryNote": "配送メモ",
    "deliveryNotePlaceholder": "任意の配送情報",
    "coverImage": "表紙画像",
    "galleryImage": "ギャラリー画像",
    "noImage": "画像なし",
    "orderSearchPlaceholder": "注文を検索...",
    "recordsSearchPlaceholder": "商品を検索...",
    "productId": "ID：{{id}}",
    "stockDetail": "在庫 {{count}} • {{condition}}",
    "stockQualityDetail": "在庫 {{count}} • {{condition}} • {{quality}}%",
    "pagePdfDetail": "{{count}}ページ • PDF",
    "bookInformationDivider": "書籍情報",
    "saleStock": "販売と在庫",
    "coverSectionTitle": "書籍表紙",
    "coverSectionHelp": "商品カードに表示する縦表紙をアップロードします。",
    "mainCover": "メイン表紙",
    "coverPreview": "表紙プレビュー",
    "chooseReplaceCover": "書籍表紙を選択または置換",
    "chooseCover": "書籍表紙を選択",
    "gallerySectionTitle": "書籍ギャラリー",
    "gallerySectionHelp": "商品詳細ページに表示する追加の縦画像をアップロードします。",
    "extraBookImages": "追加書籍画像",
    "enterBookTitle": "書名を入力",
    "authorNamePlaceholder": "著者名",
    "publisherPlaceholder": "出版社",
    "novelTypePlaceholder": "例：クメール語、英語、中国語...",
    "genrePlaceholder": "恋愛、ファンタジー、ミステリー...",
    "paperTypePlaceholder": "例：普通紙、光沢紙、クリーム紙...",
    "coverTypePlaceholder": "例：ペーパーバック、ハードカバー...",
    "pageCountPlaceholder": "例：436",
    "qualityPlaceholder": "例：85",
    "salePricePlaceholder": "例：8.75",
    "originalPricePlaceholder": "割引がない場合は空欄",
    "stockPlaceholder": "例：10",
    "validCoverImage": "有効な表紙画像をアップロードしてください。",
    "validGalleryImage": "有効なギャラリー画像をアップロードしてください。",
    "validPdf": "有効なPDFファイルをアップロードしてください。",
    "pdfSizeLimit": "PDFは50MB以下にしてください。",
    "replaceAttachedPdf": "添付PDFを置換",
    "pageCountPdfPlaceholder": "例：120",
    "conditionPlaceholder": "新品、ほぼ新品、良好、普通...",
    "descriptionPlaceholder": "書籍詳細、状態、配送メモ、予約メモ...",
    "bookTitleRequired": "書名は必須です。",
    "sellPriceRequired": "販売価格は必須です。",
    "stockNonNegative": "在庫数をマイナスにはできません。",
    "qualityRange": "書籍品質は1%〜100%で指定してください。",
    "pdfUploadTryAgain": "PDFのアップロードに失敗しました。もう一度お試しください。",
    "pdfUploadedReady": "PDFのアップロードが完了しました。商品を作成できます。",
    "pdfUploadingWait": "PDFのアップロード完了までお待ちください。",
    "pdfRetryUpload": "PDFを再アップロード",
    "pdfInvalidContents": "選択したファイルは有効なPDFではありません。",
    "pdfEmptyFile": "PDFファイルが空です。",
    "pdfAttachNotConfirmed": "商品へのPDF紐付けを確認できません。もう一度お試しください。",
    "saveTryAgain": "保存に失敗しました。もう一度お試しください。",
    "loadProductsUiFailed": "商品を読み込めませんでした",
    "loadCategoriesUiFailed": "カテゴリを読み込めませんでした",
    "createCategoryUiFailed": "カテゴリを作成できませんでした",
    "updateCategoryUiFailed": "カテゴリを更新できませんでした",
    "deleteCategoryUiFailed": "カテゴリを削除できませんでした",
    "saveCategoryOrderUiFailed": "カテゴリ順序を保存できませんでした",
    "productNotSaved": "商品は保存されませんでした",
    "savedSuccessfully": "保存しました",
    "deleteThisProduct": "この商品",
    "searchOrderPlaceholder": "注文ID、購入者名、電話番号を検索...",
    "storeTitle": "ストア",
    "mainCoverAlt": "書籍表紙",
    "galleryImageAlt": "画像 {{number}}",
    "searching": "検索中..."
  },
  "ko": {
    "pleaseLogin": "먼저 로그인해 주세요",
    "uploadCoverFailed": "표지 이미지를 업로드하지 못했습니다",
    "uploadGalleryFailed": "갤러리 이미지를 업로드하지 못했습니다",
    "pdfRequired": "PDF 파일이 필요합니다",
    "uploadPdfFailed": "비공개 PDF를 업로드하지 못했습니다",
    "productIdRequired": "상품 ID가 필요합니다",
    "pdfStorageMissing": "비공개 PDF 저장 키가 없습니다",
    "attachPdfFailed": "비공개 PDF를 첨부하지 못했습니다",
    "loadProductsFailed": "상품을 불러오지 못했습니다",
    "loadPromotionFailed": "프로모션을 불러오지 못했습니다",
    "loadOrdersFailed": "주문을 불러오지 못했습니다",
    "markPreparingFailed": "준비 중으로 표시하지 못했습니다",
    "loadDeliveryFailed": "배송 설정을 불러오지 못했습니다",
    "loadTelegramFailed": "Telegram 설정을 불러오지 못했습니다",
    "connectTelegramFailed": "Telegram 연결 링크를 만들지 못했습니다",
    "unlinkTelegramFailed": "Telegram 그룹 연결을 해제하지 못했습니다",
    "loadSalesReportsFailed": "Sales Reports 설정을 불러오지 못했습니다",
    "connectSheetFailed": "Google Sheet에 연결하지 못했습니다",
    "syncSalesReportsFailed": "Sales Reports를 동기화하지 못했습니다",
    "disconnectSheetFailed": "Google Sheet 연결을 해제하지 못했습니다",
    "updateDeliveryFailed": "배송 설정을 업데이트하지 못했습니다",
    "loadCategoriesFailed": "카테고리를 불러오지 못했습니다",
    "createCategoryFailed": "카테고리를 만들지 못했습니다",
    "updateCategoryFailed": "카테고리를 업데이트하지 못했습니다",
    "deleteCategoryFailed": "카테고리를 삭제하지 못했습니다",
    "saveCategoryOrderFailed": "카테고리 순서를 저장하지 못했습니다",
    "author": "작가",
    "untitledProduct": "제목 없는 상품",
    "productOptions": "상품 옵션",
    "closeProductMenu": "상품 메뉴 닫기",
    "edit": "수정",
    "delete": "삭제",
    "stockCount": "재고 {{count}}",
    "pageCountPdf": "{{count}}페이지 • PDF",
    "orderItem": "주문 상품",
    "reader": "독자",
    "orderNumber": "주문 #{{number}}",
    "income": "수익 {{amount}}",
    "item": "상품",
    "items": "상품",
    "preparing": "준비 중 ✓",
    "saving": "저장 중...",
    "markPreparing": "준비 중으로 표시",
    "pdfOrder": "PDF 주문",
    "closeMenu": "메뉴 닫기",
    "authorMenu": "작가 메뉴",
    "switchProfile": "프로필 전환",
    "finance": "재정",
    "settings": "설정",
    "orders": "주문",
    "netIncome": "순수익",
    "serviceFeePromotion": "서비스 수수료 0% 프로모션",
    "book": "도서",
    "pdf": "PDF",
    "records": "기록",
    "bookRecords": "도서 기록",
    "searchManageProducts": "작가 스토어 상품을 검색, 필터링, 관리합니다.",
    "productsCount": "상품 {{count}}개",
    "searchProducts": "제목, 카테고리, 상품 ID 검색...",
    "filterProductRecords": "상품 기록 필터",
    "closeRecordFilter": "기록 필터 닫기",
    "newestFirst": "최신순",
    "recentlyUpdated": "최근 업데이트",
    "lowStock": "재고 부족",
    "soldOut": "품절",
    "oldestFirst": "오래된순",
    "all": "전체",
    "active": "활성",
    "draft": "초안",
    "hidden": "숨김",
    "loadingProducts": "상품을 불러오는 중...",
    "noMatchingProducts": "일치하는 상품이 없습니다",
    "tryAnotherSearch": "다른 검색어 또는 필터를 사용해 보세요.",
    "createFirstProduct": "첫 상품 만들기",
    "createFirstProductHelp": "도서 또는 PDF를 추가하고 작가 페이지에서 판매를 시작하세요.",
    "addProduct": "상품 추가",
    "preOrder": "예약 주문",
    "storeSettings": "스토어 설정",
    "storeSettingsHelp": "스토어 섹션과 결제 설정을 관리합니다.",
    "categoryManagement": "카테고리 관리",
    "categoryManagementHelp": "카테고리, 숨김 섹션, 순서를 관리합니다.",
    "deliveryCompany": "배송사",
    "deliveryCompanyHelp": "J&T 요금, VET 요금 및 결제 배송 설정.",
    "telegramBot": "Telegram Bot",
    "telegramBotHelp": "주문 승인 알림을 Telegram 그룹에 연결합니다.",
    "createCustomCategory": "사용자 카테고리 만들기",
    "customCategoryHelp": "사용자 카테고리는 최대 5개 만들 수 있습니다.",
    "categoryName": "카테고리 이름",
    "categoryLimitReached": "사용자 카테고리 한도 도달",
    "add": "추가",
    "categoryLimitHelp": "사용자 카테고리 한도에 도달했습니다. 새로 만들기 전에 하나를 삭제하세요.",
    "categories": "카테고리",
    "saveOrder": "순서 저장",
    "system": "시스템",
    "show": "표시",
    "hide": "숨기기",
    "save": "저장",
    "cancel": "취소",
    "setDeliveryFees": "독자 결제용 배송비를 설정합니다.",
    "deliveryFees": "배송비",
    "deliveryFeesHelp": "이 요금은 결제 합계에 추가됩니다.",
    "jntHelp": "J&T Express 인쇄 도서 배송.",
    "vetHelp": "Virak Buntham Express 배송 옵션.",
    "deliveryFee": "배송비",
    "deliveryFeesSaved": "배송비를 저장했습니다.",
    "saveDeliveryFailed": "배송비를 저장하지 못했습니다.",
    "saveDeliveryFees": "배송비 저장",
    "receiveTelegram": "Telegram 알림 받기",
    "receiveTelegramHelp": "주문 승인 알림을 위해 이 작가 페이지를 하나의 Telegram 그룹에 연결합니다. 현재 그룹 연결을 해제한 후 변경할 수 있습니다.",
    "telegramLinkMissing": "Telegram 연결 링크를 만들었지만 링크가 없습니다.",
    "openTelegramFailed": "Telegram 연결 링크를 열지 못했습니다.",
    "telegramUnlinked": "Telegram 그룹 연결이 해제되었습니다. 이제 새 그룹을 연결할 수 있습니다.",
    "unlinkTelegramFailedUi": "Telegram 그룹 연결을 해제하지 못했습니다.",
    "linkedGroup": "연결된 그룹",
    "groupId": "Group ID: {{id}}",
    "linkedAt": "연결: {{date}}",
    "oneTelegramGroup": "이 작가 페이지는 Telegram 그룹 하나만 사용할 수 있습니다. 다른 그룹을 연결하려면 현재 그룹을 먼저 연결 해제하세요.",
    "unlinking": "연결 해제 중...",
    "unlinkGroup": "그룹 연결 해제",
    "howToConnect": "연결 방법",
    "telegramStep1": "Telegram 그룹 연결을 누르세요.",
    "telegramStep2": "Telegram이 열리면 그룹을 선택하세요.",
    "telegramStep3": "@{{bot}} 을 해당 그룹에 추가하세요.",
    "telegramStep4": "그룹이 연결되면 봇이 확인합니다.",
    "openingTelegram": "Telegram 여는 중...",
    "loading": "불러오는 중...",
    "connectTelegramGroup": "Telegram 그룹 연결",
    "orderHistory": "주문 내역",
    "orderHistoryHelp": "관리자가 확인한 작가 스토어 주문입니다.",
    "searchOrders": "주문, 구매자, 상품 검색...",
    "filterOrders": "주문 필터",
    "closeOrderFilter": "주문 필터 닫기",
    "allOrders": "전체",
    "toPrepare": "준비 필요",
    "preparingFilter": "준비 중",
    "loadingOrders": "주문을 불러오는 중...",
    "previous": "이전",
    "next": "다음",
    "pageOf": "{{page}} / {{total}} 페이지",
    "noOrders": "아직 주문이 없습니다",
    "noOrdersHelp": "작가 스토어의 새 확인 주문이 여기에 표시됩니다.",
    "imageNumber": "이미지 {{number}}",
    "choose": "선택",
    "clear": "지우기",
    "coverRecommendation": "2:3 세로 비율의 JPG, PNG 또는 WEBP를 권장합니다.",
    "bookCoverPreview": "도서 표지 미리보기",
    "vertical23": "2:3 세로",
    "clearBookCover": "도서 표지 지우기",
    "galleryHelp": "세로 갤러리 이미지는 최대 5장입니다. 구매 전 더 많은 정보를 보여줍니다.",
    "bookInformation": "도서 정보",
    "bookInformationHelp": "작가 스토어용 도서 정보를 추가합니다.",
    "productType": "상품 유형",
    "bookTitle": "책 제목",
    "authorName": "저자명",
    "publisher": "출판사",
    "novelType": "소설 유형",
    "category": "카테고리",
    "selectCategory": "카테고리 선택",
    "genre": "장르",
    "condition": "상태",
    "paperType": "종이 유형",
    "coverType": "표지 유형",
    "pageCount": "페이지 수",
    "conditionNote": "상태 메모",
    "conditionNoteHelp": "예상 도서 품질을 1%~100%로 입력하세요.",
    "salePrice": "판매가",
    "originalPrice": "정가",
    "stockQuantity": "재고 수량",
    "sortOrder": "정렬 순서",
    "preOrderProduct": "예약 상품",
    "bestSellerProduct": "베스트셀러 상품",
    "discountProduct": "할인 상품",
    "pdfFile": "PDF 파일",
    "pdfSelected": "PDF 선택됨",
    "pdfAttached": "PDF 첨부됨",
    "accessRule": "접근 규칙",
    "conditionLabel": "상태 라벨",
    "description": "설명",
    "createProduct": "상품 만들기",
    "saveProduct": "상품 저장",
    "editProduct": "상품 수정",
    "store": "스토어",
    "newBooks": "신간",
    "secondHand": "중고",
    "bestSeller": "베스트셀러",
    "pdfBooks": "PDF 도서",
    "authorPicks": "작가 추천",
    "newRelease": "신규 출시",
    "normalPaper": "일반 용지",
    "premiumPaper": "고급 용지",
    "matteCover": "무광 표지",
    "glossyCover": "유광 표지",
    "new": "새 상품",
    "readOnlineOnly": "온라인 읽기 전용",
    "downloadAfterPayment": "결제 후 다운로드",
    "downloadAndReadOnline": "다운로드 및 온라인 읽기",
    "selectImageFile": "이미지 파일을 선택해 주세요.",
    "imageTooLarge": "이미지는 5MB 이하여야 합니다.",
    "selectPdfFile": "PDF 파일을 선택해 주세요.",
    "pdfTooLarge": "PDF 파일이 너무 큽니다.",
    "titleRequired": "상품 제목은 필수입니다.",
    "authorRequired": "저자명은 필수입니다.",
    "categoryRequired": "카테고리는 필수입니다.",
    "salePriceRequired": "판매가는 필수입니다.",
    "coverRequired": "도서 표지는 필수입니다.",
    "pdfFileRequired": "PDF 파일은 필수입니다.",
    "deleteProductConfirm": "“{{title}}”을 삭제할까요?",
    "deleteProductFailed": "상품을 삭제하지 못했습니다",
    "productSaved": "상품을 저장했습니다.",
    "productSaveFailed": "상품을 저장하지 못했습니다",
    "productCreated": "상품을 만들었습니다.",
    "productCreateFailed": "상품을 만들지 못했습니다",
    "activeLabel": "활성",
    "closeMessage": "메시지 닫기",
    "paperBook": "인쇄 도서",
    "productDetails": "상품 상세",
    "galleryImages": "갤러리 이미지",
    "replacePdf": "PDF 교체",
    "choosePdf": "PDF 선택",
    "selectFile": "파일 선택",
    "pdfHelp": "구매한 독자를 위한 비공개 PDF를 업로드합니다.",
    "qualityPercent": "품질 %",
    "deliveryNote": "배송 메모",
    "deliveryNotePlaceholder": "선택 배송 정보",
    "coverImage": "표지 이미지",
    "galleryImage": "갤러리 이미지",
    "noImage": "이미지 없음",
    "orderSearchPlaceholder": "주문 검색...",
    "recordsSearchPlaceholder": "상품 검색...",
    "productId": "ID: {{id}}",
    "stockDetail": "재고 {{count}} • {{condition}}",
    "stockQualityDetail": "재고 {{count}} • {{condition}} • {{quality}}%",
    "pagePdfDetail": "{{count}}페이지 • PDF",
    "bookInformationDivider": "도서 정보",
    "saleStock": "판매 및 재고",
    "coverSectionTitle": "도서 표지",
    "coverSectionHelp": "상품 카드에 표시할 세로 표지를 업로드합니다.",
    "mainCover": "메인 표지",
    "coverPreview": "표지 미리보기",
    "chooseReplaceCover": "도서 표지 선택 또는 교체",
    "chooseCover": "도서 표지 선택",
    "gallerySectionTitle": "도서 갤러리",
    "gallerySectionHelp": "상품 상세 페이지에 표시할 추가 세로 이미지를 업로드합니다.",
    "extraBookImages": "추가 도서 이미지",
    "enterBookTitle": "책 제목 입력",
    "authorNamePlaceholder": "저자명",
    "publisherPlaceholder": "출판사",
    "novelTypePlaceholder": "예: 크메르어, 영어, 중국어...",
    "genrePlaceholder": "로맨스, 판타지, 미스터리...",
    "paperTypePlaceholder": "예: 일반 용지, 광택 용지, 크림 용지...",
    "coverTypePlaceholder": "예: 페이퍼백, 하드커버...",
    "pageCountPlaceholder": "예: 436",
    "qualityPlaceholder": "예: 85",
    "salePricePlaceholder": "예: 8.75",
    "originalPricePlaceholder": "할인이 없으면 비워 두세요",
    "stockPlaceholder": "예: 10",
    "validCoverImage": "올바른 표지 이미지를 업로드해 주세요.",
    "validGalleryImage": "올바른 갤러리 이미지를 업로드해 주세요.",
    "validPdf": "올바른 PDF 파일을 업로드해 주세요.",
    "pdfSizeLimit": "PDF 파일은 50MB 이하여야 합니다.",
    "replaceAttachedPdf": "첨부 PDF 교체",
    "pageCountPdfPlaceholder": "예: 120",
    "conditionPlaceholder": "새 상품, 거의 새 상품, 양호, 보통...",
    "descriptionPlaceholder": "도서 상세, 상태, 배송 메모 또는 예약 메모...",
    "bookTitleRequired": "책 제목은 필수입니다.",
    "sellPriceRequired": "판매가는 필수입니다.",
    "stockNonNegative": "재고 수량은 음수가 될 수 없습니다.",
    "qualityRange": "도서 품질은 1%~100% 사이여야 합니다.",
    "pdfUploadTryAgain": "PDF 업로드에 실패했습니다. 다시 시도해 주세요.",
    "pdfUploadedReady": "PDF 업로드가 완료되었습니다. 상품을 만들 수 있습니다.",
    "pdfUploadingWait": "PDF 업로드가 완료될 때까지 기다려 주세요.",
    "pdfRetryUpload": "PDF 업로드 다시 시도",
    "pdfInvalidContents": "선택한 파일이 유효한 PDF가 아닙니다.",
    "pdfEmptyFile": "PDF 파일이 비어 있습니다.",
    "pdfAttachNotConfirmed": "상품에 PDF가 연결되었는지 확인할 수 없습니다. 다시 시도해 주세요.",
    "saveTryAgain": "저장에 실패했습니다. 다시 시도해 주세요.",
    "loadProductsUiFailed": "상품을 불러오지 못했습니다",
    "loadCategoriesUiFailed": "카테고리를 불러오지 못했습니다",
    "createCategoryUiFailed": "카테고리를 만들지 못했습니다",
    "updateCategoryUiFailed": "카테고리를 업데이트하지 못했습니다",
    "deleteCategoryUiFailed": "카테고리를 삭제하지 못했습니다",
    "saveCategoryOrderUiFailed": "카테고리 순서를 저장하지 못했습니다",
    "productNotSaved": "상품이 저장되지 않았습니다",
    "savedSuccessfully": "저장되었습니다",
    "deleteThisProduct": "이 상품",
    "searchOrderPlaceholder": "주문 ID, 구매자 이름, 전화번호 검색...",
    "storeTitle": "스토어",
    "mainCoverAlt": "도서 표지",
    "galleryImageAlt": "이미지 {{number}}",
    "searching": "검색 중..."
  }
})

function storeText(key, options) {
  return getDisplayText(`authorStoreManager.${key}`, options)
}

const STORE_VALUE_KEYS = {
  'New Books': 'newBooks',
  'Second Hand': 'secondHand',
  'Best Seller': 'bestSeller',
  'PDF Books': 'pdfBooks',
  'Pre-order': 'preOrder',
  'Author Picks': 'authorPicks',
  'New Release': 'newRelease',
  'Sold out': 'soldOut',
  All: 'all', Book: 'book', PDF: 'pdf', Active: 'active', Draft: 'draft', Hidden: 'hidden', New: 'new',
  'Normal Paper': 'normalPaper', 'Premium Paper': 'premiumPaper', 'Matte Cover': 'matteCover', 'Glossy Cover': 'glossyCover',
  'Download after payment': 'downloadAfterPayment',
  'Read online only': 'readOnlineOnly',
  'Download and read online': 'downloadAndReadOnline',
}

function storeValueLabel(value) {
  const key = STORE_VALUE_KEYS[value]
  return key ? storeText(key) : value
}

const API_BASE_URL =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com'

const DEFAULT_CATEGORIES = ['New Books', 'Second Hand', 'Best Seller', 'PDF Books', 'Pre-order', 'Author Picks', 'New Release']
const TYPE_FILTERS = ['All', 'Book', 'PDF', 'Active', 'Draft']
const PAPER_TYPES = ['Normal Paper', 'Premium Paper', 'Matte Cover', 'Glossy Cover']
const BOOK_CONDITIONS = ['New', 'Second Hand']
const PDF_ACCESS_RULES = ['Download after payment', 'Read online only', 'Download and read online']
const ORDER_REPORT_LIMIT = 20
const STORE_IMAGE_MAX_BYTES = 5 * 1024 * 1024


function withSystemCategories(categories) {
  const safeCategories = Array.isArray(categories) ? categories : []
  const hasSoldOut = safeCategories.some((category) => category.name === 'Sold out')

  if (hasSoldOut) return safeCategories

  return [
    ...safeCategories,
    {
      id: 'system-sold-out',
      name: 'Sold out',
      sortOrder: safeCategories.length,
      isDefault: true,
    },
  ]
}

function getAuthToken() {
  return (
    localStorage.getItem('shadow_reader_token') ||
    sessionStorage.getItem('shadow_reader_token') ||
    ''
  )
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`
}

function statusToApi(status) {
  const value = String(status || '').toLowerCase()
  if (value === 'active') return 'active'
  if (value === 'hidden') return 'hidden'
  return 'draft'
}

function apiTypeToUi(productType) {
  return productType === 'pdf' ? 'PDF' : 'Book'
}

function formatProductForUi(product) {
  return {
    id: product.id,
    type: apiTypeToUi(product.product_type),
    title: product.title || '',
    authorName: product.author_name || product.authorName || '',
    publisher: product.publisher || '',
    novelType: product.novel_type || product.novelType || '',
    category: product.category || 'New Books',
    genre: product.genre || '',
    description: product.description || '',
    coverType: product.cover_type || product.coverType || '',
    sortOrder: String(product.sort_order ?? product.sortOrder ?? 0),
    bestSeller: Boolean(product.best_seller ?? product.bestSeller),
    discount: Boolean(product.discount),
    originalPrice: String(product.original_price || ''),
    salePrice: String(product.sale_price || ''),
    status: product.status === 'active' ? 'Active' : product.status === 'hidden' ? 'Hidden' : 'Draft',
    coverUrl: product.cover_url || '',
galleryImages: formatGalleryImagesForUi(product.gallery_images),
    stock: String(product.stock_quantity || ''),
    paperType: product.paper_type || 'Normal Paper',
    condition: product.book_condition || 'New',
    qualityPercent: product.quality_percent ? String(product.quality_percent) : '',
    deliveryNote: product.delivery_note || '',
    preOrder: Boolean(product.pre_order),
   pdfFileUrl: product.pdf_file_url || '',
pdfFileName: product.pdf_file_name || '',
pageCount: product.page_count || '',
accessRule: product.access_rule || 'Read online only',
    
    createdAt: product.created_at,
updatedAt: product.updated_at || product.updatedAt || product.created_at,
  }
}

function formatGalleryImagesForUi(images) {
  const list = Array.isArray(images) ? images : []

  return list
    .map((item) => {
      if (typeof item === 'string') {
        return {
          url: item,
          name: '',
        }
      }

      return {
        url: item?.url || item?.image_url || item?.imageUrl || '',
        name: item?.name || item?.file_name || item?.fileName || '',
      }
    })
    .filter((item) => item.url)
    .slice(0, 5)
}

async function uploadStoreProductImage(file, category, preset, errorKey, { signal, onProgress } = {}) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const optimized = await optimizeImageForUpload(file, {
    preset,
    maxSourceBytes: STORE_IMAGE_MAX_BYTES,
  })

  const legacyUpload = async ({ signal } = {}) => {
    const formData = new FormData()
    formData.append('image', optimized.file)
    formData.append('folder', category)

    const response = await fetch(`${API_BASE_URL}/api/story-media/upload-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
      signal,
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok || data.ok === false) {
      throw new Error(data.message || storeText(errorKey))
    }

    return data
  }

  const data = await uploadMediaWithFallback({
    file: optimized.file,
    category,
    token,
    apiBaseUrl: API_BASE_URL,
    legacyUpload,
    signal,
    onProgress,
  })

  const imageUrl = String(data?.image_url || data?.imageUrl || '').trim()
  if (!/^https?:\/\//i.test(imageUrl)) throw new Error(storeText(errorKey))
  return imageUrl
}

async function uploadCoverImage(file) {
  return uploadStoreProductImage(file, 'author_store_cover', 'cover', 'uploadCoverFailed')
}

async function uploadGalleryImage(file) {
  return uploadStoreProductImage(file, 'author_store_gallery', 'gallery', 'uploadGalleryFailed')
}

function storeImageAccountId() {
  try {
    const segment = String(getAuthToken()).split('.')[1]
    const payload = JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=')))
    return String(payload.user_id || payload.sub || '').trim()
  } catch {
    return ''
  }
}

function createStoreImageUploadQueue({ productKey, onChange }) {
  const accountId = storeImageAccountId()
  if (!accountId) throw new Error(storeText('pleaseLogin'))
  const ownerId = `${accountId}:author-store-images:${String(productKey || 'new')}`
  const manager = createUploadQueueManager({
    ownerId,
    upload: async ({ task, file, signal, onProgress }) => {
      if (storeImageAccountId() !== accountId) throw new Error(storeText('pleaseLogin'))
      const category = task.context?.slot === 'cover' ? 'author_store_cover' : 'author_store_gallery'
      const imageUrl = await uploadStoreProductImage(
        file,
        category,
        category === 'author_store_cover' ? 'cover' : 'gallery',
        category === 'author_store_cover' ? 'uploadCoverFailed' : 'uploadGalleryFailed',
        { signal, onProgress }
      )
      if (storeImageAccountId() !== accountId) throw new Error(storeText('pleaseLogin'))
      return { imageUrl }
    },
    onChange: (event) => {
      if (storeImageAccountId() === accountId) onChange?.(event)
    },
  })
  return {
    ...manager,
    ownerId,
    async enqueueImage(file, slot) {
      if (storeImageAccountId() !== accountId) throw new Error(storeText('pleaseLogin'))
      const category = slot === 'cover' ? 'author_store_cover' : 'author_store_gallery'
      void requestUploadStoragePersistence()
      return manager.enqueue({
        file,
        category,
        kind: 'image',
        context: { slot, accountId, productKey: String(productKey || 'new') },
      })
    },
    async file(taskId) {
      if (storeImageAccountId() !== accountId) throw new Error(storeText('pleaseLogin'))
      return readMediaUploadFile(taskId, ownerId)
    },
  }
}

function uploadPrivatePdfFile(file, onProgress) {
  const token = getAuthToken()
  if (!token) return Promise.reject(new Error(storeText('pleaseLogin')))
  if (!file) return Promise.reject(new Error(storeText('pdfRequired')))
  if (!file.size) return Promise.reject(new Error(storeText('pdfEmptyFile')))
  if (file.size > 50 * 1024 * 1024) return Promise.reject(new Error(storeText('pdfSizeLimit')))

  const messages = {
    en: {
      offline: 'Your device is offline. Reconnect and retry.',
      unreachable: 'The API could not be reached from this device. The cause could be a network, DNS, CORS, or server outage.',
      before: 'The API is reachable, but the PDF request failed before transfer. Check CORS, upload security rules, and the server logs.',
      during: 'The PDF transfer stopped at {{percent}}%. The mobile connection, proxy, or server may have interrupted it.',
      after: 'The PDF was sent, but the server response was not received. Check the upload trace in Render logs.',
      timeout: 'The PDF upload timed out before the server confirmed it.',
      aborted: 'The browser or device interrupted the PDF request.',
      server: 'The server failed to process the PDF.',
      forbidden: 'The account is not permitted to upload this PDF.',
      unauthorized: 'Your login session expired. Sign in and retry.',
      limited: 'Too many upload attempts. Wait and try again.',
      unavailable: 'The server or upload gateway is temporarily unavailable.',
      invalid: 'The server rejected the PDF or its metadata.',
      response: 'The server returned an invalid PDF upload response.',
    },
    km: {
      offline: 'ទូរស័ព្ទគ្មានអ៊ីនធឺណិត។ សូមភ្ជាប់បណ្ដាញហើយសាកម្តងទៀត។',
      unreachable: 'ទូរស័ព្ទមិនអាចទាក់ទង API បាន។ អាចបណ្ដាលពីបណ្ដាញ DNS CORS ឬ Server។',
      before: 'API អាចទាក់ទងបាន ប៉ុន្តែការផ្ញើ PDF ត្រូវបានរារាំងមុនផ្ទេរ។ សូមពិនិត្យ CORS ប្រព័ន្ធការពារ និង Render Logs។',
      during: 'ការផ្ញើ PDF ដាច់ត្រឹម {{percent}}%។ អាចបណ្ដាលពីបណ្ដាញទូរស័ព្ទ Proxy ឬ Server ផ្តាច់ការតភ្ជាប់។',
      after: 'PDF ត្រូវបានផ្ញើរួច ប៉ុន្តែមិនទទួលបានចម្លើយពី Server។ សូមឆែក Trace នៅ Render Logs។',
      timeout: 'ការបង្ហោះ PDF ផុតពេល មុន Server បញ្ជាក់ជោគជ័យ។',
      aborted: 'Browser ឬទូរស័ព្ទបានផ្ដាច់ការផ្ញើ PDF។',
      server: 'Server មិនអាចដំណើរការ PDF បាន។',
      forbidden: 'គណនីនេះមិនមានសិទ្ធិបង្ហោះ PDF ទេ។',
      unauthorized: 'ការចូលគណនីផុតសុពលភាព។ សូមចូលម្ដងទៀត។',
      limited: 'ព្យាយាមបង្ហោះច្រើនដងពេក។ សូមរង់ចាំហើយសាកវិញ។',
      unavailable: 'Server ឬ Upload Gateway មិនអាចប្រើបានបណ្ដោះអាសន្ន។',
      invalid: 'Server បានបដិសេធឯកសារ PDF ឬព័ត៌មានឯកសារ។',
      response: 'Server ផ្ញើចម្លើយ PDF Upload មិនត្រឹមត្រូវ។',
    },
    zh: {
      offline: '设备已离线，请联网后重试。',
      unreachable: '设备无法连接 API；可能是网络、DNS、CORS 或服务器故障。',
      before: 'API 可访问，但上传请求在传输前失败；请检查 CORS、安全规则及服务器日志。',
      during: 'PDF 传输在 {{percent}}% 中断；可能是网络、代理或服务器连接问题。',
      after: 'PDF 已发送，但未收到服务器响应；请在 Render 日志中查询追踪编号。',
      timeout: '服务器确认前上传超时。',
      aborted: '浏览器或设备中断了 PDF 上传。',
      server: '服务器处理 PDF 失败。',
      forbidden: '当前账户无权上传此 PDF。',
      unauthorized: '登录已过期，请重新登录。',
      limited: '上传尝试过于频繁，请稍后重试。',
      unavailable: '服务器或上传网关暂时不可用。',
      invalid: '服务器拒绝了 PDF 文件或其元数据。',
      response: '服务器返回了无效的上传响应。',
    },
    ja: {
      offline: '端末がオフラインです。接続して再試行してください。',
      unreachable: 'API に接続できません。回線、DNS、CORS、サーバー障害の可能性があります。',
      before: 'API は稼働していますが、転送前に失敗しました。CORS、保護設定、ログを確認してください。',
      during: 'PDF 転送が {{percent}}% で停止しました。回線、プロキシ、サーバーの可能性があります。',
      after: 'PDF を送信しましたが応答がありません。Render ログで追跡番号を確認してください。',
      timeout: 'サーバー確認前にアップロードがタイムアウトしました。',
      aborted: 'ブラウザーまたは端末がアップロードを中断しました。',
      server: 'サーバーで PDF の処理に失敗しました。',
      forbidden: 'このアカウントには PDF アップロード権限がありません。',
      unauthorized: 'ログイン期限が切れました。再度ログインしてください。',
      limited: '試行回数が多すぎます。しばらくして再試行してください。',
      unavailable: 'サーバーまたはアップロードゲートウェイが一時的に利用できません。',
      invalid: 'サーバーが PDF またはファイル情報を拒否しました。',
      response: 'サーバーから不正な応答がありました。',
    },
    ko: {
      offline: '기기가 오프라인입니다. 연결한 후 다시 시도하세요.',
      unreachable: 'API에 연결할 수 없습니다. 네트워크, DNS, CORS 또는 서버 문제일 수 있습니다.',
      before: 'API는 연결되지만 전송 전에 업로드가 실패했습니다. CORS, 보안 규칙, 로그를 확인하세요.',
      during: 'PDF 전송이 {{percent}}%에서 중단되었습니다. 연결, 프록시 또는 서버 문제일 수 있습니다.',
      after: 'PDF를 전송했으나 서버 응답이 없습니다. Render 로그에서 추적 번호를 확인하세요.',
      timeout: '서버 확인 전에 업로드 시간이 초과되었습니다.',
      aborted: '브라우저 또는 기기가 업로드를 중단했습니다.',
      server: '서버에서 PDF 처리에 실패했습니다.',
      forbidden: '이 계정은 PDF 업로드 권한이 없습니다.',
      unauthorized: '로그인 세션이 만료되었습니다. 다시 로그인하세요.',
      limited: '업로드 시도가 너무 많습니다. 잠시 기다렸다가 재시도하세요.',
      unavailable: '서버 또는 업로드 게이트웨이를 일시적으로 사용할 수 없습니다.',
      invalid: '서버에서 PDF 또는 파일 정보를 거부했습니다.',
      response: '서버가 올바르지 않은 업로드 응답을 보냈습니다.',
    },
  }
  const localized = messages[getDisplayLanguageId()] || messages.en
  const trace = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const requestUrl = `${API_BASE_URL}/api/author-store/me/pdfs/upload-private?trace=${encodeURIComponent(trace)}`
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const formData = new FormData()
    formData.append('pdf', file)
    const request = new XMLHttpRequest()
    let loadedBytes = 0
    let uploadCompleted = false
    let settled = false

    const diagnostic = (kind, status = request.status) => {
      const entry = {
        trace,
        kind,
        status,
        file_bytes: file.size,
        sent_bytes: loadedBytes,
        transfer_complete: uploadCompleted,
        duration_ms: Date.now() - startedAt,
        browser_online: navigator.onLine,
      }
      console.error('AUTHOR_STORE_PDF_UPLOAD_DIAGNOSTIC', entry)
    }

    const fail = (kind, message) => {
      if (settled) return
      settled = true
      diagnostic(kind)
      reject(new Error(`${message} [PDF ${trace}]`))
    }

    const probe = async () => {
      if (navigator.onLine === false) return 'offline'
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(`${API_BASE_URL}/health/maintenance`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        })
        return response.status >= 500 ? 'unavailable' : 'reachable'
      } catch {
        return 'unreachable'
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    const transportFailure = async () => {
      if (settled) return
      const connection = await probe()
      if (settled) return
      const percent = Math.min(100, Math.round((loadedBytes / file.size) * 100))
      const stage = connection === 'offline' ? 'offline'
        : connection === 'unavailable' ? 'unavailable'
          : connection === 'unreachable' ? 'unreachable'
            : uploadCompleted || percent === 100 ? 'after'
              : loadedBytes > 0 ? 'during' : 'before'
      fail(stage, localized[stage].replace('{{percent}}', String(percent)))
    }

    request.open('POST', requestUrl)
    request.timeout = 600000
    request.setRequestHeader('Authorization', `Bearer ${token}`)
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || !event.total) return
      loadedBytes = event.loaded
      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100))
      onProgress?.(percent)
    }
    request.upload.onload = () => {
      uploadCompleted = true
      loadedBytes = file.size
    }
    request.onload = () => {
      let data = {}
      try {
        data = JSON.parse(request.responseText || '{}')
      } catch {
        data = {}
      }
      if (request.status < 200 || request.status >= 300 || data.ok === false) {
        const key = request.status === 401 ? 'unauthorized'
          : request.status === 403 ? 'forbidden'
            : request.status === 413 ? null
              : request.status === 429 ? 'limited'
                : request.status >= 500 ? 'server' : 'invalid'
        const message = request.status === 413
          ? storeText('pdfSizeLimit')
          : data.message || (key ? localized[key] : localized.invalid)
        fail(`HTTP_${request.status}_${String(data.code || 'ERROR').slice(0, 64)}`, message)
        return
      }
      if (!data.pdf?.storage_key) {
        fail('INVALID_SERVER_RESPONSE', localized.response)
        return
      }
      if (settled) return
      settled = true
      onProgress?.(100)
      resolve(data.pdf)
    }
    request.onerror = () => { void transportFailure() }
    request.onabort = () => fail('BROWSER_ABORTED', localized.aborted)
    request.ontimeout = () => fail('REQUEST_TIMEOUT', localized.timeout)
    try {
      request.send(formData)
    } catch (error) {
      fail('BROWSER_SEND_ERROR', error?.message || localized.before)
    }
  })
}

async function discardTemporaryAuthorPdf(pdf) {
  if (!pdf?.storage_key) return
  const token = getAuthToken()
  if (!token) return

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/pdfs/temporary`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ storage_key: pdf.storage_key }),
  })
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.message || storeText('uploadPdfFailed'))
  }
}

async function attachPrivatePdfToProduct(productId, pdf) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))
  if (!productId) throw new Error(storeText('productIdRequired'))
  if (!pdf?.storage_key) throw new Error(storeText('pdfStorageMissing'))

  const response = await fetch(
    `${API_BASE_URL}/api/author-store/me/products/${encodeURIComponent(productId)}/private-pdf`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pdf_storage_key: pdf.storage_key,
        pdf_file_name: pdf.file_name,
        pdf_mime_type: pdf.mime_type,
        pdf_file_size_bytes: pdf.file_size_bytes,
      }),
    }
  )

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('attachPdfFailed'))
  }

  return data.product || null
}



async function fetchMyStorePromotion() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/promotion`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('loadPromotionFailed'))
  }

  return data.promotion || null
}

async function fetchMyOrderReport({ page = 1, limit = 20, type = 'book', prepareStatus = 'all', q = '' } = {}) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    type,
    prepare_status: prepareStatus,
  })

  if (q) params.set('q', q)

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/orders?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('loadOrdersFailed'))
  }

  return {
    summary: data.summary || {
      orders_count: 0,
      revenue: 0,
      gross_revenue: 0,
      platform_fee: 0,
      author_income: 0,
    },
    orders: Array.isArray(data.orders) ? data.orders : [],
    pagination: data.pagination || {
      page: Number(data.page || page),
      limit: Number(data.limit || limit),
      total: Number(data.total || 0),
      total_pages: Number(data.total_pages || 1),
    },
  }
}

async function fetchMyOrderSummary() {
  const token = getAuthToken()
  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/orders?summary_only=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false || !data.summary || !Number.isFinite(Number(data.summary.orders_count ?? data.summary.total_orders))) {
    throw new Error(data.message || storeText('loadOrdersFailed'))
  }
  return data.summary
}

async function markMyAuthorStoreOrderPreparing(orderId) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/orders/${encodeURIComponent(orderId)}/preparing`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('markPreparingFailed'))
  }

  return data.order || null
}

async function fetchDeliverySettings() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/delivery-settings`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('loadDeliveryFailed'))
  }

  return data.delivery_settings || []
}

async function fetchTelegramSettings() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/telegram-settings`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('loadTelegramFailed'))
  }

  return data.telegram_settings || {}
}

async function createTelegramConnectLink() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/telegram-settings/connect-link`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('connectTelegramFailed'))
  }

  return data
}

async function unlinkTelegramGroup() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/telegram-settings/unlink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('unlinkTelegramFailed'))
  }

  return data.telegram_settings || {}
}

async function fetchSalesReportsSettings() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/sales-reports`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('loadSalesReportsFailed'))
  }

  return data
}

async function connectSalesReports(spreadsheetUrl) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/sales-reports/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      spreadsheet_url: spreadsheetUrl,
    }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('connectSheetFailed'))
  }

  return data
}

async function syncSalesReports() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/sales-reports/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('syncSalesReportsFailed'))
  }

  return data
}

async function disconnectSalesReports() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/sales-reports/disconnect`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('disconnectSheetFailed'))
  }

  return data
}


async function updateDeliverySettings(deliverySettings) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/delivery-settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ delivery_settings: deliverySettings }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('updateDeliveryFailed'))
  }

  return data.delivery_settings || []
}

async function createStoreProduct(product) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      product_type: product.type === 'PDF' ? 'pdf' : 'book',
      title: product.title,
      author_name: product.authorName,
      publisher: product.publisher,
      novel_type: product.novelType,
      category: product.category,
      genre: product.genre,
      description: product.description,
      cover_type: product.coverType,
      sort_order: product.sortOrder,
      best_seller: Boolean(product.bestSeller),
      discount: Boolean(product.discount),
      original_price: product.originalPrice,
      sale_price: product.salePrice,
      status: statusToApi(product.status),
      cover_url: product.coverUrl,
      gallery_images: product.galleryImages || [],
      stock_quantity: product.stock,
      paper_type: product.paperType,
      book_condition: product.condition,
      quality_percent: product.qualityPercent,
      delivery_note: product.deliveryNote,
      pre_order: product.preOrder,
      pdf_file_url: product.type === 'PDF' ? '' : product.pdfFileUrl,
      pdf_file_name: product.pdfFileName,
      page_count: product.pageCount,
      access_rule: product.accessRule,
    }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('productCreateFailed'))
  }

  return data.product ? formatProductForUi(data.product) : null
}

async function updateStoreProduct(productId, product) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/products/${productId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      product_type: product.type === 'PDF' ? 'pdf' : 'book',
      title: product.title,
      author_name: product.authorName,
      publisher: product.publisher,
      novel_type: product.novelType,
      category: product.category,
      genre: product.genre,
      description: product.description,
      cover_type: product.coverType,
      sort_order: product.sortOrder,
      best_seller: Boolean(product.bestSeller),
      discount: Boolean(product.discount),
      original_price: product.originalPrice,
      sale_price: product.salePrice,
      status: statusToApi(product.status),
      cover_url: product.coverUrl,
      gallery_images: product.galleryImages || [],
      stock_quantity: product.stock,
      paper_type: product.paperType,
      book_condition: product.condition,
      quality_percent: product.qualityPercent,
      delivery_note: product.deliveryNote,
      pre_order: product.preOrder,
      pdf_file_url: product.pdfFileUrl,
      pdf_file_name: product.pdfFileName,
      page_count: product.pageCount,
      access_rule: product.accessRule,
    }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('productSaveFailed'))
  }

  return data.product ? formatProductForUi(data.product) : null
}

async function deleteStoreProduct(productId) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/products/${productId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('deleteProductFailed'))
  }

  return data
}

function safeCoverPreviewUrl(value) {
  const source = String(value || '').trim()
  if (!source) return ''

  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(source)) {
    return source
  }

  try {
    const url = new URL(source, window.location.origin)

    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.href
    }

    if (url.protocol === 'blob:' && url.origin === window.location.origin) {
      return url.href
    }
  } catch {
    return ''
  }

  return ''
}

function FieldLabel({ children }) {
  const label = String(children || '')
  const hasRequiredMark = label.includes('*')
  const cleanLabel = label.replace(/\*/g, '').trim()

  return (
    <div className="mb-1.5 text-[12px] font-medium tracking-normal text-[var(--shadow-text-secondary)]">
      {cleanLabel}
      {hasRequiredMark ? <span className="font-semibold text-[#ef4444]"> *</span> : null}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, type = 'text' }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="h-11 w-full rounded-2xl border border-[var(--shadow-border)] bg-[var(--shadow-input-bg)] px-3.5 text-[13px] font-medium text-[var(--shadow-text-primary)] placeholder:font-normal outline-none focus:border-[var(--shadow-border-strong)]"
    />
  )
}

function SelectInput({ value, onChange, children }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-11 w-full rounded-2xl border border-[var(--shadow-border)] bg-[var(--shadow-input-bg)] px-3.5 text-[13px] font-medium text-[var(--shadow-text-primary)] placeholder:font-normal outline-none focus:border-[var(--shadow-border-strong)]"
    >
      {children}
    </select>
  )
}

function AdminStyleCard({ title, text, children }) {
  return (
    <section className="overflow-hidden rounded-[24px] bg-[var(--shadow-bg-surface)] shadow-sm ring-1 ring-[var(--shadow-border)]">
      <div className="border-b border-[var(--shadow-border)] px-4 py-4">
        <h2 className="text-[17px] font-black leading-5 text-[var(--shadow-text-primary)]">{title}</h2>
        {text ? <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">{text}</p> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function FormDivider({ title }) {
  return (
    <div className="border-t border-[var(--shadow-border)] pt-4">
      <div className="mb-3 text-[12px] font-bold uppercase tracking-[0.07em] text-[var(--shadow-text-secondary)]">{title}</div>
    </div>
  )
}


function EmptyState({ onAddProduct }) {
  return (
    <div className="rounded-[22px] bg-gradient-to-br from-[#f8f5ff] via-[var(--shadow-bg-surface)] to-[#fff8e8] px-5 py-7 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#f1ebff] text-[#7c5cff] shadow-[0_10px_26px_rgba(124,91,255,0.16)] ring-1 ring-[var(--shadow-border)]">
        <i className="fa-solid fa-store text-[22px]" />
      </div>

      <h3 className="mt-4 text-[17px] font-bold leading-6 text-[var(--shadow-text-primary)]">{storeText('createFirstProduct')}</h3>

      <p className="mx-auto mt-2 max-w-[280px] text-[12px] font-normal leading-5 text-[var(--shadow-text-secondary)]">{storeText('createFirstProductHelp')}</p>

      <button
        type="button"
        onClick={onAddProduct}
        className="mt-5 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#8b5cf6] to-[#a78bfa] px-6 text-[13px] font-normal text-white shadow-[0_12px_26px_rgba(124,91,255,0.28)] active:scale-[0.97]"
      >
        <i className="fa-solid fa-plus text-[11px]" />{storeText('addProduct')}</button>

      <div className="mt-4 flex items-center justify-center gap-2">
        {['Book', 'PDF', 'Pre-order'].map((item) => (
          <span
            key={item}
            className="rounded-full bg-[var(--shadow-bg-surface)] px-3 py-1 text-[10px] font-normal text-[var(--shadow-text-secondary)] shadow-sm ring-1 ring-[var(--shadow-border)]"
          >
            {storeValueLabel(item)}
          </span>
        ))}
      </div>
    </div>
  )
}

function ProductCard({ product }) {
  const priceText = product.salePrice || product.originalPrice || '0.00'
  const hasDiscount = product.salePrice && product.originalPrice && product.salePrice !== product.originalPrice

  return (
    <div className="overflow-hidden rounded-[24px] bg-[var(--shadow-bg-surface)] shadow-sm ring-1 ring-[var(--shadow-border)]">
      <div className="relative aspect-[3/4] bg-[var(--shadow-bg-soft)]">
        {product.coverUrl ? (
          <img src={product.coverUrl} alt={product.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[var(--shadow-text-tertiary)]">
            <i className="fa-regular fa-image text-[30px]" />
          </div>
        )}

        <div className="absolute left-2 top-2 rounded-full bg-[var(--shadow-bg-surface)] px-2.5 py-1 text-[10px] font-black text-[var(--shadow-text-primary)] shadow-sm">
          {storeValueLabel(product.type)}
        </div>
        <button
          type="button"
          className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-primary)] shadow-lg ring-1 ring-[var(--shadow-border)] active:scale-95"
        >
          <i className="fa-solid fa-bag-shopping text-[13px]" />
        </button>
      </div>

      <div className="p-3">
        <h3 className="line-clamp-2 min-h-[38px] text-[14px] font-black leading-5 text-[var(--shadow-text-primary)]">{product.title || storeText('untitledProduct')}</h3>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-[var(--shadow-bg-soft)] px-2 py-1 text-[10px] font-black text-[var(--shadow-text-secondary)] ring-1 ring-[var(--shadow-border)]">{storeValueLabel(product.category)}</span>
          <span className={`rounded-full px-2 py-1 text-[10px] font-black ${product.status === 'Active' ? 'bg-[#ecfdf3] text-[#027a48]' : 'bg-[#f5f3ff] text-[#6b5cff]'}`}>{storeValueLabel(product.status)}</span>
        </div>

        <div className="mt-2 text-[15px] font-black text-[var(--shadow-text-primary)]">
          ${priceText}
          {hasDiscount ? <span className="ml-2 text-[11px] font-bold text-[var(--shadow-text-tertiary)] line-through">${product.originalPrice}</span> : null}
        </div>

        <div className="mt-1 text-[11px] font-bold text-[var(--shadow-text-tertiary)]">
          {product.type === 'Book'
            ? (product.condition === 'Second Hand' && product.qualityPercent
              ? storeText('stockQualityDetail', { count: product.stock || 0, condition: storeValueLabel(product.condition), quality: product.qualityPercent })
              : storeText('stockDetail', { count: product.stock || 0, condition: storeValueLabel(product.condition) }))
            : storeText('pagePdfDetail', { count: product.pageCount || 0 })}
        </div>
      </div>
    </div>
  )
}

function ProductRecordRow({ product, onEdit, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const priceText = product.salePrice || product.originalPrice || '0.00'
  const hasDiscount =
    product.salePrice &&
    product.originalPrice &&
    product.salePrice !== product.originalPrice
  const isActive = product.status === 'Active'
  const isDraft = product.status === 'Draft'

  return (
    <article className="border-b border-[var(--shadow-border)] px-0 py-3 last:border-b-0">
      <div className="flex gap-3">
        <div className="h-[86px] w-[64px] shrink-0 overflow-hidden rounded-[12px] bg-[var(--shadow-bg-soft)] ring-1 ring-[var(--shadow-border)]">
          {product.coverUrl ? (
            <img
              src={product.coverUrl}
              alt={product.title}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[var(--shadow-text-tertiary)]">
              <i className="fa-regular fa-image text-[18px]" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="line-clamp-1 text-[13px] font-black text-[var(--shadow-text-primary)]">
                {product.title || storeText('untitledProduct')}
              </h3>

              <p className="mt-0.5 text-[10px] font-bold text-[var(--shadow-text-tertiary)]">
                {storeText('productId', { id: product.id })}
              </p>
            </div>

            <div className={`relative shrink-0 ${menuOpen ? 'z-[150]' : ''}`}>
              <button
                type="button"
                onClick={() => setMenuOpen((current) => !current)}
                className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--shadow-bg-surface)] text-[#7c5cff] shadow-[0_6px_16px_rgba(124,91,255,0.10)] ring-1 ring-[var(--shadow-border)] transition active:scale-95"
                aria-label={storeText('productOptions')}
                aria-expanded={menuOpen}
              >
                <i className="fa-solid fa-ellipsis-vertical text-[13px]" />
              </button>

              {menuOpen ? (
                <>
                  <button
                    type="button"
                    aria-label={storeText('closeProductMenu')}
                    onClick={() => setMenuOpen(false)}
                    className="fixed inset-0 z-[149] cursor-default bg-transparent"
                  />

                  <div className="absolute right-0 top-[38px] z-[150] w-[130px] overflow-hidden rounded-[14px] bg-[var(--shadow-bg-surface)] p-1.5 shadow-[0_16px_38px_rgba(45,39,102,0.20)] ring-1 ring-[var(--shadow-border)]">
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false)
                        onEdit(product)
                      }}
                      className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[12px] font-normal text-[#6f4cff] transition hover:bg-[#f3edff] active:bg-[#eee7ff]"
                    >
                      <i className="fa-regular fa-pen-to-square w-4 text-center text-[12px]" />{storeText('edit')}</button>

                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false)
                        onDelete(product)
                      }}
                      className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[12px] font-normal text-[#e5484d] transition hover:bg-[#fff1f1] active:bg-[#ffe8e8]"
                    >
                      <i className="fa-regular fa-trash-can w-4 text-center text-[12px]" />{storeText('delete')}</button>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-[var(--shadow-bg-soft)] px-2 py-1 text-[10px] font-black text-[var(--shadow-text-secondary)] ring-1 ring-[var(--shadow-border)]">
              {storeValueLabel(product.category)}
            </span>

            <span className="rounded-full bg-[var(--shadow-bg-soft)] px-2 py-1 text-[10px] font-black text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)]">
              {storeValueLabel(product.type)}
            </span>

            <span
              className={`rounded-full px-2 py-1 text-[10px] font-black ${
                isActive
                  ? 'bg-[#ecfdf3] text-[#027a48]'
                  : isDraft
                    ? 'bg-[#f5f3ff] text-[#6b5cff]'
                    : 'bg-[var(--shadow-bg-soft)] text-[var(--shadow-text-secondary)]'
              }`}
            >
              {storeValueLabel(product.status)}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-[var(--shadow-text-secondary)]">
            <span className="font-black text-[var(--shadow-text-primary)]">${priceText}</span>

            {hasDiscount ? (
              <span className="line-through">${product.originalPrice}</span>
            ) : null}

            <span>
              {product.type === 'Book'
                ? `${storeText('stockCount', { count: product.stock || 0 })} • ${storeValueLabel(product.condition)}`
                : storeText('pageCountPdf', { count: product.pageCount || 0 })}
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

function formatCategoryForUi(category) {
  return {
    id: category.id,
    name: category.name || '',
    sortOrder: Number(category.sort_order || 0),
    isDefault: Boolean(category.is_default),
    isHidden: Boolean(category.is_hidden),
  }
}

async function fetchMyCategories() {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/categories`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('loadCategoriesFailed'))
  }

  return Array.isArray(data.categories) ? data.categories.map(formatCategoryForUi) : []
}

async function createStoreCategory(name) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/categories`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('createCategoryFailed'))
  }

  return data.category ? formatCategoryForUi(data.category) : null
}

async function updateStoreCategory(categoryId, updates) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/categories/${categoryId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('updateCategoryFailed'))
  }

  return data.category ? formatCategoryForUi(data.category) : null
}


async function deleteStoreCategory(categoryId) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/categories/${categoryId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('deleteCategoryFailed'))
  }

  return data
}

async function reorderStoreCategories(categoryIds) {
  const token = getAuthToken()

  if (!token) throw new Error(storeText('pleaseLogin'))

  const response = await fetch(`${API_BASE_URL}/api/author-store/me/categories/reorder`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ category_ids: categoryIds }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || storeText('saveCategoryOrderFailed'))
  }

  return Array.isArray(data.categories) ? data.categories.map(formatCategoryForUi) : []
}

function StatCard({ label, value, icon }) {
  return (
    <div className="relative overflow-hidden rounded-[10px] bg-[var(--shadow-bg-surface)] p-3.5 shadow-[0_14px_34px_rgba(124,91,255,0.12)] ring-1 ring-[var(--shadow-border)] backdrop-blur">
      <div className="absolute -right-6 -top-6 h-16 w-16 rounded-full bg-[#ede9fe]/70 blur-2xl" />

      <div className="relative flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#f3edff] text-[#7c5cff] shadow-[0_10px_24px_rgba(124,91,255,0.18)] ring-1 ring-[var(--shadow-border)]">
          <i className={`fa-solid ${icon} text-[14px]`} />
        </div>

        <div className="min-w-0">
          <div className="text-[20px] font-black leading-6 text-[var(--shadow-text-primary)]">{value}</div>
          <div className="mt-1 text-[12px] font-semibold text-[var(--shadow-text-secondary)]">{label}</div>
        </div>
      </div>
    </div>
  )
}

function OrderHistoryRow({ order, onMarkPreparing, preparingLoading }) {
  const items = Array.isArray(order.items) ? order.items : []
  const firstItem = items[0] || {}
  const title = firstItem.product_title || firstItem.title || order.product_title || storeText('orderItem')
  const total = order.total_usd || order.total_amount || order.product_subtotal_usd || order.amount_usd || 0
  const buyer = order.buyer_name || order.customer_name || order.reader_name || storeText('reader')
  const phone = order.buyer_phone || order.customer_phone || ''
  const dateText = order.created_at ? new Date(order.created_at).toLocaleString(getDisplayLanguageId()) : ''
  const preparing = String(order.author_prepare_status || '').toLowerCase() === 'preparing'
  const hasBook = items.some((item) => String(item.product_type || '').toLowerCase() === 'book')

  return (
    <article className="rounded-[22px] bg-[var(--shadow-bg-surface)] px-4 py-4 shadow-sm ring-1 ring-[var(--shadow-border)]">
      <div className="flex items-start gap-3">
        <div className="h-14 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--shadow-bg-soft)] ring-1 ring-[var(--shadow-border)]">
          {firstItem.cover_url ? (
            <img src={firstItem.cover_url} alt={title} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[var(--shadow-text-tertiary)]">
              <i className="fa-regular fa-image text-[14px]" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-[14px] font-black text-[var(--shadow-text-primary)]">{title}</div>
          <div className="mt-1 text-[11px] font-bold text-[var(--shadow-text-tertiary)]">
            {storeText('orderNumber', { number: String(order.order_number || order.order_id || order.id || '').slice(0, 16) })}
          </div>
          <div className="mt-1 text-[12px] font-semibold text-[var(--shadow-text-secondary)]">
            {buyer}{phone ? ` · ${phone}` : ''}
          </div>
          {dateText ? <div className="mt-0.5 text-[11px] font-semibold text-[var(--shadow-text-tertiary)]">{dateText}</div> : null}
        </div>

        <div className="shrink-0 text-right">
          <div className="text-[14px] font-black text-[var(--shadow-text-primary)]">{formatMoney(total)}</div>
          <div className="mt-1 text-[11px] font-bold text-[var(--shadow-text-secondary)]" >
            {storeText('income', { amount: formatMoney(order.author_income_usd || 0) })}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--shadow-border)] pt-3">
        <div className="text-[11px] font-bold text-[var(--shadow-text-tertiary)]">
          {items.length || 1} {(items.length || 1) === 1 ? storeText('item') : storeText('items')}
        </div>

        {hasBook ? (
          preparing ? (
            <div className="rounded-full bg-[#ecfdf3] px-3 py-1.5 text-[11px] font-black text-[#027a48]" >
              {storeText('preparing')}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onMarkPreparing(order)}
              disabled={preparingLoading}
              className="rounded-full bg-[var(--shadow-text-primary)] px-3 py-1.5 text-[11px] font-black text-[var(--shadow-bg-surface)] disabled:opacity-50"
            >
              {preparingLoading ? storeText('saving') : storeText('markPreparing')}
            </button>
          )
        ) : (
          <div className="rounded-full bg-[var(--shadow-bg-soft)] px-3 py-1.5 text-[11px] font-black text-[var(--shadow-text-secondary)]" >
            {storeText('pdfOrder')}
          </div>
        )}
      </div>
    </article>
  )
}

function readStoredJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || sessionStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function getAuthorStoreAccountId() {
  const reader = readStoredJson('shadow_reader_user') || {}
  const author = readStoredJson('shadow_author_page') || {}
  const userId = String(reader.user_id || reader.id || author.user_id || '').trim()
  const pageId = String(author.author_page_id || author.id || '').trim()
  if (userId) return `${userId}:${pageId}`
  if (pageId) return `author-page:${pageId}`
  const token = getAuthToken()
  if (!token) return ''
  let first = 2166136261
  let second = 5381
  for (let i = 0; i < token.length; i += 1) {
    first = Math.imul(first ^ token.charCodeAt(i), 16777619)
    second = Math.imul(second ^ token.charCodeAt(i), 33)
  }
  return `session:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}:${token.length}`
}

function getStoredProductViewOptions() {
  const accountId = getAuthorStoreAccountId()
  try {
    const saved = accountId ? JSON.parse(sessionStorage.getItem(`shadow_author_store_product_options_v1:${encodeURIComponent(accountId)}`) || 'null') : null
    return {
      type: ['All', 'Book', 'PDF', 'Active', 'Draft'].includes(saved?.type) ? saved.type : 'All',
      sort: ['newest', 'oldest', 'recently_updated', 'low_stock', 'sold_out'].includes(saved?.sort) ? saved.sort : 'newest',
      q: String(saved?.q || '').slice(0, 100),
    }
  } catch {
    return { type: 'All', sort: 'newest', q: '' }
  }
}

function getStoreLoadTenLabel() {
  return ({
    en: 'Load 10 More',
    km: 'បង្ហាញ ១០ ទៀត',
    zh: '再加载 10 件商品',
    ja: 'さらに10件表示',
    ko: '상품 10개 더 보기',
  })[getDisplayLanguageId()] || 'Load 10 More'
}

function getAuthorMenuProfile() {
  const authorPage = readStoredJson('shadow_author_page') || {}
  const readerUser = readStoredJson('shadow_reader_user') || {}

  const name =
    authorPage.page_name ||
    authorPage.name ||
    readerUser.name ||
    readerUser.username ||
    storeText('author')

  const avatarUrl =
    authorPage.avatar_url ||
    authorPage.logo_url ||
    readerUser.avatar_url ||
    ''

  return {
    name,
    avatarUrl,
    letter: String(name || 'A').slice(0, 1).toUpperCase(),
  }
}

function AuthorStoreMenuSheet({ open, onClose, onSwitchProfile, onFinance, onSettings }) {
  if (!open) return null

  const profile = getAuthorMenuProfile()

  return (
    <div className="fixed inset-0 z-[400] bg-black/25">
      <button
        type="button"
        aria-label={storeText('closeMenu')}
        onClick={onClose}
        className="absolute inset-0"
      />

      <aside className="relative h-full w-[82%] max-w-[340px] bg-[var(--shadow-bg-surface)] px-4 py-4 shadow-2xl">
        <div className="text-[14px] font-black text-[var(--shadow-text-primary)]">{storeText('authorMenu')}</div>

        <button
          type="button"
          onClick={onSwitchProfile}
          className="mt-6 flex w-full items-center gap-3 rounded-2xl text-left active:opacity-70"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--shadow-bg-soft)] text-[16px] font-black text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border-strong)]">
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt={profile.name} className="h-full w-full object-cover" />
            ) : (
              profile.letter
            )}
          </div>

          <div className="min-w-0">
            <div className="line-clamp-1 text-[14px] font-black text-[var(--shadow-text-primary)]">{profile.name}</div>
            <div className="mt-0.5 text-[11px] font-semibold text-[var(--shadow-text-tertiary)]">{storeText('switchProfile')}</div>
          </div>
        </button>

        <div className="mt-8 space-y-2">
          <button
            type="button"
            onClick={onFinance}
            className="flex h-12 w-full items-center gap-4 rounded-2xl px-1 text-left text-[14px] font-semibold text-[var(--shadow-text-primary)] active:bg-[var(--shadow-bg-soft)]"
          >
            <i className="fa-solid fa-wallet w-7 text-center text-[15px]" / >
            {storeText('finance')}
          </button>

          <button
            type="button"
            onClick={onSettings}
            className="flex h-12 w-full items-center gap-4 rounded-2xl px-1 text-left text-[14px] font-semibold text-[var(--shadow-text-primary)] active:bg-[var(--shadow-bg-soft)]"
          >
            <i className="fa-solid fa-gear w-7 text-center text-[15px]" / >
            {storeText('settings')}
          </button>
        </div>

        <div className="absolute bottom-8 left-0 right-0 text-center">
          <div className="text-[18px] font-black tracking-[-0.05em] text-[var(--shadow-text-primary)]">
            SHADOW <span className="text-[14px]">☠</span>
          </div>
        </div>
      </aside>
    </div>
  )
}

function DeliveryLogo({ type }) {
  const src = type === 'jnt' ? '/assets/Icons/J%26T.svg' : '/assets/Icons/VET.svg'
  const label = type === 'jnt' ? 'J&T' : 'VET'

  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-[var(--shadow-bg-surface)] shadow-sm ring-1 ring-[var(--shadow-border-strong)]">
      <img src={src} alt={label} className="h-10 w-10 object-contain" />
    </div>
  )
}

function StoreManagerHome({
  promotion,
  activeTab,
  setActiveTab,
  activeType,
  setActiveType,
  filteredProducts,
  products,
  recordQuery,
  setRecordQuery,
  recordFilter,
  setRecordFilter,
  recordSearch,
  productTotal,
  productHasNext,
  productLoadingMore,
  productRefreshing,
  onLoadMoreProducts,
  onLoadCategories,
  storeAccountId,
  categories,
  storeCategories,
  newCategory,
  setNewCategory,
  addCategory,
  categoryError,
  categorySaving,
  editingCategoryId,
  editingCategoryName,
  setEditingCategoryName,
  startEditCategory,
  cancelEditCategory,
  saveEditCategory,
  handleDeleteCategory,
  handleToggleHideCategory,
  moveCategory,
  saveCategoryOrder,
  onAddProduct,
  onEditProduct,
  onDeleteProduct,
  loading,
  localError,
  onRefreshOrders,
  orderSummary,
  orders,
  orderPage,
  setOrderPage,
  orderLoading,
  orderPagination,
  orderType,
  setOrderType,
  orderPrepareFilter,
  setOrderPrepareFilter,
  orderSearchDraft,
  setOrderSearchDraft,
  setOrderSearchQuery,
  onMarkOrderPreparing,
  orderActionLoadingId,
}) {
const navigate = useNavigate()
const [recordFilterOpen, setRecordFilterOpen] = useState(false)
const [orderFilterOpen, setOrderFilterOpen] = useState(false)
const [openCategoryMenuId, setOpenCategoryMenuId] = useState('')
const [searchParams] = useSearchParams()
const initialSettingsView = ['categories', 'delivery', 'sales-reports', 'telegram'].includes(searchParams.get('settings'))
  ? searchParams.get('settings')
  : 'home'
const [settingsView, setSettingsView] = useState(initialSettingsView)
  const [jtDeliveryFee, setJtDeliveryFee] = useState('2')
  const [vetDeliveryFee, setVetDeliveryFee] = useState('2')
  const [deliverySaving, setDeliverySaving] = useState(false)
  const [deliveryLoading, setDeliveryLoading] = useState(false)
  const [deliveryMessage, setDeliveryMessage] = useState('')
  const [telegramBotUsername, setTelegramBotUsername] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramChatTitle, setTelegramChatTitle] = useState('')
  const [telegramLinkedAt, setTelegramLinkedAt] = useState('')
  const [telegramConnecting, setTelegramConnecting] = useState(false)
  const [telegramUnlinking, setTelegramUnlinking] = useState(false)
  const [telegramLoading, setTelegramLoading] = useState(false)
  const [telegramMessage, setTelegramMessage] = useState('')
  const customCategoryCount = storeCategories.filter((category) => !category.isDefault).length
  const canCreateCustomCategory = customCategoryCount < 5
  useEffect(() => {
    if (activeTab !== 'Settings' || settingsView !== 'delivery') return undefined
    let cancelled = false
    const apply = (settings) => {
      if (cancelled || !Array.isArray(settings)) return
      const jnt = settings.find((item) => item.company_key === 'jnt')
      const vet = settings.find((item) => item.company_key === 'vet')
      setJtDeliveryFee(String(jnt?.fee_usd ?? 2))
      setVetDeliveryFee(String(vet?.fee_usd ?? 2))
    }
    const cached = storeAccountId
      ? readAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'delivery' })
      : null
    if (cached?.exists) apply(cached.data)
    if (cached?.fresh) return () => { cancelled = true }
    setDeliveryLoading(!cached?.exists)
    void (async () => {
      try {
        const result = storeAccountId
          ? await fetchAuthorStoreResource({ accountId: storeAccountId, resource: 'delivery', fetcher: fetchDeliverySettings })
          : { data: await fetchDeliverySettings() }
        if (!result.obsolete) apply(result.data)
      } catch {
      } finally {
        if (!cancelled) setDeliveryLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [activeTab, settingsView, storeAccountId])

  useEffect(() => {
    if (activeTab !== 'Settings' || settingsView !== 'telegram') return undefined
    let cancelled = false
    const apply = (settings) => {
      if (cancelled || !settings) return
      setTelegramBotUsername(settings.bot_username || '')
      setTelegramChatId(settings.chat_id || '')
      setTelegramChatTitle(settings.chat_title || '')
      setTelegramLinkedAt(settings.linked_at || '')
    }
    const cached = storeAccountId
      ? readAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'telegram' })
      : null
    if (cached?.exists) apply(cached.data)
    if (cached?.fresh) return () => { cancelled = true }
    setTelegramLoading(!cached?.exists)
    void (async () => {
      try {
        const result = storeAccountId
          ? await fetchAuthorStoreResource({ accountId: storeAccountId, resource: 'telegram', fetcher: fetchTelegramSettings })
          : { data: await fetchTelegramSettings() }
        if (!result.obsolete) apply(result.data)
      } catch {
      } finally {
        if (!cancelled) setTelegramLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [activeTab, settingsView, storeAccountId])

  const loadSalesReportSettingsCached = useCallback(async () => {
    if (!storeAccountId) return fetchSalesReportsSettings()
    const result = await fetchAuthorStoreResource({
      accountId: storeAccountId,
      resource: 'salesReports',
      fetcher: fetchSalesReportsSettings,
    })
    return result.data
  }, [storeAccountId])

  const connectSalesReportsCached = useCallback(async (...args) => {
    const result = await connectSalesReports(...args)
    if (storeAccountId) invalidateAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'salesReports' })
    return result
  }, [storeAccountId])

  const syncSalesReportsCached = useCallback(async (...args) => {
    const result = await syncSalesReports(...args)
    if (storeAccountId) invalidateAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'salesReports' })
    return result
  }, [storeAccountId])

  const disconnectSalesReportsCached = useCallback(async (...args) => {
    const result = await disconnectSalesReports(...args)
    if (storeAccountId) invalidateAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'salesReports' })
    return result
  }, [storeAccountId])

  const handleSaveDeliveryFees = async () => {
  try {
    setDeliverySaving(true)
    setDeliveryMessage('')

    const settings = await updateDeliverySettings([
      { company_key: 'jnt', fee_usd: Number(jtDeliveryFee || 0) },
      { company_key: 'vet', fee_usd: Number(vetDeliveryFee || 0) },
    ])

    const jnt = settings.find((item) => item.company_key === 'jnt')
    const vet = settings.find((item) => item.company_key === 'vet')

    setJtDeliveryFee(String(jnt?.fee_usd ?? jtDeliveryFee))
    setVetDeliveryFee(String(vet?.fee_usd ?? vetDeliveryFee))
    if (storeAccountId) writeAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'delivery', data: settings })
    setDeliveryMessage(storeText('deliveryFeesSaved'))
  } catch (error) {
    setDeliveryMessage(error.message || storeText('saveDeliveryFailed'))
  } finally {
    setDeliverySaving(false)
  }
}

  const handleCreateTelegramConnectLink = async () => {
  try {
    setTelegramConnecting(true)
    setTelegramMessage('')

    const data = await createTelegramConnectLink()
    const settings = data.telegram_settings || {}
    const connectUrl = data.telegram_connect?.connect_url || ''

    setTelegramBotUsername(settings.bot_username || telegramBotUsername)
    setTelegramChatId(settings.chat_id || telegramChatId)
    setTelegramChatTitle(settings.chat_title || telegramChatTitle)
    setTelegramLinkedAt(settings.linked_at || telegramLinkedAt)
    if (storeAccountId) invalidateAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'telegram' })

    if (connectUrl) {
      window.location.href = connectUrl
      return
    }

    setTelegramMessage(storeText('telegramLinkMissing'))
  } catch (error) {
    setTelegramMessage(error.message || storeText('openTelegramFailed'))
  } finally {
    setTelegramConnecting(false)
  }
}

  const handleUnlinkTelegramGroup = async () => {
  try {
    setTelegramUnlinking(true)
    setTelegramMessage('')

    const settings = await unlinkTelegramGroup()

    setTelegramBotUsername(settings.bot_username || telegramBotUsername)
    setTelegramChatId(settings.chat_id || '')
    setTelegramChatTitle(settings.chat_title || '')
    setTelegramLinkedAt(settings.linked_at || '')
    if (storeAccountId) writeAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'telegram', data: settings })
    setTelegramMessage(storeText('telegramUnlinked'))
  } catch (error) {
    setTelegramMessage(error.message || storeText('unlinkTelegramFailedUi'))
  } finally {
    setTelegramUnlinking(false)
  }
}

 const visibleRecords = filteredProducts

  return (
    <main className="mx-auto max-w-[980px] px-0 py-0 sm:px-4 sm:py-4">
      <section
        className="relative overflow-hidden rounded-none bg-[var(--shadow-bg-soft)] bg-cover bg-center bg-no-repeat px-4 pb-4 pt-[92px] shadow-none ring-0 sm:rounded-[28px] sm:px-5 sm:pb-5 sm:pt-[118px] sm:shadow-[0_24px_60px_rgba(124,91,255,0.16)] sm:ring-1 sm:ring-[var(--shadow-border)]"
        style={{
          backgroundImage: "url('/assets/Author%20Page/Store%20Manager.png')",
        }}
      >
        <div className="relative grid grid-cols-2 gap-3">
          <StatCard
            label={storeText('orders')}
            value={String(orderSummary.orders_count || 0)}
            icon="fa-bag-shopping"
          />
          <AuthorStoreAvailableWithdrawalCard StatCard={StatCard} formatMoney={formatMoney} />
        </div>
      </section>

<section className="mx-4 mt-3 overflow-visible rounded-[10px] bg-[var(--shadow-bg-surface)] px-4 py-3 shadow-[0_14px_38px_rgba(124,91,255,0.10)] ring-1 ring-[var(--shadow-border)] backdrop-blur sm:mx-0 sm:rounded-[10px]">
  <div className="flex items-center gap-3">
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#f3edff] text-[#7c5cff] shadow-[0_10px_24px_rgba(124,91,255,0.18)] ring-1 ring-[var(--shadow-border)]">
      <i className="fa-solid fa-tags text-[14px]" />
    </div>

    <div className="min-w-0 flex-1">
      <div className="text-[13px] font-black text-[var(--shadow-text-primary)]">{storeText('serviceFeePromotion')}</div>

      <div className="mt-1 flex items-center gap-2 text-[13px] font-normal">
        <span className="text-[#6f5cff]">
          {storeText('book')} {promotion?.book?.used || 0}/{promotion?.book?.limit || 50}
        </span>
        <span className="text-[var(--shadow-text-tertiary)]">•</span>
        <span className="text-[#d6a52a]">
          {storeText('pdf')} {promotion?.pdf?.used || 0}/{promotion?.pdf?.limit || 100}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="h-2 overflow-hidden rounded-full bg-[#ebe7ff]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#8b5cf6] to-[#a78bfa] transition-all duration-500"
            style={{
              width: `${Math.min(
                100,
                Math.max(
                  0,
                  (Number(promotion?.book?.used || 0) /
                    Math.max(1, Number(promotion?.book?.limit || 50))) *
                    100,
                ),
              )}%`,
            }}
          />
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-[#fff1c7]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#d6a52a] to-[#f1c75b] transition-all duration-500"
            style={{
              width: `${Math.min(
                100,
                Math.max(
                  0,
                  (Number(promotion?.pdf?.used || 0) /
                    Math.max(1, Number(promotion?.pdf?.limit || 100))) *
                    100,
                ),
              )}%`,
            }}
          />
        </div>
      </div>
    </div>

    <i className="fa-solid fa-chevron-right shrink-0 text-[13px] text-[var(--shadow-text-tertiary)]" />
  </div>
</section>

<section className="mx-4 mt-3 overflow-hidden rounded-full bg-[var(--shadow-bg-surface)] shadow-[0_14px_38px_rgba(124,91,255,0.10)] sm:mx-0">
  <div className="grid grid-cols-2 gap-0">
    {[{ id: 'Records', labelKey: 'records' }, { id: 'Orders', labelKey: 'orders' }].map((tab) => {
      const active = activeTab === tab.id

      return (
        <button
          key={tab.id}
          type="button"
          onClick={() => setActiveTab(tab.id)}
          className={`flex h-11 items-center justify-center gap-2 rounded-full text-[13px] font-normal transition active:scale-[0.98] ${
            active
              ? 'bg-gradient-to-r from-[#8b5cf6] to-[#a78bfa] text-white shadow-[0_12px_26px_rgba(124,91,255,0.32)]'
              : 'bg-transparent text-[var(--shadow-text-secondary)]'
          }`}
        >
          <i className={`fa-solid ${tab.id === 'Records' ? 'fa-list-alt' : 'fa-bag-shopping'} text-[13px]`} />
          {storeText(tab.labelKey)}
        </button>
      )
    })}
  </div>
</section>

      {localError ? (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 w-full rounded-[18px] bg-[#fff7ed] px-4 py-3 text-left text-[12px] font-bold text-[#9a3412]"
        >
          {localError}
        </button>
      ) : null}

      {activeTab === 'Records' ? (
  <section className="mx-4 mt-3 overflow-visible rounded-[10px] bg-[linear-gradient(135deg,#fbfaff_0%,#f3efff_55%,#ffffff_100%)] shadow-[0_16px_38px_rgba(124,91,255,0.10)] ring-1 ring-[var(--shadow-border)] sm:mx-0 sm:mt-4">
    <div className="border-b border-white/70 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-black text-[var(--shadow-text-primary)]">{storeText('bookRecords')}</h2>

          <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--shadow-text-secondary)]">{storeText('searchManageProducts')}</p>
        </div>

        <span className="shrink-0 rounded-[10px] bg-[var(--shadow-bg-surface)] px-3 py-1.5 text-[11px] font-black text-[#6f5cff] shadow-[0_8px_20px_rgba(124,91,255,0.10)] ring-1 ring-[var(--shadow-border)]">
          {storeText('productsCount', { count: productTotal })}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-[var(--shadow-text-tertiary)]" />

          <input
            type="search"
            value={recordQuery}
            onChange={(event) => setRecordQuery(event.target.value)}
            placeholder={storeText('searchProducts')}
            className="h-11 w-full rounded-[10px] border border-[#ddd6fe] bg-[var(--shadow-input-bg)] pl-9 pr-3 text-[13px] font-bold text-[var(--shadow-text-primary)] shadow-[0_8px_22px_rgba(124,91,255,0.07)] outline-none placeholder:text-[var(--shadow-text-tertiary)] focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/10"
          />
        </div>

        <div className="relative z-[130] shrink-0">
  <button
    type="button"
    onClick={() => setRecordFilterOpen((current) => !current)}
    className={`relative flex h-11 w-11 items-center justify-center rounded-[10px] bg-[var(--shadow-bg-surface)] shadow-[0_8px_22px_rgba(124,91,255,0.12)] ring-1 ring-[var(--shadow-border)] transition active:scale-[0.96] ${
      recordFilterOpen
        ? 'bg-[#f3edff] text-[#7c5cff]'
        : 'text-[#7c5cff]'
    }`}
    aria-label={storeText('filterProductRecords')}
    aria-expanded={recordFilterOpen}
  >
    <i className="fa-solid fa-sliders text-[14px]" />

    {recordFilter !== 'newest' ? (
      <span className="absolute right-[6px] top-[6px] h-2 w-2 rounded-full bg-[#8b5cf6] ring-2 ring-[var(--shadow-border)]" />
    ) : null}
  </button>

  {recordFilterOpen ? (
    <>
      <button
        type="button"
        aria-label={storeText('closeRecordFilter')}
        onClick={() => setRecordFilterOpen(false)}
        className="fixed inset-0 z-[129] cursor-default bg-transparent"
      />

      <div className="absolute right-0 top-[52px] z-[130] w-[190px] overflow-hidden rounded-[16px] bg-[var(--shadow-bg-surface)] p-2 shadow-[0_18px_45px_rgba(45,39,102,0.22)] ring-1 ring-[#e5ddff]">
        {[
          { value: 'newest', labelKey: 'newestFirst' },
          { value: 'recently_updated', labelKey: 'recentlyUpdated' },
          { value: 'low_stock', labelKey: 'lowStock' },
          { value: 'sold_out', labelKey: 'soldOut' },
          { value: 'oldest', labelKey: 'oldestFirst' },
        ].map((item) => {
          const active = recordFilter === item.value

          return (
            <button
              key={item.value}
              type="button"
              onClick={() => {
                setRecordFilter(item.value)
                setRecordFilterOpen(false)
              }}
              className={`flex h-10 w-full items-center justify-between rounded-[11px] px-3 text-left text-[12px] font-normal transition ${
                active
                  ? 'bg-[#f1edff] text-[#6f4cff]'
                  : 'text-[var(--shadow-text-secondary)] hover:bg-[var(--shadow-bg-hover)] active:bg-[var(--shadow-bg-hover)]'
              }`}
            >
              <span>{storeText(item.labelKey)}</span>

              {active ? (
                <i className="fa-solid fa-check text-[11px] text-[#7c5cff]" />
              ) : null}
            </button>
          )
        })}
      </div>
    </>
  ) : null}
</div>
      </div>

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {TYPE_FILTERS.map((type) => {
          const active = activeType === type

          return (
            <button
              key={type}
              type="button"
              onClick={() => setActiveType(type)}
              className={`flex h-8 min-w-[44px] shrink-0 items-center justify-center gap-1 rounded-full px-3 text-[11px] font-black transition active:scale-[0.97] ${
                active
                  ? 'bg-gradient-to-r from-[#8b5cf6] to-[#a78bfa] text-white shadow-[0_10px_24px_rgba(124,91,255,0.28)]'
                  : 'bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-tertiary)] shadow-[0_7px_18px_rgba(124,91,255,0.07)] ring-1 ring-[var(--shadow-border)]'
              }`}
            >
              <span>{storeValueLabel(type)}</span>

              {type === 'Active' ? (
                <span className="h-1.5 w-1.5 rounded-full bg-[#41c98e]" />
              ) : null}

              {type === 'Draft' ? (
                <span className="h-1.5 w-1.5 rounded-full bg-[#aaa8c8]" />
              ) : null}
            </button>
          )
        })}
      </div>
    </div>

          <div className="bg-[var(--shadow-bg-surface)] px-4 py-2">
  {loading && !visibleRecords.length ? (
  <div className="rounded-[18px] bg-[var(--shadow-bg-soft)] p-8 text-center text-[13px] font-bold text-[var(--shadow-text-tertiary)] ring-1 ring-[var(--shadow-border)]">{storeText('loadingProducts')}</div>
) : productTotal === 0 && activeType === 'All' && !recordSearch && recordFilter === 'newest' && !localError ? (
  <EmptyState onAddProduct={onAddProduct} />
) : visibleRecords.length ? (
  <div className="overflow-visible bg-[var(--shadow-bg-surface)]">
    {visibleRecords.map((product) => (
      <ProductRecordRow
        key={product.id}
        product={product}
        onEdit={onEditProduct}
        onDelete={onDeleteProduct}
      />
    ))}
    {productHasNext ? (
      <button
        type="button"
        onClick={onLoadMoreProducts}
        disabled={productLoadingMore || productRefreshing}
        className="mt-3 w-full rounded-xl bg-[var(--shadow-bg-soft)] px-4 py-3 text-[13px] font-bold text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)] disabled:opacity-50"
      >
        {productLoadingMore ? storeText('loadingProducts') : getStoreLoadTenLabel()}
      </button>
    ) : null}
  </div>
) : (
  <div className="rounded-[18px] bg-[var(--shadow-bg-surface)] px-4 py-10 text-center ring-1 ring-[var(--shadow-border)]">
    <i className="fa-solid fa-magnifying-glass text-[20px] text-[#a78bfa]" />

    <div className="mt-3 text-[14px] font-bold text-[var(--shadow-text-primary)]">{storeText('noMatchingProducts')}</div>

    <div className="mt-1 text-[12px] font-normal text-[var(--shadow-text-tertiary)]">{storeText('tryAnotherSearch')}</div>
  </div>
)}
</div>
        </section>
      ) : null}

{activeTab === 'Settings' ? (
  <section className="mt-4 space-y-3">
    {settingsView === 'home' ? (
  <div className="overflow-hidden rounded-[24px] bg-[var(--shadow-bg-surface)] shadow-sm ring-1 ring-[var(--shadow-border)]">
    <div className="px-4 pb-2 pt-4">
      <h2 className="text-[17px] font-black text-[var(--shadow-text-primary)]">{storeText('storeSettings')}</h2>
      <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">{storeText('storeSettingsHelp')}</p>
    </div>

    <button
      type="button"
      onClick={() => { setSettingsView('categories'); onLoadCategories() }}
      className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left active:bg-[var(--shadow-bg-soft)]"
    >
      <span className="min-w-0">
        <span className="block text-[14px] font-black text-[var(--shadow-text-primary)]">{storeText('categoryManagement')}</span>
        <span className="mt-0.5 block text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">{storeText('categoryManagementHelp')}</span>
      </span>
      <i className="fa-solid fa-chevron-right shrink-0 text-[12px] text-[var(--shadow-text-tertiary)]" />
    </button>

    <div className="mx-4 h-px bg-[var(--shadow-border)]" />

    <button
      type="button"
      onClick={() => setSettingsView('delivery')}
      className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left active:bg-[var(--shadow-bg-soft)]"
    >
      <span className="min-w-0">
        <span className="block text-[14px] font-black text-[var(--shadow-text-primary)]">{storeText('deliveryCompany')}</span>
        <span className="mt-0.5 block text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">
          {storeText('deliveryCompanyHelp')}
        </span>
      </span>
      <i className="fa-solid fa-chevron-right shrink-0 text-[12px] text-[var(--shadow-text-tertiary)]" />
    </button>

    <SalesReportsSettingsMenuItem
  onOpen={() => setSettingsView('sales-reports')}
/>

<div className="mx-4 h-px bg-[var(--shadow-border)]" />

<button
  type="button"
  onClick={() => setSettingsView('telegram')}
  className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left active:bg-[var(--shadow-bg-soft)]"
>
  <span className="min-w-0">
    <span className="block text-[14px] font-black text-[var(--shadow-text-primary)]">{storeText('telegramBot')}</span>
    <span className="mt-0.5 block text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">{storeText('telegramBotHelp')}</span>
  </span>
  <i className="fa-solid fa-chevron-right shrink-0 text-[12px] text-[var(--shadow-text-tertiary)]" />
</button>
  </div>
) : null}
    {settingsView === 'categories' ? (
      <>
        <button
          type="button"
          onClick={() => setSettingsView('home')}
          className="flex h-11 items-center gap-2 rounded-2xl bg-[var(--shadow-bg-surface)] px-4 text-[12px] font-black text-[var(--shadow-text-primary)] shadow-sm ring-1 ring-[var(--shadow-border)]"
        >
          <i className="fa-solid fa-chevron-left text-[12px]" / >
          {storeText('settings')}
        </button>

       <div className="rounded-[24px] bg-[var(--shadow-bg-surface)] p-4 shadow-sm ring-1 ring-[var(--shadow-border)]">
  <div className="flex items-start justify-between gap-3">
    <div>
      <h2 className="text-[16px] font-black text-[var(--shadow-text-primary)]">{storeText('createCustomCategory')}</h2>
      <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">{storeText('customCategoryHelp')}</p>
    </div>

    <span className="shrink-0 rounded-full bg-[var(--shadow-bg-soft)] px-3 py-1.5 text-[11px] font-black text-[var(--shadow-text-primary)]">
      {customCategoryCount}/5
    </span>
  </div>

  <div className="mt-3 flex gap-2">
    <TextInput
      value={newCategory}
      onChange={setNewCategory}
      placeholder={canCreateCustomCategory ? storeText('categoryName') : storeText('categoryLimitReached')}
    />
    <button
      type="button"
      onClick={addCategory}
      disabled={categorySaving || !canCreateCustomCategory}
      className="h-11 shrink-0 rounded-2xl bg-[var(--shadow-text-primary)] px-4 text-[12px] font-black text-[var(--shadow-bg-surface)] disabled:opacity-40"
    >{storeText('add')}</button>
  </div>

  {!canCreateCustomCategory ? (
    <p className="mt-2 text-[11px] font-bold text-[#e5484d]">{storeText('categoryLimitHelp')}</p>
  ) : null}
</div>
    <div className="rounded-[24px] bg-[var(--shadow-bg-surface)] p-4 shadow-sm ring-1 ring-[var(--shadow-border)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[16px] font-black text-[var(--shadow-text-primary)]">{storeText('categories')}</h2>
        <button
          type="button"
          onClick={saveCategoryOrder}
          disabled={categorySaving || !storeCategories.length}
          className="rounded-full bg-[var(--shadow-text-primary)] px-3 py-1.5 text-[11px] font-black text-[var(--shadow-bg-surface)] disabled:opacity-50"
         >
          {storeText('saveOrder')}
        </button>
      </div>

      {categoryError ? (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mb-3 w-full rounded-2xl bg-[#fff7ed] px-4 py-3 text-left text-[12px] font-bold text-[#9a3412]"
        >
          {categoryError}
        </button>
      ) : null}

      <div className="space-y-2">
        {withSystemCategories(storeCategories.length ? storeCategories : categories.map((name, index) => ({
  id: `local-${index}`,
  name,
}))).map((category, index, list) => {
  const editing = editingCategoryId === category.id
  const isSoldOutSystem = category.name === 'Sold out'
  const isLocalCategory = category.id.startsWith('local-')
  const menuOpen = openCategoryMenuId === category.id

          return (
            <div
              key={category.id}
              className="rounded-2xl bg-[var(--shadow-bg-soft)] px-3 py-3 ring-1 ring-[var(--shadow-border)]"
            >
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {editing ? (
                    <input
                      type="text"
                      value={editingCategoryName}
                      onChange={(event) => setEditingCategoryName(event.target.value)}
                      className="h-10 w-full rounded-xl border border-[var(--shadow-border)] bg-[var(--shadow-input-bg)] px-3 text-[13px] font-black text-[var(--shadow-text-primary)] outline-none focus:border-[var(--shadow-border-strong)]"
                    />
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
  <span className="truncate text-[13px] font-black text-[var(--shadow-text-primary)]">
    {storeValueLabel(category.name)}
  </span>
  {isSoldOutSystem ? (
    <span className="shrink-0 rounded-full bg-[var(--shadow-bg-soft)] px-2 py-0.5 text-[9px] font-black text-[var(--shadow-text-secondary)]" >
      {storeText('system')}
    </span>
  ) : null}
  {category.isHidden ? (
    <span className="shrink-0 rounded-full bg-[#fff1f1] px-2 py-0.5 text-[9px] font-black text-[#e5484d]" >
      {storeText('hidden')}
    </span>
  ) : null}
</div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => moveCategory(category.id, 'up')}
                  disabled={index === 0 || category.id.startsWith('local-')}
                  className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)] disabled:opacity-30"
                >
                  <i className="fa-solid fa-arrow-up text-[11px]" />
                </button>

                <button
                  type="button"
                  onClick={() => moveCategory(category.id, 'down')}
                  disabled={index === list.length - 1 || category.id.startsWith('local-')}
                  className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)] disabled:opacity-30"
                >
                  <i className="fa-solid fa-arrow-down text-[11px]" />
                </button>

                {editing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => saveEditCategory(category)}
                      disabled={categorySaving}
                      className="h-8 rounded-xl bg-[var(--shadow-text-primary)] px-3 text-[11px] font-black text-[var(--shadow-bg-surface)] disabled:opacity-60"
                    >{storeText('save')}</button>
                    <button
                      type="button"
                      onClick={cancelEditCategory}
                      className="h-8 rounded-xl bg-[var(--shadow-bg-surface)] px-3 text-[11px] font-black text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)]"
                     >
                      {storeText('cancel')}
                    </button>
                  </>
                ) : (
                  <div className="relative">
  <button
    type="button"
    onClick={() => setOpenCategoryMenuId(menuOpen ? '' : category.id)}
    className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)] active:scale-95"
  >
    <i className="fa-solid fa-ellipsis text-[12px]" />
  </button>

  {menuOpen ? (
    <div className="absolute right-0 top-9 z-30 w-32 overflow-hidden rounded-2xl bg-[var(--shadow-bg-surface)] py-1 shadow-xl ring-1 ring-[var(--shadow-border-strong)]">
      <button
  type="button"
  onClick={() => {
    setOpenCategoryMenuId('')
    handleToggleHideCategory(category)
  }}
  disabled={isLocalCategory}
  className="block w-full px-3 py-2 text-left text-[12px] font-black text-[var(--shadow-text-primary)] hover:bg-[var(--shadow-bg-soft)] disabled:opacity-40"
>
  {category.isHidden ? storeText('show') : storeText('hide')}
</button>

      {!category.isDefault ? (
        <button
          type="button"
          onClick={() => {
            setOpenCategoryMenuId('')
            startEditCategory(category)
          }}
          disabled={isLocalCategory}
          className="block w-full px-3 py-2 text-left text-[12px] font-black text-[var(--shadow-text-primary)] hover:bg-[var(--shadow-bg-soft)] disabled:opacity-40"
         >
          {storeText('edit')}
        </button>
      ) : null}

      {!category.isDefault ? (
  <button
    type="button"
    onClick={() => {
      setOpenCategoryMenuId('')
      handleDeleteCategory(category)
    }}
    disabled={isLocalCategory}
    className="block w-full px-3 py-2 text-left text-[12px] font-black text-[#e5484d] hover:bg-[#fff1f1] disabled:opacity-40"
   >
    {storeText('delete')}
  </button>
) : null}
    </div>
  ) : null}
</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
       </div>
      </>
    ) : null}

  {settingsView === 'delivery' ? (
  <div className="fixed inset-0 z-[999] bg-[var(--shadow-bg-soft)]">
    <header className="sticky top-0 z-40 border-b border-[var(--shadow-border)] bg-[var(--shadow-bg-surface)] backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-4">
        <button
          type="button"
          onClick={() => setSettingsView('home')}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f3f0f8] text-[var(--shadow-text-primary)] active:scale-95"
        >
          <i className="fa-solid fa-chevron-left text-[14px]" />
        </button>

        <div className="min-w-0">
          <h1 className="text-[18px] font-black leading-5 text-[var(--shadow-text-primary)]">{storeText('deliveryCompany')}</h1>
          <p className="mt-0.5 text-[11px] font-semibold text-[var(--shadow-text-tertiary)]">{storeText('setDeliveryFees')}</p>
        </div>
      </div>
    </header>

    <main className="h-[calc(100vh-56px)] overflow-y-auto px-4 pb-28 pt-4">
      <section className="overflow-hidden rounded-[26px] bg-[var(--shadow-bg-surface)] shadow-sm ring-1 ring-[var(--shadow-border)]">
        <div className="px-4 pb-2 pt-4">
          <h2 className="text-[16px] font-black text-[var(--shadow-text-primary)]">{storeText('deliveryFees')}</h2>
          <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">{storeText('deliveryFeesHelp')}</p>
        </div>

        <div className="px-4 py-4">
          <div className="flex gap-3">
            <DeliveryLogo type="jnt" />

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-black text-[var(--shadow-text-primary)]">J&T</h3>
                  <p className="mt-0.5 text-[12px] font-semibold text-[var(--shadow-text-tertiary)]">{storeText('jntHelp')}</p>
                </div>

                <span className="shrink-0 rounded-full bg-[#fff4cc] px-3 py-1 text-[11px] font-black text-[var(--shadow-text-primary)]">
                  ${Number(jtDeliveryFee || 0).toFixed(2)}
                </span>
              </div>

              <div className="mt-3">
                <FieldLabel>{storeText('deliveryFee')}</FieldLabel>
                <TextInput value={jtDeliveryFee} onChange={setJtDeliveryFee} placeholder="2.00" type="number" />
              </div>
            </div>
          </div>
        </div>

        <div className="mx-4 h-px bg-[var(--shadow-border)]" />

        <div className="px-4 py-4">
          <div className="flex gap-3">
            <DeliveryLogo type="vet" />

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-black text-[var(--shadow-text-primary)]">VET</h3>
                  <p className="mt-0.5 text-[12px] font-semibold text-[var(--shadow-text-tertiary)]">{storeText('vetHelp')}</p>
                </div>

                <span className="shrink-0 rounded-full bg-[#fff4cc] px-3 py-1 text-[11px] font-black text-[var(--shadow-text-primary)]">
                  ${Number(vetDeliveryFee || 0).toFixed(2)}
                </span>
              </div>

              <div className="mt-3">
                <FieldLabel>{storeText('deliveryFee')}</FieldLabel>
                <TextInput value={vetDeliveryFee} onChange={setVetDeliveryFee} placeholder="2.00" type="number" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {deliveryMessage ? (
        <button
          type="button"
          onClick={() => setDeliveryMessage('')}
          className="mt-3 w-full rounded-2xl bg-[var(--shadow-bg-surface)] px-4 py-3 text-left text-[12px] font-bold text-[var(--shadow-text-secondary)] shadow-sm ring-1 ring-[var(--shadow-border)]"
        >
          {deliveryMessage}
        </button>
      ) : null}
    </main>

    <div className="fixed inset-x-0 bottom-0 z-[1000] border-t border-[var(--shadow-border)] bg-[var(--shadow-bg-surface)] p-4 backdrop-blur">
      <button
        type="button"
        onClick={handleSaveDeliveryFees}
        disabled={deliverySaving}
        className="h-12 w-full rounded-2xl bg-[var(--shadow-text-primary)] text-[13px] font-black text-[var(--shadow-bg-surface)] shadow-lg active:scale-[0.98] disabled:opacity-60"
      >
        {deliverySaving ? storeText('saving') : storeText('saveDeliveryFees')}
      </button>
    </div>
  </div>
) : null}

    <SalesReportsSettingsPage
  open={settingsView === 'sales-reports'}
  onBack={() => setSettingsView('home')}
  fetchSettings={loadSalesReportSettingsCached}
  connectSheet={connectSalesReportsCached}
  syncSheet={syncSalesReportsCached}
  disconnectSheet={disconnectSalesReportsCached}
/>

  {settingsView === 'telegram' ? (
  <>
    <button
      type="button"
      onClick={() => setSettingsView('home')}
      className="flex h-11 items-center gap-2 rounded-2xl bg-[var(--shadow-bg-surface)] px-4 text-[12px] font-black text-[var(--shadow-text-primary)] shadow-sm ring-1 ring-[var(--shadow-border)]"
    >
      <i className="fa-solid fa-chevron-left text-[12px]" />{storeText('settings')}</button>

    <div className="overflow-hidden rounded-[24px] bg-[var(--shadow-bg-surface)] shadow-sm ring-1 ring-[var(--shadow-border)]">
      <div className="bg-gradient-to-br from-[#dff6ff] via-[#eefaff] to-[var(--shadow-bg-surface)] px-4 py-5 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--shadow-bg-surface)] text-[#229ed9] shadow-sm ring-1 ring-[var(--shadow-border)]">
          <i className="fa-brands fa-telegram text-[30px]" />
        </div>
        <h2 className="mt-3 text-[17px] font-black text-[var(--shadow-text-primary)]">{storeText('receiveTelegram')}</h2>
        <p className="mx-auto mt-1 max-w-[380px] text-[12px] font-semibold leading-5 text-[var(--shadow-text-secondary)]" >
          {storeText('receiveTelegramHelp')}
        </p>
      </div>

      <div className="space-y-4 p-4">
        {telegramMessage ? (
          <button
            type="button"
            onClick={() => setTelegramMessage('')}
            className="w-full rounded-2xl bg-[var(--shadow-bg-soft)] px-4 py-3 text-left text-[12px] font-bold text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)]"
          >
            {telegramMessage}
          </button>
        ) : null}

        {telegramChatId ? (
          <div className="rounded-[24px] bg-[var(--shadow-bg-surface)] p-4 shadow-sm ring-1 ring-[var(--shadow-border)]">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#e9f7ff] text-[#229ed9] ring-1 ring-[#229ed9]/20">
                <i className="fa-brands fa-telegram text-[22px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-black uppercase tracking-[0.08em] text-[var(--shadow-text-tertiary)]">{storeText('linkedGroup')}</div>
                <div className="mt-1 truncate text-[16px] font-black text-[var(--shadow-text-primary)]">{telegramChatTitle || 'Telegram group'}</div>
                <div className="mt-1 text-[12px] font-bold text-[var(--shadow-text-secondary)]">{storeText('groupId', { id: telegramChatId })}</div>
                {telegramLinkedAt ? <div className="mt-1 text-[11px] font-semibold text-[var(--shadow-text-tertiary)]">{storeText('linkedAt', { date: new Date(telegramLinkedAt).toLocaleString(getDisplayLanguageId()) })}</div> : null}
              </div>
            </div>

            <div className="mt-4 rounded-2xl bg-[var(--shadow-bg-soft)] px-4 py-3 text-[12px] font-semibold leading-5 text-[var(--shadow-text-secondary)]">{storeText('oneTelegramGroup')}</div>

            <button
              type="button"
              onClick={handleUnlinkTelegramGroup}
              disabled={telegramUnlinking || telegramLoading}
              className="mt-4 h-12 w-full rounded-full bg-[#fff1f2] text-[13px] font-black text-[#b91c1c] ring-1 ring-[#fecdd3] active:scale-[0.98] disabled:opacity-60"
            >
              {telegramUnlinking ? storeText('unlinking') : storeText('unlinkGroup')}
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-dashed border-[var(--shadow-border-strong)] bg-[var(--shadow-bg-surface)] p-4">
              <div className="text-[12px] font-black text-[var(--shadow-text-primary)]">{storeText('howToConnect')}</div>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-[12px] font-semibold leading-5 text-[var(--shadow-text-secondary)]">
                <li>{storeText('telegramStep1')}</li>
                <li>{storeText('telegramStep2')}</li>
                <li>{storeText('telegramStep3', { bot: telegramBotUsername || 'ShadowAuthorStoreNotifyBot' })}</li>
                <li>{storeText('telegramStep4')}</li>
              </ol>
            </div>

            <button
              type="button"
              onClick={handleCreateTelegramConnectLink}
              disabled={telegramConnecting || telegramLoading}
              className="h-12 w-full rounded-full bg-[var(--shadow-text-primary)] text-[13px] font-black text-[var(--shadow-bg-surface)] shadow-sm active:scale-[0.98] disabled:bg-[#aeb6c4]"
            >
              {telegramConnecting ? storeText('openingTelegram') : telegramLoading ? storeText('loading') : storeText('connectTelegramGroup')}
            </button>
          </>
        )}
      </div>
    </div>
  </>
) : null}
  </section>
) : null}

     {activeTab === 'Orders' ? (
  <section className="mt-4 space-y-3">
    <div className="mx-4 overflow-visible rounded-[10px] bg-[linear-gradient(135deg,#fbfaff_0%,#f3efff_55%,#ffffff_100%)] px-4 py-4 shadow-[0_16px_38px_rgba(124,91,255,0.10)] ring-1 ring-[var(--shadow-border)] sm:mx-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-black text-[var(--shadow-text-primary)]">{storeText('orderHistory')}</h2>
          <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--shadow-text-secondary)]">{storeText('orderHistoryHelp')}</p>
        </div>

        
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          setOrderPage(1)
          setOrderSearchQuery(orderSearchDraft.trim())
        }}
        className="mt-4 flex items-center gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-[var(--shadow-text-tertiary)]" />
          <input
            type="search"
            value={orderSearchDraft}
            onChange={(event) => setOrderSearchDraft(event.target.value)}
            placeholder={storeText('searchOrderPlaceholder')}
            className="h-11 w-full rounded-[10px] border border-[#ddd6fe] bg-[var(--shadow-input-bg)] pl-9 pr-3 text-[13px] font-bold text-[var(--shadow-text-primary)] shadow-[0_8px_22px_rgba(124,91,255,0.07)] outline-none placeholder:text-[var(--shadow-text-tertiary)] focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#8b5cf6]/10"
          />
        </div>

        <div className="relative z-[120] shrink-0">
          <button
            type="button"
            onClick={() => setOrderFilterOpen((current) => !current)}
            className={`relative flex h-11 w-11 items-center justify-center rounded-[10px] bg-[var(--shadow-bg-surface)] shadow-[0_8px_22px_rgba(124,91,255,0.12)] ring-1 ring-[var(--shadow-border)] transition active:scale-[0.96] ${
              orderFilterOpen ? 'bg-[#f3edff] text-[#7c5cff]' : 'text-[var(--shadow-text-tertiary)]'
            }`}
            aria-label={storeText('filterOrders')}
            aria-expanded={orderFilterOpen}
          >
            <i className="fa-solid fa-sliders text-[14px]" />

            {orderPrepareFilter !== 'all' ? (
              <span className="absolute right-[6px] top-[6px] h-2 w-2 rounded-full bg-[#8b5cf6] ring-2 ring-[var(--shadow-border)]" />
            ) : null}
          </button>

          {orderFilterOpen ? (
            <>
              <button
                type="button"
                aria-label={storeText('closeOrderFilter')}
                onClick={() => setOrderFilterOpen(false)}
                className="fixed inset-0 z-[119] cursor-default bg-transparent"
              />

              <div className="absolute right-0 top-[52px] z-[120] w-[176px] overflow-hidden rounded-[16px] bg-[var(--shadow-bg-surface)] p-2 shadow-[0_18px_45px_rgba(45,39,102,0.22)] ring-1 ring-[#e5ddff]">
                {[
                  { value: 'all', labelKey: 'all' },
                  { value: 'to_prepare', labelKey: 'toPrepare' },
                  { value: 'preparing', labelKey: 'preparingFilter' },
                ].map((item) => {
                  const active = orderPrepareFilter === item.value

                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => {
                        setOrderPrepareFilter(item.value)
                        setOrderPage(1)
                        setOrderFilterOpen(false)
                      }}
                      className={`flex h-10 w-full items-center justify-between rounded-[11px] px-3 text-left text-[12px] font-black transition ${
                        active
                          ? 'bg-[#f1edff] text-[#6f4cff]'
                          : 'text-[var(--shadow-text-secondary)] hover:bg-[var(--shadow-bg-hover)] active:bg-[var(--shadow-bg-hover)]'
                      }`}
                    >
                      <span>{storeText(item.labelKey)}</span>

                      {active ? (
                        <i className="fa-solid fa-check text-[11px] text-[#7c5cff]" />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}
        </div>
        
      </form>

      <div className="mt-3 flex gap-1.5">
  {[
    { value: 'all', labelKey: 'all' },
    { value: 'book', labelKey: 'book' },
    { value: 'pdf', labelKey: 'pdf' },
  ].map((item) => {
    const active = orderType === item.value

    return (
      <button
        key={item.value}
        type="button"
        onClick={() => {
          setOrderType(item.value)
          setOrderPage(1)
        }}
        className={`flex h-8 min-w-[58px] flex-1 items-center justify-center rounded-full px-3 text-[11px] font-black transition active:scale-[0.97] ${
          active
            ? 'bg-gradient-to-r from-[#8b5cf6] to-[#a78bfa] text-white shadow-[0_8px_20px_rgba(124,91,255,0.24)]'
            : 'bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-tertiary)] shadow-[0_7px_18px_rgba(124,91,255,0.07)] ring-1 ring-[var(--shadow-border)]'
        }`}
      >
        {item.labelKey ? storeText(item.labelKey) : item.label}
      </button>
    )
  })}
</div>
    </div>

    {orderLoading ? (
      <div className="rounded-[24px] bg-[var(--shadow-bg-surface)] p-8 text-center text-[13px] font-bold text-[var(--shadow-text-tertiary)] shadow-sm ring-1 ring-[var(--shadow-border)]">{storeText('loadingOrders')}</div>
    ) : orders.length ? (
      <>
        <div className="space-y-2">
          {orders.map((order) => (
            <OrderHistoryRow
              key={order.id}
              order={order}
              onMarkPreparing={onMarkOrderPreparing}
              preparingLoading={orderActionLoadingId === order.id}
            />
          ))}
        </div>

        <div className="flex items-center justify-between rounded-[20px] bg-[var(--shadow-bg-surface)] px-4 py-3 shadow-sm ring-1 ring-[var(--shadow-border)]">
          <button
            type="button"
            onClick={() => setOrderPage((page) => Math.max(1, page - 1))}
            disabled={orderPage <= 1}
            className="rounded-full bg-[var(--shadow-bg-soft)] px-4 py-2 text-[12px] font-black text-[var(--shadow-text-primary)] disabled:opacity-40"
          >{storeText('previous')}</button>

          <div className="text-[12px] font-bold text-[var(--shadow-text-secondary)]">
            {storeText('pageOf', { page: orderPage, total: Math.max(Number(orderPagination.total_pages || 1), 1) })}
          </div>

          <button
            type="button"
            onClick={() => setOrderPage((page) => page + 1)}
            disabled={orderPage >= Number(orderPagination.total_pages || 1)}
            className="rounded-full bg-[var(--shadow-bg-soft)] px-4 py-2 text-[12px] font-black text-[var(--shadow-text-primary)] disabled:opacity-40"
          >{storeText('next')}</button>
        </div>
      </>
    ) : (
      <div className="rounded-[22px] bg-gradient-to-br from-[#f8f5ff] via-[var(--shadow-bg-surface)] to-[#fff8e8] px-5 py-8 text-center">
  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#f1ebff] text-[#7c5cff] shadow-[0_10px_26px_rgba(124,91,255,0.16)] ring-1 ring-[var(--shadow-border)]">
    <i className="fa-solid fa-receipt text-[22px]" />
  </div>

  <h3 className="mt-4 text-[17px] font-bold leading-6 text-[var(--shadow-text-primary)]">{storeText('noOrders')}</h3>

  <p className="mx-auto mt-2 max-w-[280px] text-[12px] font-normal leading-5 text-[var(--shadow-text-secondary)]">{storeText('noOrdersHelp')}</p>

  <div className="mt-4 flex items-center justify-center gap-2">
    {[{ value: 'Book', key: 'book' }, { value: 'PDF', key: 'pdf' }, { value: 'Preparing', key: 'preparingFilter' }].map((item) => (
      <span
        key={item.value}
        className="rounded-full bg-[var(--shadow-bg-surface)] px-3 py-1 text-[10px] font-normal text-[var(--shadow-text-secondary)] shadow-sm ring-1 ring-[var(--shadow-border)]"
      >
        {storeText(item.key)}
      </span>
    ))}
  </div>
</div>
    )}
  </section>
) : null}
    </main>
  )
}

function GallerySlot({ image, index, onChoose, onRemove, onDrop }) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-[var(--shadow-border)] bg-[var(--shadow-bg-soft)]">
      <button
        type="button"
        onClick={onChoose}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          onDrop?.(event.dataTransfer.files?.[0])
        }}
        className="relative block aspect-[3/4] w-full cursor-pointer bg-[var(--shadow-bg-soft)]"
      >
        {image?.url ? (
          <img src={image.url} alt={storeText('galleryImageAlt', { number: index + 1 })} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center text-[var(--shadow-text-tertiary)]">
            <i className="fa-regular fa-image mb-2 text-[24px]" />
            <span className="text-[12px] font-black">{storeText('imageNumber', { number: index + 1 })}</span>
            <span className="mt-2 text-[10px] font-bold">{storeText('choose')}</span>
          </div>
        )}
      </button>

      {image?.url ? (
        <div className="p-2">
          <button
            type="button"
            onClick={onRemove}
            className="h-8 w-full rounded-xl bg-[#fff1f1] text-[11px] font-black text-[#e5484d] active:scale-[0.98]"
          >
            {storeText('clear')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function AddProductPage({ categories, productToEdit = null, onBack, onSave, onNotify }) {
  const fileInputRef = useRef(null)
  const galleryInputRefs = useRef([])
  const pdfInputRef = useRef(null)
  const [type, setType] = useState(productToEdit?.type || 'Book')
  const [title, setTitle] = useState(productToEdit?.title || '')
  const [category, setCategory] = useState(productToEdit?.category || '')
  const [authorName, setAuthorName] = useState(productToEdit?.authorName || '')
  const [publisher, setPublisher] = useState(productToEdit?.publisher || '')
  const [novelType, setNovelType] = useState(productToEdit?.novelType || '')
  const [coverType, setCoverType] = useState(productToEdit?.coverType || '')
  const [sortOrder, setSortOrder] = useState(String(productToEdit?.sortOrder ?? '0'))
  const [bestSeller, setBestSeller] = useState(Boolean(productToEdit?.bestSeller))
  const [discount, setDiscount] = useState(Boolean(productToEdit?.discount))
  const [description, setDescription] = useState(productToEdit?.description || '')
  const [originalPrice, setOriginalPrice] = useState(productToEdit?.originalPrice || '')
  const [salePrice, setSalePrice] = useState(productToEdit?.salePrice || '')
  const [active, setActive] = useState(productToEdit ? productToEdit.status === 'Active' : true)
  const [coverFile, setCoverFile] = useState(null)
  const [coverPreview, setCoverPreview] = useState(
  () => safeCoverPreviewUrl(productToEdit?.coverUrl || '')
)
  const [galleryImages, setGalleryImages] = useState(() => {
  const savedImages = Array.isArray(productToEdit?.galleryImages)
    ? productToEdit.galleryImages.slice(0, 5).map((image) => ({
        url: image.url || '',
        name: image.name || '',
        file: null,
        local: false,
      }))
    : []

  return [
    ...savedImages,
    ...Array.from({ length: Math.max(0, 5 - savedImages.length) }, () => null),
  ]
})
  const [stock, setStock] = useState(productToEdit?.stock || '')
  const [paperType, setPaperType] = useState(productToEdit?.paperType || '')
  const [condition, setCondition] = useState(productToEdit?.condition || 'New')
  const [qualityPercent, setQualityPercent] = useState(productToEdit?.qualityPercent || '')
  const [deliveryNote, setDeliveryNote] = useState(productToEdit?.deliveryNote || '')
  const [genre, setGenre] = useState(productToEdit?.genre || '')
  const [preOrder, setPreOrder] = useState(Boolean(productToEdit?.preOrder))
  const [pdfFileName, setPdfFileName] = useState(productToEdit?.pdfFileName || '')
  const [pdfFile, setPdfFile] = useState(null)
  const [pdfFileUrl, setPdfFileUrl] = useState(productToEdit?.pdfFileUrl || '')
  const [pageCount, setPageCount] = useState(productToEdit?.pageCount || '')
  const [accessRule, setAccessRule] = useState(productToEdit?.accessRule || 'Read online only')
  const [saving, setSaving] = useState(false)
  const [pdfUploadProgress, setPdfUploadProgress] = useState({
    stage: 'idle',
    percent: 0,
    uploadId: 0,
    fileName: '',
  })
  const [uploadedPdf, setUploadedPdf] = useState(null)
  const [pdfUploadError, setPdfUploadError] = useState('')
  const localCoverPreviewRef = useRef('')
  const localGalleryPreviewsRef = useRef(new Set())
  const uploadedPdfRef = useRef(null)
  const imageQueueRef = useRef(null)
  const imageQueueInitRef = useRef(null)
  const imageTaskIdsRef = useRef({})
  const [imageTasks, setImageTasks] = useState({})
  const [imageQueueMessage, setImageQueueMessage] = useState('')
  const imageUploadCacheRef = useRef(new WeakMap())
  const uploadSequenceRef = useRef(0)
  const pdfFormMountedRef = useRef(true)
  const pdfProductSavingRef = useRef(false)
  const pdfUploading = ['uploading', 'processing', 'saving', 'verifying'].includes(pdfUploadProgress.stage)
  const needsPdfUpload = type === 'PDF' && Boolean(pdfFile)
  const pdfReady = Boolean(uploadedPdf?.storage_key) || Boolean(!pdfFile && productToEdit?.id && (pdfFileName || pdfFileUrl))

  useEffect(() => {
    pdfFormMountedRef.current = true
    return () => {
      if (localCoverPreviewRef.current) URL.revokeObjectURL(localCoverPreviewRef.current)
      for (const url of localGalleryPreviewsRef.current) URL.revokeObjectURL(url)
      localGalleryPreviewsRef.current.clear()
      pdfFormMountedRef.current = false
      if (!pdfProductSavingRef.current && uploadedPdfRef.current) {
        void discardTemporaryAuthorPdf(uploadedPdfRef.current).catch(console.error)
      }
    }
  }, [])

  const reflectImageTask = (task) => {
    const slot = String(task?.context?.slot || '')
    if (!slot || imageTaskIdsRef.current[slot] !== task.id) return
    setImageTasks((current) => ({ ...current, [slot]: task }))
    const uploaded = task.status === 'uploaded' && /^https?:\/\//i.test(String(task.result?.imageUrl || ''))
    if (!uploaded) return
    const url = task.result.imageUrl
    if (slot === 'cover') {
      if (localCoverPreviewRef.current) URL.revokeObjectURL(localCoverPreviewRef.current)
      localCoverPreviewRef.current = ''
      setCoverFile(null)
      setCoverPreview(url)
    } else if (/^gallery:[0-4]$/.test(slot)) {
      const index = Number(slot.slice(8))
      setGalleryImages((current) => {
        const next = [...current]
        const image = next[index]
        if (!image || image.uploadTaskId !== task.id) return current
        if (image.local && String(image.url || '').startsWith('blob:')) {
          URL.revokeObjectURL(image.url)
          localGalleryPreviewsRef.current.delete(image.url)
        }
        next[index] = { ...image, url, file: null, local: false }
        return next
      })
    }
  }

  const ensureImageQueue = async () => {
    if (imageQueueRef.current) return imageQueueRef.current
    if (imageQueueInitRef.current) return imageQueueInitRef.current
    const promise = (async () => {
      const queue = createStoreImageUploadQueue({
        productKey: productToEdit?.id || 'new',
        onChange: ({ task }) => {
          if (pdfFormMountedRef.current && task?.context?.slot) reflectImageTask(task)
        },
      })
      imageQueueRef.current = queue
      const tasks = (await queue.list()).filter((task) =>
        task.context?.slot === 'cover' || /^gallery:[0-4]$/.test(String(task.context?.slot || ''))
      )
      const latest = new Map()
      tasks.sort((a, b) => a.createdAt - b.createdAt).forEach((task) => latest.set(task.context.slot, task))
      for (const [slot, task] of latest) {
        if (!pdfFormMountedRef.current) break
        if (imageTaskIdsRef.current[slot]) continue
        imageTaskIdsRef.current[slot] = task.id
        setImageTasks((current) => ({ ...current, [slot]: task }))
        const uploaded = task.status === 'uploaded' && /^https?:\/\//i.test(String(task.result?.imageUrl || ''))
        const saved = uploaded ? null : await queue.file(task.id)
        const preview = uploaded ? task.result.imageUrl : saved ? URL.createObjectURL(saved) : ''
        if (slot === 'cover' && preview) {
          if (!uploaded) localCoverPreviewRef.current = preview
          setCoverFile(null)
          setCoverPreview(preview)
        } else if (/^gallery:[0-4]$/.test(slot) && preview) {
          const index = Number(slot.slice(8))
          if (!uploaded) localGalleryPreviewsRef.current.add(preview)
          setGalleryImages((current) => {
            const next = [...current]
            next[index] = {
              url: preview,
              name: String(saved?.name || `Gallery image ${index + 1}`),
              file: null,
              local: !uploaded,
              uploadTaskId: task.id,
            }
            return next
          })
        }
      }
      if (pdfFormMountedRef.current) queue.start()
      return queue
    })()
    imageQueueInitRef.current = promise
    try {
      return await promise
    } catch (error) {
      imageQueueRef.current?.stop()
      imageQueueRef.current = null
      setImageQueueMessage(String(error.message || 'Local image storage unavailable'))
      throw error
    } finally {
      imageQueueInitRef.current = null
    }
  }

  useEffect(() => {
    void ensureImageQueue().catch(() => {})
    return () => {
      imageQueueRef.current?.stop()
      imageQueueRef.current = null
    }
  }, [])

  const removeQueuedImage = async (slot) => {
    const id = imageTaskIdsRef.current[slot]
    if (!id) return
    const queue = await ensureImageQueue()
    let task = await queue.get(id)
    if (task?.status === 'uploading') {
      queue.stop()
      for (let attempt = 0; attempt < 35; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        task = await queue.get(id)
        if (!task || task.status !== 'uploading') break
      }
    }
    const removed = !task || await queue.remove(id)
    queue.start()
    if (!removed) throw new Error('Image upload is still stopping. Please retry.')
    delete imageTaskIdsRef.current[slot]
    setImageTasks((current) => {
      const next = { ...current }
      delete next[slot]
      return next
    })
  }

  const selectQueuedImage = async (slot, file) => {
    if (!file || saving) return
    if (!file.type.startsWith('image/')) {
      onNotify?.(storeText(slot === 'cover' ? 'validCoverImage' : 'validGalleryImage'), 'error')
      return
    }
    if (!file.size || file.size > STORE_IMAGE_MAX_BYTES) {
      onNotify?.(storeText('imageTooLarge'), 'error')
      return
    }
    try {
      setImageQueueMessage('')
      await removeQueuedImage(slot)
      const queue = await ensureImageQueue()
      const task = await queue.enqueueImage(file, slot)
      imageTaskIdsRef.current[slot] = task.id
      setImageTasks((current) => ({ ...current, [slot]: task }))
      const preview = URL.createObjectURL(file)
      if (slot === 'cover') {
        if (localCoverPreviewRef.current) URL.revokeObjectURL(localCoverPreviewRef.current)
        localCoverPreviewRef.current = preview
        setCoverFile(null)
        setCoverPreview(preview)
      } else {
        const index = Number(slot.slice(8))
        setGalleryImages((current) => {
          const next = [...current]
          if (next[index]?.local && next[index]?.url) {
            URL.revokeObjectURL(next[index].url)
            localGalleryPreviewsRef.current.delete(next[index].url)
          }
          next[index] = { url: preview, name: file.name, file: null, local: true, uploadTaskId: task.id }
          return next
        })
        localGalleryPreviewsRef.current.add(preview)
      }
      queue.start()
      const latest = await queue.get(task.id)
      if (latest) reflectImageTask(latest)
    } catch (error) {
      const message = error.message || 'Could not save image to local queue'
      setImageQueueMessage(message)
      onNotify?.(message, 'error')
    }
  }

  const retryQueuedImage = async (slot) => {
    const id = imageTaskIdsRef.current[slot]
    if (!id) return
    try {
      const queue = await ensureImageQueue()
      const task = await queue.retry(id)
      if (task) reflectImageTask(task)
      queue.start()
    } catch (error) {
      onNotify?.(error.message || 'Cannot retry image upload', 'error')
    }
  }

  const waitForQueuedImage = async (slot) => {
    const id = imageTaskIdsRef.current[slot]
    if (!id) return ''
    const queue = await ensureImageQueue()
    const deadline = Date.now() + 180000
    queue.start()
    while (Date.now() < deadline) {
      const task = await queue.get(id)
      if (!task) throw new Error('Local image was removed. Choose the image again.')
      if (task.status === 'uploaded') {
        const url = String(task.result?.imageUrl || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('Uploaded image URL is missing')
        return url
      }
      if (task.status === 'failed') throw new Error(task.lastError || 'Image upload failed. Retry the image.')
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('Image is still uploading. Please try Save again when it completes.')
  }

  const beginPdfUpload = async (file) => {
    const currentUpload = ++uploadSequenceRef.current
    const previousPdf = uploadedPdfRef.current
    uploadedPdfRef.current = null
    setUploadedPdf(null)
    setPdfFile(file)
    setPdfFileName(file.name)
    setPdfUploadError('')
    setPdfUploadProgress((current) => ({
      stage: 'uploading',
      percent: 0,
      uploadId: current.uploadId + 1,
      fileName: file.name,
    }))
    if (previousPdf) void discardTemporaryAuthorPdf(previousPdf).catch(console.error)

    try {
      if (!file.size) throw new Error(storeText('pdfEmptyFile'))
      const header = new Uint8Array(await file.slice(0, 1024).arrayBuffer())
      const validPdf = new TextDecoder('latin1').decode(header).includes('%PDF-')
      if (!validPdf) throw new Error(storeText('pdfInvalidContents'))

      const uploaded = await uploadPrivatePdfFile(file, (percent) => {
        if (currentUpload !== uploadSequenceRef.current || !pdfFormMountedRef.current) return
        setPdfUploadProgress((current) => ({ ...current, stage: percent >= 100 ? 'processing' : 'uploading', percent }))
      })

      if (!pdfFormMountedRef.current || currentUpload !== uploadSequenceRef.current) {
        await discardTemporaryAuthorPdf(uploaded).catch(console.error)
        return
      }
      uploadedPdfRef.current = uploaded
      setUploadedPdf(uploaded)
      setPdfUploadProgress((current) => ({ ...current, stage: 'idle', percent: 100 }))
      onNotify?.(storeText('pdfUploadedReady'))
    } catch (error) {
      if (!pdfFormMountedRef.current || currentUpload !== uploadSequenceRef.current) return
      const message = error?.message || storeText('uploadPdfFailed')
      setPdfUploadError(message)
      setPdfUploadProgress((current) => ({ ...current, stage: 'idle', percent: 0 }))
      onNotify?.(message, 'error')
    }
  }

  const selectCover = (file) => {
    void selectQueuedImage('cover', file)
  }

  const removeCover = async () => {
    if (saving) return
    try {
      await removeQueuedImage('cover')
      if (localCoverPreviewRef.current) URL.revokeObjectURL(localCoverPreviewRef.current)
      localCoverPreviewRef.current = ''
      setCoverFile(null)
      setCoverPreview('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (error) {
      onNotify?.(error.message || 'Cannot remove image', 'error')
    }
  }

  const selectGalleryImage = (index, file) => {
    void selectQueuedImage(`gallery:${index}`, file)
  }

  const removeGalleryImage = async (index) => {
    if (saving) return
    try {
      await removeQueuedImage(`gallery:${index}`)
      setGalleryImages((current) => {
        const next = [...current]
        if (next[index]?.local && next[index]?.url) {
          URL.revokeObjectURL(next[index].url)
          localGalleryPreviewsRef.current.delete(next[index].url)
        }
        next[index] = null
        return next
      })
      if (galleryInputRefs.current[index]) galleryInputRefs.current[index].value = ''
    } catch (error) {
      onNotify?.(error.message || 'Cannot remove image', 'error')
    }
  }

  const uploadCachedProductImage = async (file, kind) => {
    const token = getAuthToken()
    const cached = imageUploadCacheRef.current.get(file)
    if (cached?.token === token && cached.kind === kind) return cached.promise

    const promise = kind === 'cover' ? uploadCoverImage(file) : uploadGalleryImage(file)
    imageUploadCacheRef.current.set(file, { token, kind, promise })
    try {
      return await promise
    } catch (error) {
      if (imageUploadCacheRef.current.get(file)?.promise === promise) {
        imageUploadCacheRef.current.delete(file)
      }
      throw error
    }
  }

  const uploadBookGalleryImages = async () => {
    if (type !== 'Book') return []

    const uploadedImages = []

    for (let index = 0; index < galleryImages.length; index += 1) {
      const image = galleryImages[index]

      if (!image?.url && !image?.file && !imageTaskIdsRef.current[`gallery:${index}`]) continue

      if (imageTaskIdsRef.current[`gallery:${index}`]) {
        const imageUrl = await waitForQueuedImage(`gallery:${index}`)
        uploadedImages.push({
          url: imageUrl,
          name: image.name || `Gallery image ${index + 1}`,
        })
      } else if (image.file) {
        throw new Error('Gallery image is not saved in the local queue. Choose it again.')
      } else if (image.url && /^https?:\/\//i.test(image.url)) {
        uploadedImages.push({
          url: image.url,
          name: image.name || '',
        })
      }
    }

    return uploadedImages.slice(0, 5)
  }

  const saveProduct = async () => {
    const qualityNumber = Number(qualityPercent)
const stockNumber = Number(stock || 0)

    if (saving) return
    if (type === 'PDF' && !pdfReady) {
      onNotify?.(pdfUploadError || (pdfUploading ? storeText('pdfUploadingWait') : storeText('pdfFileRequired')), 'error')
      return
    }
    if (type === 'PDF' && pdfUploading) {
      onNotify?.(storeText('pdfUploadingWait'), 'error')
      return
    }

    if (!title.trim()) {
  onNotify?.(storeText('bookTitleRequired'), 'error')
  return
}

if (!authorName.trim()) {
  onNotify?.(storeText('authorRequired'), 'error')
  return
}

if (!category) {
  onNotify?.(storeText('categoryRequired'), 'error')
  return
}

if (!salePrice || Number(salePrice) <= 0) {
  onNotify?.(storeText('sellPriceRequired'), 'error')
  return
}

   if (!coverFile && !coverPreview) {
  onNotify?.(storeText('coverRequired'), 'error')
  return
}

   if (type === 'Book' && (Number.isNaN(stockNumber) || stockNumber < 0)) {
  onNotify?.(storeText('stockNonNegative'), 'error')
  return
}
    if (type === 'Book' && condition === 'Second Hand' && (!qualityPercent || Number.isNaN(qualityNumber) || qualityNumber < 1 || qualityNumber > 100)) {
      onNotify?.(storeText('qualityRange'), 'error')
      return
    }

    try {
      setSaving(true)
      pdfProductSavingRef.current = true
      if (type === 'PDF' && uploadedPdf?.storage_key) {
        setPdfUploadProgress((current) => ({ ...current, stage: 'saving', percent: 100 }))
      }

const coverUrl = imageTaskIdsRef.current.cover ? await waitForQueuedImage('cover') : coverFile ? await uploadCachedProductImage(coverFile, 'cover') : coverPreview

const nextGalleryImages = await uploadBookGalleryImages()

const hasExistingPdf = Boolean(productToEdit?.id && (pdfFileUrl || productToEdit?.pdfFileName))

if (type === 'PDF' && !uploadedPdf?.storage_key && !hasExistingPdf) {
  onNotify?.(storeText('pdfFileRequired'), 'error')
  setSaving(false)
  return
}

      const createdProduct = await onSave({
        type,
        title: title.trim(),
        authorName: authorName.trim(),
        publisher: publisher.trim(),
        novelType: novelType.trim(),
        category,
        genre: genre.trim(),
        description,
        coverType: coverType.trim(),
        sortOrder,
        bestSeller,
        discount,
        originalPrice,
        salePrice,
        status: active ? 'Active' : 'Draft',
        coverUrl,
galleryImages: nextGalleryImages,
stock,
        paperType,
        condition,
        qualityPercent: condition === 'Second Hand' ? qualityPercent : '',
        deliveryNote,
        preOrder,
        pdfFile,
        uploadedPdf,
        pdfFileName,
pdfFileUrl,
pageCount,
accessRule,
      }, (stage, percent) => {
        if (stage === 'verifying') uploadedPdfRef.current = null
        setPdfUploadProgress((current) => ({
          ...current,
          stage,
          percent: Math.max(0, Math.min(100, Number(percent) || 0)),
        }))
      })
      if (createdProduct?.id) {
        uploadedPdfRef.current = null
        const queue = imageQueueRef.current
        if (queue) {
          queue.stop()
          for (const id of Object.values(imageTaskIdsRef.current)) {
            const task = await queue.get(id).catch(() => null)
            if (task?.status === 'uploaded') await queue.remove(id).catch(() => {})
          }
          imageTaskIdsRef.current = {}
          setImageTasks({})
        }
      }
    } catch (error) {
      onNotify?.(error?.message || (type === 'PDF' && pdfFile ? storeText('pdfUploadTryAgain') : storeText('saveTryAgain')), 'error')
    } finally {
      pdfProductSavingRef.current = false
      setSaving(false)
      setPdfUploadProgress((current) => ({ ...current, stage: 'idle' }))
    }
  }

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-4 pb-28">
<div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <AdminStyleCard title={storeText('coverSectionTitle')} text={storeText('coverSectionHelp')}>
          <FormDivider title={storeText('mainCover')} />

          <p className="mb-3 text-[11px] font-semibold leading-5 text-[var(--shadow-text-secondary)]">{storeText('coverRecommendation')}</p>

          <div className="flex flex-col items-center">
            <button
  type="button"
  onClick={() => fileInputRef.current?.click()}
  onDragOver={(event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }}
  onDrop={(event) => {
    event.preventDefault()
    selectCover(event.dataTransfer.files?.[0])
  }}
  className="relative aspect-[2/3] w-[200px] cursor-pointer overflow-hidden rounded-[24px] border border-dashed border-[var(--shadow-border-strong)] bg-[var(--shadow-bg-soft)] shadow-inner"
>
  {coverPreview ? (
    <img src={safeCoverPreviewUrl(coverPreview)} alt={storeText('coverPreview')} className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full w-full flex-col items-center justify-center px-5 text-center text-[var(--shadow-text-tertiary)]">
      <i className="fa-regular fa-image mb-3 text-[28px]" />
      <span className="text-[12px] font-black">{storeText('bookCoverPreview')}</span>
      <span className="mt-1 text-[11px] font-bold">{storeText('vertical23')}</span>
    </div>
  )}

  <span className="absolute inset-x-3 bottom-3 rounded-xl bg-[var(--shadow-bg-surface)]/90 px-3 py-2 text-center text-[10px] font-black text-[var(--shadow-text-secondary)] shadow-sm">
    {coverPreview ? storeText('chooseReplaceCover') : storeText('chooseCover')}
  </span>
</button>

<input
  ref={fileInputRef}
  type="file"
  accept="image/*"
  onChange={(event) => selectCover(event.target.files?.[0])}
  className="hidden"
/>

            {imageTasks.cover && imageTasks.cover.status !== 'uploaded' ? (
              <div className="mt-2 flex w-full items-center justify-between gap-2 text-[11px] text-[var(--shadow-text-secondary)]">
                <span>{imageTasks.cover.status === 'failed' ? String(imageTasks.cover.lastError || 'Upload failed') : `Upload ${Math.round(imageTasks.cover.progress || 0)}%`}</span>
                {imageTasks.cover.status === 'failed' ? <button type="button" onClick={() => retryQueuedImage('cover')} className="font-bold underline">Retry</button> : null}
              </div>
            ) : null}
            {imageQueueMessage ? <p className="mt-2 text-[11px] text-red-600">{imageQueueMessage}</p> : null}
            {coverPreview ? (
              <button
                type="button"
                onClick={removeCover}
                className="mt-2 h-10 w-full rounded-2xl bg-[#fff1f1] text-[12px] font-black text-[#e5484d] active:scale-[0.98]"
              >{storeText('clearBookCover')}</button>
            ) : null}

          </div>
        </AdminStyleCard>

        <AdminStyleCard title={storeText('gallerySectionTitle')} text={storeText('gallerySectionHelp')}>
          <FormDivider title={storeText('extraBookImages')} />

          <p className="mb-3 text-[11px] font-semibold leading-5 text-[var(--shadow-text-secondary)]">{storeText('galleryHelp')}</p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {galleryImages.map((image, index) => (
              <div key={index}>
                <input
                  ref={(node) => {
                    galleryInputRefs.current[index] = node
                  }}
                  type="file"
                  accept="image/*"
                  onChange={(event) => selectGalleryImage(index, event.target.files?.[0])}
                  className="hidden"
                />
                <GallerySlot
  image={image}
  index={index}
  onChoose={() => !saving && galleryInputRefs.current[index]?.click()}
  onDrop={(file) => selectGalleryImage(index, file)}
  onRemove={() => removeGalleryImage(index)}
/>
                {imageTasks[`gallery:${index}`] && imageTasks[`gallery:${index}`].status !== 'uploaded' ? (
                  <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-[var(--shadow-text-secondary)]">
                    <span>{imageTasks[`gallery:${index}`].status === 'failed' ? 'Upload failed' : `Upload ${Math.round(imageTasks[`gallery:${index}`].progress || 0)}%`}</span>
                    {imageTasks[`gallery:${index}`].status === 'failed' ? <button type="button" onClick={() => retryQueuedImage(`gallery:${index}`)} className="font-bold underline">Retry</button> : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </AdminStyleCard>
      </div>

      <section className="mt-4 overflow-hidden rounded-[24px] bg-[var(--shadow-bg-surface)] shadow-sm ring-1 ring-[var(--shadow-border)]">
        <div className="border-b border-[var(--shadow-border)] px-4 py-4">
          <h1 className="text-[17px] font-black leading-5 text-[var(--shadow-text-primary)]">{storeText('bookInformation')}</h1>
          <p className="mt-1 text-[12px] font-semibold leading-5 text-[var(--shadow-text-tertiary)]">{storeText('bookInformationHelp')}</p>
        </div>

        <div className="space-y-4 p-4">
          <FormDivider title={storeText('productType')} />

          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-[var(--shadow-bg-soft)] p-1">
            <button
              type="button"
              onClick={() => setType('Book')}
              className={`h-11 rounded-xl text-[13px] font-black ${type === 'Book' ? 'bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-primary)] shadow-sm' : 'text-[var(--shadow-text-secondary)]'}`}
            >{storeText('book')}</button>
            <button
              type="button"
              onClick={() => setType('PDF')}
              className={`h-11 rounded-xl text-[13px] font-black ${type === 'PDF' ? 'bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-primary)] shadow-sm' : 'text-[var(--shadow-text-secondary)]'}`}
            >{storeText('pdf')}</button>
          </div>

        <FormDivider title={storeText('bookInformationDivider')} />

<div>
  <FieldLabel>{`${storeText('bookTitle')} *`}</FieldLabel>
  <TextInput value={title} onChange={setTitle} placeholder={storeText('enterBookTitle')} />
</div>

<div className="grid gap-3 sm:grid-cols-2">
  <div>
    <FieldLabel>{`${storeText('authorName')} *`}</FieldLabel>
    <TextInput value={authorName} onChange={setAuthorName} placeholder={storeText('authorNamePlaceholder')} />
  </div>

  <div>
    <FieldLabel>{storeText('publisher')}</FieldLabel>
    <TextInput value={publisher} onChange={setPublisher} placeholder={storeText('publisherPlaceholder')} />
  </div>
</div>

<div className="grid gap-3 sm:grid-cols-2">
  <div>
    <FieldLabel>{storeText('novelType')}</FieldLabel>
    <TextInput value={novelType} onChange={setNovelType} placeholder={storeText('novelTypePlaceholder')} />
  </div>

  <div>
    <FieldLabel>{`${storeText('category')} *`}</FieldLabel>
    <SelectInput value={category} onChange={setCategory}>
  <option value="">{storeText('selectCategory')}</option>
  {categories
  .filter((item) => item !== 'Sold out')
  .map((item) => <option key={item} value={item}>{storeValueLabel(item)}</option>)}
</SelectInput>
  </div>
</div>

<div className="grid gap-3 sm:grid-cols-2">
  <div>
    <FieldLabel>{storeText('genre')}</FieldLabel>
    <TextInput value={genre} onChange={setGenre} placeholder={storeText('genrePlaceholder')} />
  </div>

  {type === 'Book' ? (
    <div>
      <FieldLabel>{storeText('condition')}</FieldLabel>
      <SelectInput value={condition} onChange={setCondition}>
        {BOOK_CONDITIONS.map((item) => <option key={item} value={item}>{storeValueLabel(item)}</option>)}
      </SelectInput>
    </div>
  ) : null}
</div>

{type === 'Book' ? (
  <div className="grid gap-3 sm:grid-cols-2">
    <div>
      <FieldLabel>{storeText('paperType')}</FieldLabel>
      <TextInput value={paperType} onChange={setPaperType} placeholder={storeText('paperTypePlaceholder')} />
    </div>

    <div>
      <FieldLabel>{storeText('coverType')}</FieldLabel>
      <TextInput value={coverType} onChange={setCoverType} placeholder={storeText('coverTypePlaceholder')} />
    </div>
  </div>
) : null}

<div className="grid gap-3 sm:grid-cols-2">
  <div>
    <FieldLabel>{storeText('pageCount')}</FieldLabel>
    <TextInput value={pageCount} onChange={setPageCount} placeholder={storeText('pageCountPlaceholder')} type="number" />
  </div>

  {condition === 'Second Hand' ? (
    <div>
      <FieldLabel>{storeText('conditionNote')}</FieldLabel>
      <TextInput value={qualityPercent} onChange={setQualityPercent} placeholder={storeText('qualityPlaceholder')} type="number" />
      <p className="mt-1.5 text-[11px] font-bold text-[var(--shadow-text-tertiary)]">{storeText('conditionNoteHelp')}</p>
    </div>
  ) : null}
</div>

          <FormDivider title={storeText('saleStock')} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel>{`${storeText('salePrice')} *`}</FieldLabel>
              <TextInput value={salePrice} onChange={setSalePrice} placeholder={storeText('salePricePlaceholder')} type="number" />
            </div>
            <div>
              <FieldLabel>{storeText('originalPrice')}</FieldLabel>
              <TextInput value={originalPrice} onChange={setOriginalPrice} placeholder={storeText('originalPricePlaceholder')} type="number" />
            </div>
          </div>

         {type === 'Book' ? (
  <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <FieldLabel>{storeText('stockQuantity')}</FieldLabel>
        <TextInput value={stock} onChange={setStock} placeholder={storeText('stockPlaceholder')} type="number" />
      </div>

      <div>
        <FieldLabel>{storeText('sortOrder')}</FieldLabel>
        <TextInput value={sortOrder} onChange={setSortOrder} placeholder="0" type="number" />
      </div>
    </div>

    <label className="flex h-11 items-center gap-2 rounded-2xl border border-[var(--shadow-border)] bg-[var(--shadow-bg-surface)] px-3.5 text-[13px] font-bold text-[var(--shadow-text-primary)]">
      <input type="checkbox" checked={preOrder} onChange={(event) => setPreOrder(event.target.checked)} />{storeText('preOrderProduct')}</label>

<div className="grid gap-3 sm:grid-cols-2">
  <label className="flex h-11 items-center gap-2 rounded-2xl border border-[var(--shadow-border)] bg-[var(--shadow-bg-surface)] px-3.5 text-[13px] font-bold text-[var(--shadow-text-primary)]">
    <input
      type="checkbox"
      checked={bestSeller}
      onChange={(event) => setBestSeller(event.target.checked)}
    />{storeText('bestSellerProduct')}</label>

  <label className="flex h-11 items-center gap-2 rounded-2xl border border-[var(--shadow-border)] bg-[var(--shadow-bg-surface)] px-3.5 text-[13px] font-bold text-[var(--shadow-text-primary)]">
    <input
      type="checkbox"
      checked={discount}
      onChange={(event) => setDiscount(event.target.checked)}
    />{storeText('discountProduct')}</label>
</div>
    
  </div>
) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <AuthorPdfUploadProgress
                  label={storeText('pdfFile')}
                  fileName={pdfUploadProgress.fileName}
                  stage={pdfUploadProgress.stage}
                  percent={pdfUploadProgress.percent}
                  uploadId={pdfUploadProgress.uploadId}
                />
                <input
                  ref={pdfInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  disabled={saving || pdfUploading}
                  onClick={(event) => { event.currentTarget.value = '' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]

                    if (!file) {
                      setPdfFile(null)
                      return
                    }

                    const isPdf =
                      file.type === 'application/pdf' ||
                      file.name.toLowerCase().endsWith('.pdf')

                    if (!isPdf || !file.name.toLowerCase().endsWith('.pdf')) {
                      onNotify?.(storeText('validPdf'), 'error')
                      event.target.value = ''
                      return
                    }

                    if (file.size > 50 * 1024 * 1024) {
                      onNotify?.(storeText('pdfSizeLimit'), 'error')
                      event.target.value = ''
                      return
                    }

                    void beginPdfUpload(file)
                  }}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => pdfInputRef.current?.click()}
                  disabled={saving || pdfUploading}
                  className="h-11 w-full rounded-2xl border border-dashed border-[var(--shadow-border-strong)] bg-[var(--shadow-input-bg)] px-3.5 text-[12px] font-black text-[var(--shadow-text-primary)] active:scale-[0.98] disabled:opacity-50"
                >
                  {pdfFile ? storeText('replacePdf') : pdfFileName ? storeText('replaceAttachedPdf') : storeText('choosePdf')}
                </button>
                {uploadedPdf?.storage_key ? (
                  <div className="mt-2 text-[11px] font-bold text-[#027a48]">{storeText('pdfUploadedReady')}</div>
                ) : pdfUploading ? (
                  <div className="mt-2 text-[11px] font-bold text-[var(--shadow-text-secondary)]">{storeText('pdfUploadingWait')}</div>
                ) : pdfUploadError && pdfFile ? (
                  <button
                    type="button"
                    onClick={() => void beginPdfUpload(pdfFile)}
                    disabled={saving || pdfUploading}
                    className="mt-2 rounded-lg px-2 py-1 text-[11px] font-bold text-[#b42318] ring-1 ring-[#fecaca] disabled:opacity-50"
                  >{storeText('pdfRetryUpload')}</button>
                ) : pdfFileName ? (
                  <div className="mt-2 text-[11px] font-bold text-[var(--shadow-text-secondary)]">{storeText('pdfAttached')}</div>
                ) : null}
              </div>
              <div>
                <FieldLabel>{storeText('pageCount')}</FieldLabel>
                <TextInput value={pageCount} onChange={setPageCount} placeholder={storeText('pageCountPdfPlaceholder')} type="number" />
              </div>
              <div className="sm:col-span-2 min-w-0">
                <FieldLabel>{storeText('accessRule')}</FieldLabel>
                <div className="grid w-full min-w-0 grid-cols-3 gap-1.5">
                  {PDF_ACCESS_RULES.map((item, index) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={accessRule === item}
                      onClick={() => setAccessRule(item)}
                      className={`flex min-h-[76px] min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-2 text-center text-[10px] font-semibold leading-[1.35] [overflow-wrap:anywhere] transition-colors ${accessRule === item ? 'border-blue-600 bg-blue-600 text-white' : 'border-[var(--shadow-border)] bg-[var(--shadow-input-bg)] text-[var(--shadow-text-primary)]'}`}
                    >
                      <i aria-hidden="true" className={`fa-solid text-sm ${index === 0 ? 'fa-download' : index === 1 ? 'fa-book-open' : 'fa-book'}`} />
                      <span className="block w-full min-w-0">{storeValueLabel(item)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

<FormDivider title={storeText('productDetails')} />

<div>
  <FieldLabel>{storeText('conditionLabel')}</FieldLabel>
  <TextInput value={deliveryNote} onChange={setDeliveryNote} placeholder={storeText('conditionPlaceholder')} />
</div>

<div>
  <FieldLabel>{storeText('description')}</FieldLabel>
  <textarea
    value={description}
    onChange={(event) => setDescription(event.target.value)}
    placeholder={storeText('descriptionPlaceholder')}
    className="min-h-[120px] w-full rounded-2xl border border-[var(--shadow-border)] bg-[var(--shadow-input-bg)] px-3.5 py-3 text-[13px] font-bold text-[var(--shadow-text-primary)] outline-none focus:border-[var(--shadow-border-strong)]"
  />
</div>

<div>
  <label className="flex items-center gap-3 rounded-2xl bg-[var(--shadow-bg-soft)] px-4 py-3 text-[13px] font-black text-[var(--shadow-text-primary)] ring-1 ring-[var(--shadow-border)]">
    <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />{storeText('activeLabel')}</label>
</div>

<div className="grid gap-3 sm:grid-cols-2">
  <button
    type="button"
    onClick={onBack}
    disabled={saving}
    className="h-12 rounded-2xl bg-[var(--shadow-bg-soft)] text-[13px] font-black text-[var(--shadow-text-primary)] active:scale-[0.98] disabled:opacity-50"
  >{storeText('cancel')}</button>

  <button
    type="button"
    onClick={saveProduct}
    disabled={saving || (type === 'PDF' && (!pdfReady || pdfUploading))}
    className="h-12 rounded-2xl bg-[var(--shadow-text-primary)] text-[13px] font-black text-[var(--shadow-bg-surface)] active:scale-[0.98] disabled:opacity-60"
  >
    {saving ? (
      <span className="inline-flex items-center justify-center gap-2">
        <i className="fa-solid fa-spinner fa-spin text-[12px]" />{storeText('saving')}</span>
    ) : productToEdit ? storeText('saveProduct') : storeText('createProduct')}
  </button>
</div>
        </div>
      </section>
    </main>
  )
}

export default function AuthorStoreManagerPage() {
  useDisplayTranslation()
  const [promotion, setPromotion] = useState(null)
  const [authorMenuOpen, setAuthorMenuOpen] = useState(false)
  const navigate = useNavigate()
  const [mode, setMode] = useState('manager')
  useAuthorPageFooterVisibility(mode === 'manager')
  const [editingProduct, setEditingProduct] = useState(null)
  const [activeTab, setActiveTab] = useState('Records')
  const recordDefaults = useMemo(getStoredProductViewOptions, [])
  const [activeType, setActiveType] = useState(recordDefaults.type)
  const [recordQuery, setRecordQuery] = useState(recordDefaults.q)
  const [recordFilter, setRecordFilter] = useState(recordDefaults.sort)
  const [recordSearch, setRecordSearch] = useState(recordDefaults.q.trim())
  const [productTotal, setProductTotal] = useState(0)
  const [productHasNext, setProductHasNext] = useState(false)
  const [productLoadingMore, setProductLoadingMore] = useState(false)
  const [productRefreshing, setProductRefreshing] = useState(false)
  const productRequestIdRef = useRef(0)
  const productLoadMoreRef = useRef(false)
  const [newCategory, setNewCategory] = useState('')
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES)
  const [storeCategories, setStoreCategories] = useState([])
  const [categoryError, setCategoryError] = useState('')
  const [categorySaving, setCategorySaving] = useState(false)
  const [editingCategoryId, setEditingCategoryId] = useState('')
  const [editingCategoryName, setEditingCategoryName] = useState('')
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(false)
  const [localError, setLocalError] = useState('')
  const [storeToast, setStoreToast] = useState(null)
  const [storeToastVisible, setStoreToastVisible] = useState(false)

  useEffect(() => {
    if (!storeToast) return undefined

    setStoreToastVisible(true)

    const visibleMs = storeToast.type === 'error' ? 2800 : 1800
    const hideTimer = window.setTimeout(() => {
      setStoreToastVisible(false)
    }, visibleMs)
    const clearTimer = window.setTimeout(() => {
      setStoreToast(null)
    }, visibleMs + 300)

    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(clearTimer)
    }
  }, [storeToast])

  const showStoreToast = useCallback((message, type = 'success') => {
    setStoreToast({
      message: String(message || ''),
      type: type === 'error' ? 'error' : 'success',
      id: Date.now(),
    })
  }, [])

  const [orderSummary, setOrderSummary] = useState({
    orders_count: 0,
    revenue: 0,
    gross_revenue: 0,
    platform_fee: 0,
    author_income: 0,
  })
  const [orders, setOrders] = useState([])
  const [orderPage, setOrderPage] = useState(1)
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderPagination, setOrderPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    total_pages: 1,
  })
  const [orderType, setOrderType] = useState('all')
  const [orderPrepareFilter, setOrderPrepareFilter] = useState('all')
  const [orderSearchDraft, setOrderSearchDraft] = useState('')
  const [orderSearchQuery, setOrderSearchQuery] = useState('')
  const [orderActionLoadingId, setOrderActionLoadingId] = useState('')
  const storeAccountId = useMemo(() => getAuthorStoreAccountId(), [])
  const orderRequestIdRef = useRef(0)
  const orderSummaryRequestIdRef = useRef(0)

  const applyOrderSummary = useCallback((summary) => {
    if (!summary) return
    setOrderSummary({
      orders_count: Number(summary.orders_count ?? summary.total_orders ?? 0),
      revenue: Number(summary.revenue ?? summary.author_income ?? 0),
      gross_revenue: Number(summary.gross_revenue ?? 0),
      platform_fee: Number(summary.platform_fee ?? 0),
      author_income: Number(summary.author_income ?? summary.revenue ?? 0),
    })
  }, [])

  const loadOrderSummary = useCallback(async () => {
    const requestId = ++orderSummaryRequestIdRef.current
    const cached = storeAccountId
      ? readAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'orderSummary' })
      : null
    if (cached?.exists) applyOrderSummary(cached.data)
    try {
      const result = storeAccountId
        ? await fetchAuthorStoreResource({
            accountId: storeAccountId,
            resource: 'orderSummary',
            fetcher: fetchMyOrderSummary,
          })
        : { data: await fetchMyOrderSummary(), obsolete: false }
      if (requestId === orderSummaryRequestIdRef.current && !result.obsolete) {
        applyOrderSummary(result.data)
      }
    } catch {
    }
  }, [storeAccountId, applyOrderSummary])

  const loadPromotion = useCallback(async () => {
    try {
      const result = storeAccountId
        ? await fetchAuthorStoreResource({
            accountId: storeAccountId,
            resource: 'promotion',
            fetcher: fetchMyStorePromotion,
          })
        : { data: await fetchMyStorePromotion() }
      if (!result.obsolete) setPromotion(result.data || null)
    } catch {
      if (storeAccountId) {
        const cached = readAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'promotion' })
        if (cached.exists) setPromotion(cached.data)
      }
    }
  }, [storeAccountId])

    const loadOrderReport = useCallback(async ({ silent = false, force = false } = {}) => {
    const requestId = ++orderRequestIdRef.current
    const params = {
      page: orderPage,
      type: orderType,
      prepareStatus: orderPrepareFilter,
      q: orderSearchQuery,
    }
    const cached = storeAccountId
      ? readAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'orders', params })
      : null
    const applyReport = (report) => {
      if (!report || requestId !== orderRequestIdRef.current) return
      applyOrderSummary(report.summary)
      setOrders(report.orders || [])
      setOrderPagination(report.pagination || {
        page: orderPage,
        limit: ORDER_REPORT_LIMIT,
        total: 0,
        total_pages: 1,
      })
    }

    if (!force && cached?.exists && cached.data) {
      applyReport(cached.data)
      setOrderLoading(false)
    } else if (!silent) {
      setOrders([])
      setOrderLoading(true)
    }

    try {
      const result = storeAccountId
        ? await fetchAuthorStoreResource({
            accountId: storeAccountId,
            resource: 'orders',
            params,
            fetcher: () => fetchMyOrderReport({ ...params, limit: ORDER_REPORT_LIMIT }),
            force,
          })
        : { data: await fetchMyOrderReport({ ...params, limit: ORDER_REPORT_LIMIT }) }
      if (requestId !== orderRequestIdRef.current || result.obsolete || !result.data) return
      applyReport(result.data)
      if (storeAccountId && !result.fromCache && result.data.summary) {
        writeAuthorStoreResourceCache({
          accountId: storeAccountId,
          resource: 'orderSummary',
          data: result.data.summary,
        })
      }
    } catch (error) {
      if (requestId === orderRequestIdRef.current && !cached?.exists && !silent) {
        setLocalError(error.message || storeText('loadOrdersFailed'))
      }
    } finally {
      if (requestId === orderRequestIdRef.current) setOrderLoading(false)
    }
  }, [storeAccountId, orderPage, orderType, orderPrepareFilter, orderSearchQuery, applyOrderSummary])


  useEffect(() => {
    setOrderPage(1)
  }, [orderType, orderPrepareFilter, orderSearchQuery])

  const filteredProducts = products

  useEffect(() => {
    if (recordQuery.trim() === recordSearch) return undefined
    const timer = window.setTimeout(() => setRecordSearch(recordQuery.trim()), 400)
    return () => window.clearTimeout(timer)
  }, [recordQuery, recordSearch])

  useEffect(() => {
    if (!storeAccountId) return
    try {
      sessionStorage.setItem(
        `shadow_author_store_product_options_v1:${encodeURIComponent(storeAccountId)}`,
        JSON.stringify({ type: activeType, sort: recordFilter, q: recordQuery })
      )
    } catch {
    }
  }, [storeAccountId, activeType, recordFilter, recordQuery])

  const productView = useMemo(() => ({
    type: activeType.toLowerCase(),
    sort: recordFilter,
    q: recordSearch,
  }), [activeType, recordFilter, recordSearch])
  const productViewKey = JSON.stringify(productView)

  useEffect(() => {
    if (mode !== 'manager' || activeTab !== 'Records') return undefined
    const requestId = ++productRequestIdRef.current
    let cancelled = false
    let scrollPosition = window.scrollY
    const onScroll = () => { scrollPosition = window.scrollY }
    window.addEventListener('scroll', onScroll, { passive: true })
    productLoadMoreRef.current = false
    setProductLoadingMore(false)
    setLocalError('')

    if (!storeAccountId) {
      setProducts([])
      setProductTotal(0)
      setProductHasNext(false)
      setLoading(false)
      setProductRefreshing(false)
      setLocalError(storeText('pleaseLogin'))
      return () => { window.removeEventListener('scroll', onScroll) }
    }

    const cached = readAuthorStoreProductCache(storeAccountId, productView)
    const applyCache = () => {
      if (cancelled || requestId !== productRequestIdRef.current) return
      const next = readAuthorStoreProductCache(storeAccountId, productView)
      const items = next.products.slice(0, next.total).map(formatProductForUi)
      setProducts(items)
      setProductTotal(next.total)
      setProductHasNext(next.hasNext && items.length < next.total)
      setCategories((current) => Array.from(new Set([
        ...current,
        ...items.map((item) => item.category).filter(Boolean),
      ])))
    }
    applyCache()
    setLoading(cached.loadedPages === 0)
    setProductRefreshing(!cached.fresh && cached.loadedPages > 0)

    if (!cached.fresh) {
      void (async () => {
        try {
          const first = await fetchAuthorStoreProductPage({
            accountId: storeAccountId,
            apiBaseUrl: API_BASE_URL,
            token: getAuthToken(),
            view: productView,
            page: 1,
            force: true,
          })
          if (cancelled || requestId !== productRequestIdRef.current) return
          const availablePages = Math.max(1, Math.ceil(Number(first.pagination.total || 0) / AUTHOR_STORE_PRODUCT_PAGE_SIZE))
          const keepPages = Math.min(Math.max(1, cached.loadedPages), availablePages)
          for (let page = 2; page <= keepPages; page += 1) {
            if (cancelled || requestId !== productRequestIdRef.current) return
            await fetchAuthorStoreProductPage({
              accountId: storeAccountId,
              apiBaseUrl: API_BASE_URL,
              token: getAuthToken(),
              view: productView,
              page,
              force: true,
            })
          }
          applyCache()
        } catch (error) {
          if (!cancelled && requestId === productRequestIdRef.current) {
            setLocalError(error.message || storeText('loadProductsUiFailed'))
          }
        } finally {
          if (!cancelled && requestId === productRequestIdRef.current) {
            setLoading(false)
            setProductRefreshing(false)
          }
        }
      })()
    } else {
      setLoading(false)
      setProductRefreshing(false)
    }

    let nextScrollFrame = 0
    const scrollFrame = window.requestAnimationFrame(() => {
      nextScrollFrame = window.requestAnimationFrame(() => {
        if (!cancelled) window.scrollTo(0, cached.scrollY || 0)
      })
    })

    return () => {
      cancelled = true
      window.removeEventListener('scroll', onScroll)
      window.cancelAnimationFrame(scrollFrame)
      window.cancelAnimationFrame(nextScrollFrame)
      rememberAuthorStoreProductView(storeAccountId, productView, scrollPosition)
      if (productRequestIdRef.current === requestId) productRequestIdRef.current += 1
    }
  }, [activeTab, mode, storeAccountId, productViewKey])

  const loadMoreProducts = useCallback(async () => {
    if (!storeAccountId || productLoadMoreRef.current || productRefreshing || loading || mode !== 'manager' || activeTab !== 'Records') return
    const before = readAuthorStoreProductCache(storeAccountId, productView)
    if (!before.hasNext || !before.loadedPages) return
    const requestId = productRequestIdRef.current
    productLoadMoreRef.current = true
    setProductLoadingMore(true)
    try {
      await fetchAuthorStoreProductPage({
        accountId: storeAccountId,
        apiBaseUrl: API_BASE_URL,
        token: getAuthToken(),
        view: productView,
        page: before.loadedPages + 1,
      })
      if (requestId !== productRequestIdRef.current) return
      const updated = readAuthorStoreProductCache(storeAccountId, productView)
      const items = updated.products.slice(0, updated.total).map(formatProductForUi)
      setProducts(items)
      setProductTotal(updated.total)
      setProductHasNext(updated.hasNext && items.length < updated.total)
      setCategories((current) => Array.from(new Set([...current, ...items.map((item) => item.category).filter(Boolean)])))
    } catch (error) {
      if (requestId === productRequestIdRef.current) setLocalError(error.message || storeText('loadProductsUiFailed'))
    } finally {
      productLoadMoreRef.current = false
      if (requestId === productRequestIdRef.current) setProductLoadingMore(false)
    }
  }, [activeTab, loading, mode, productRefreshing, productViewKey, storeAccountId])

  useEffect(() => {
    if (activeTab === 'Records') void loadPromotion()
  }, [activeTab, loadPromotion])

  useEffect(() => {
    if (activeTab === 'Orders') {
      void loadOrderReport({ silent: false })
    } else if (activeTab === 'Records') {
      void loadOrderSummary()
    }
    return () => {
      orderRequestIdRef.current += 1
      orderSummaryRequestIdRef.current += 1
    }
  }, [activeTab, loadOrderReport, loadOrderSummary])

  const loadCategories = useCallback(async () => {
    const apply = (nextCategories) => {
      if (!Array.isArray(nextCategories)) return
      setStoreCategories(nextCategories)
      setCategories((current) => {
        const names = nextCategories.map((item) => item.name).filter(Boolean)
        return Array.from(new Set([...current, ...names]))
      })
    }
    const cached = storeAccountId
      ? readAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'categories' })
      : null
    if (cached?.exists) apply(cached.data)
    if (cached?.fresh) return
    try {
      setCategoryError('')
      const result = storeAccountId
        ? await fetchAuthorStoreResource({ accountId: storeAccountId, resource: 'categories', fetcher: fetchMyCategories })
        : { data: await fetchMyCategories() }
      if (!result.obsolete) apply(result.data)
    } catch (error) {
      setCategoryError(error.message || storeText('loadCategoriesUiFailed'))
    }
  }, [storeAccountId])

  useEffect(() => {
    if (mode === 'form') void loadCategories()
  }, [mode, loadCategories])

  const invalidateCategories = () => {
    if (storeAccountId) invalidateAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'categories' })
  }

  const addCategory = async () => {
  const name = newCategory.trim()

  if (!name || categorySaving) return

  if (storeCategories.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
    setNewCategory('')
    return
  }

  try {
    setCategorySaving(true)
    setCategoryError('')

    const createdCategory = await createStoreCategory(name)

    if (createdCategory) {
      setStoreCategories((current) => [...current, createdCategory])
      setCategories((current) => Array.from(new Set([...current, createdCategory.name])))
      invalidateCategories()
    }

    setNewCategory('')
  } catch (error) {
    setCategoryError(error.message || storeText('createCategoryUiFailed'))
  } finally {
    setCategorySaving(false)
  }
}

  const startEditCategory = (category) => {
  setEditingCategoryId(category.id)
  setEditingCategoryName(category.name)
  setCategoryError('')
}

const cancelEditCategory = () => {
  setEditingCategoryId('')
  setEditingCategoryName('')
}

const saveEditCategory = async (category) => {
  const name = editingCategoryName.trim()

  if (!category?.id || !name || categorySaving) return

  try {
    setCategorySaving(true)
    setCategoryError('')

    const updatedCategory = await updateStoreCategory(category.id, { name })

    if (updatedCategory) {
      setStoreCategories((current) =>
        current.map((item) => (item.id === updatedCategory.id ? updatedCategory : item))
      )
      setCategories((current) => Array.from(new Set([...current, updatedCategory.name])))
      invalidateCategories()
    }

    cancelEditCategory()
  } catch (error) {
    setCategoryError(error.message || storeText('updateCategoryUiFailed'))
  } finally {
    setCategorySaving(false)
  }
}

const handleDeleteCategory = async (category) => {
  if (!category?.id || categorySaving) return

  const confirmed = window.confirm(`Delete "${storeValueLabel(category.name)}"?`)

  if (!confirmed) return

  try {
    setCategorySaving(true)
    setCategoryError('')

    await deleteStoreCategory(category.id)
    setStoreCategories((current) => current.filter((item) => item.id !== category.id))
    invalidateCategories()
  } catch (error) {
    setCategoryError(error.message || storeText('deleteCategoryUiFailed'))
  } finally {
    setCategorySaving(false)
  }
}

      const handleToggleHideCategory = async (category) => {
  if (!category?.id || categorySaving) return

  try {
    setCategorySaving(true)
    setCategoryError('')

    const updatedCategory = await updateStoreCategory(category.id, {
      is_hidden: !category.isHidden,
    })
    invalidateCategories()

    if (updatedCategory) {
      setStoreCategories((current) =>
        current.map((item) => (item.id === updatedCategory.id ? updatedCategory : item))
      )
    }
  } catch (error) {
    setCategoryError(error.message || storeText('updateCategoryUiFailed'))
  } finally {
    setCategorySaving(false)
  }
}

const moveCategory = (categoryId, direction) => {
  setStoreCategories((current) => {
    const index = current.findIndex((item) => item.id === categoryId)
    if (index < 0) return current

    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= current.length) return current

    const next = [...current]
    const temp = next[index]
    next[index] = next[nextIndex]
    next[nextIndex] = temp
    return next
  })
}

const saveCategoryOrder = async () => {
  if (categorySaving) return

  try {
    setCategorySaving(true)
    setCategoryError('')

    const savedCategories = await reorderStoreCategories(storeCategories.map((item) => item.id))
    setStoreCategories(savedCategories)
    invalidateCategories()
  } catch (error) {
    setCategoryError(error.message || storeText('saveCategoryOrderUiFailed'))
  } finally {
    setCategorySaving(false)
  }
}

  const saveProduct = async (product, onPdfUploadProgress) => {
    const isEditing = Boolean(editingProduct?.id)
    const hasNewPrivatePdf = product.type === 'PDF' && Boolean(product.uploadedPdf?.storage_key)
    let savedProduct = null
    let pdfAttached = false

    try {
      if (isEditing) {
        const metadataProduct = hasNewPrivatePdf
          ? {
              ...product,
              pdfFileName: editingProduct?.pdfFileName || '',
              pdfFileUrl: editingProduct?.pdfFileUrl || '',
              accessRule: product.accessRule,
            }
          : product

        savedProduct = await updateStoreProduct(editingProduct.id, metadataProduct)
      } else {
        const initialProduct = hasNewPrivatePdf
          ? {
              ...product,
              status: 'Draft',
              pdfFileUrl: '',
              accessRule: product.accessRule,
            }
          : product

        savedProduct = await createStoreProduct(initialProduct)
      }

      if (!savedProduct?.id) {
        throw new Error(storeText('productNotSaved'))
      }

      if (hasNewPrivatePdf) {
        onPdfUploadProgress?.('processing', 100)
        const attached = await attachPrivatePdfToProduct(savedProduct.id, product.uploadedPdf)
        if (
          String(attached?.id || '') !== String(savedProduct.id) ||
          attached?.pdf_storage_provider !== 'r2' ||
          attached?.pdf_file_name !== product.uploadedPdf.file_name
        ) {
          throw new Error(storeText('pdfAttachNotConfirmed'))
        }
        pdfAttached = true
        savedProduct = { ...savedProduct, pdfFileName: attached.pdf_file_name, pdfFileUrl: '' }
        onPdfUploadProgress?.('verifying', 100)

        if (!isEditing && product.status !== 'Draft') {
          savedProduct = await updateStoreProduct(savedProduct.id, {
            ...product,
            pdfFile: null,
            pdfFileUrl: '',
            pdfFileName: product.uploadedPdf.file_name,
            accessRule: product.accessRule,
          })
        }
      }

      const finalProduct = savedProduct
      if (!finalProduct?.id || (hasNewPrivatePdf && finalProduct.pdfFileName !== product.uploadedPdf.file_name)) {
        throw new Error(storeText('pdfAttachNotConfirmed'))
      }

      if (storeAccountId) invalidateAuthorStoreProductCache(storeAccountId)
      setProducts((current) => isEditing
        ? current.map((item) => item.id === finalProduct.id ? finalProduct : item)
        : [finalProduct, ...current])
      if (!isEditing) setProductTotal((count) => count + 1)

      if (finalProduct.category && !categories.includes(finalProduct.category)) {
        setCategories((current) => [...current, finalProduct.category])
      }

      showStoreToast(storeText('savedSuccessfully'))
      setEditingProduct(null)
      setMode('manager')
      setActiveTab('Records')

      return finalProduct
    } catch (error) {
      if (!isEditing && savedProduct?.id && hasNewPrivatePdf && !pdfAttached) {
        try {
          await deleteStoreProduct(savedProduct.id)
        } catch {
        }
      }

      throw error
    }
  }

  const handleMarkOrderPreparing = async (order) => {
    const orderId = order?.order_id || order?.order_number || order?.id

    if (!orderId || orderActionLoadingId) return

    try {
      setOrderActionLoadingId(order.id || orderId)

      const updatedOrder = await markMyAuthorStoreOrderPreparing(orderId)

      if (updatedOrder) {
        setOrders((current) =>
          current.map((item) => (item.id === updatedOrder.id ? updatedOrder : item))
        )
      }

      if (storeAccountId) {
  invalidateAuthorStoreResourceCache({ accountId: storeAccountId, resource: 'orders' })
}
await loadOrderReport({ silent: true, force: true })
    } catch {
    } finally {
      setOrderActionLoadingId('')
    }
  }

  const handleDeleteProduct = async (product) => {
    if (!product?.id) return

    const confirmed = window.confirm(`Delete "${product.title || storeText('deleteThisProduct')}"?`)

    if (!confirmed) return

    try {
      setLocalError('')
      await deleteStoreProduct(product.id)
      setProducts((current) => current.filter((item) => item.id !== product.id))
      setProductTotal((count) => Math.max(0, count - 1))
      if (storeAccountId) invalidateAuthorStoreProductCache(storeAccountId)
    } catch (error) {
      setLocalError(error.message || storeText('deleteProductFailed'))
    }
  }

  const handleEditProduct = (product) => {
    setEditingProduct(product)
    setMode('form')
  }

  const openAddProductForm = () => {
    setEditingProduct(null)
    setMode('form')
  }

  const closeProductForm = () => {
    setEditingProduct(null)
    setMode('manager')
  }

  return (
    <div className={`min-h-screen bg-[var(--shadow-bg-page)] ${mode === 'form' ? 'pb-0' : 'pb-[92px]'}`}>
      {storeToast ? (
        <div
          role="status"
          className={`fixed left-1/2 top-20 z-[500] flex w-[calc(100%-2rem)] max-w-[360px] -translate-x-1/2 items-center gap-2.5 rounded-2xl px-4 py-3 text-[12px] font-black shadow-2xl transition-all duration-300 ${
            storeToastVisible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
          } ${
            storeToast.type === 'error'
              ? 'bg-[#fff1f1] text-[#b42318] ring-1 ring-[#fecaca]'
              : 'bg-[#ecfdf3] text-[#027a48] ring-1 ring-[#bbf7d0]'
          }`}
        >
          <i className={`fa-solid ${storeToast.type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'} text-[14px]`} />
          <span>{storeToast.message}</span>
        </div>
      ) : null}

<AuthorStoreMenuSheet
  open={authorMenuOpen}
  onClose={() => setAuthorMenuOpen(false)}
  onSwitchProfile={() => {
    setAuthorMenuOpen(false)
    navigate('/author/page')
  }}
  onFinance={() => {
    setAuthorMenuOpen(false)
    navigate('/author/page/finance')
  }}
  onSettings={() => {
    setAuthorMenuOpen(false)
    navigate('/author/page-settings')
  }}
/>
      <div className="sticky top-0 z-40 border-b border-[var(--shadow-border)] bg-[var(--shadow-bg-surface)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[980px] items-center justify-between px-4">
          <button
  type="button"
  onClick={() => {
    if (mode === 'form') {
      closeProductForm()
      return
    }

    setAuthorMenuOpen(true)
  }}
  className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--shadow-text-primary)] active:bg-[var(--shadow-bg-soft)]"
>
  <i className={`fa-solid ${mode === 'form' ? 'fa-chevron-left' : 'fa-bars'} text-[16px]`} />
</button>
          <div className="text-[16px] font-black text-[var(--shadow-text-primary)]">
            {mode === 'form' ? (editingProduct ? storeText('editProduct') : storeText('addProduct')) : storeText('store')}
          </div>

          <button
            type="button"
            onClick={openAddProductForm}
            className={`flex h-10 w-10 items-center justify-center rounded-full bg-[#111827] text-white shadow-sm ${mode === 'form' ? 'invisible' : ''}`}
          >
            <i className="fa-solid fa-plus text-[14px]" />
          </button>
        </div>
      </div>

      {mode === 'form' ? (
        <AddProductPage
          categories={categories}
          productToEdit={editingProduct}
          onBack={closeProductForm}
          onSave={saveProduct}
          onNotify={showStoreToast}
        />
      ) : (
        <StoreManagerHome
          promotion={promotion}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          activeType={activeType}
          setActiveType={setActiveType}
          filteredProducts={filteredProducts}
          products={products}
          recordQuery={recordQuery}
          setRecordQuery={setRecordQuery}
          recordFilter={recordFilter}
          setRecordFilter={setRecordFilter}
          recordSearch={recordSearch}
          productTotal={productTotal}
          productHasNext={productHasNext}
          productLoadingMore={productLoadingMore}
          productRefreshing={productRefreshing}
          onLoadMoreProducts={loadMoreProducts}
          onLoadCategories={loadCategories}
          storeAccountId={storeAccountId}
          categories={categories}
          newCategory={newCategory}
          setNewCategory={setNewCategory}
          addCategory={addCategory}
          onAddProduct={openAddProductForm}
          onEditProduct={handleEditProduct}
          onDeleteProduct={handleDeleteProduct}
          loading={loading}
          localError={localError}
          storeCategories={storeCategories}
          categoryError={categoryError}
          categorySaving={categorySaving}
          editingCategoryId={editingCategoryId}
          editingCategoryName={editingCategoryName}
          setEditingCategoryName={setEditingCategoryName}
          startEditCategory={startEditCategory}
          cancelEditCategory={cancelEditCategory}
          saveEditCategory={saveEditCategory}
          handleDeleteCategory={handleDeleteCategory}
          handleToggleHideCategory={handleToggleHideCategory}
          moveCategory={moveCategory}
          saveCategoryOrder={saveCategoryOrder}
          orderSummary={orderSummary}
          orders={orders}
          orderPage={orderPage}
          setOrderPage={setOrderPage}
          orderLoading={orderLoading}
          orderPagination={orderPagination}
          onRefreshOrders={() => loadOrderReport({ silent: false, force: true })}
          orderType={orderType}
          setOrderType={setOrderType}
          orderPrepareFilter={orderPrepareFilter}
          setOrderPrepareFilter={setOrderPrepareFilter}
          orderSearchDraft={orderSearchDraft}
          setOrderSearchDraft={setOrderSearchDraft}
          setOrderSearchQuery={setOrderSearchQuery}
          onMarkOrderPreparing={handleMarkOrderPreparing}
          orderActionLoadingId={orderActionLoadingId}
        />
      )}
    </div>
  )
}


export async function getPublicAuthorPage(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const userId = getOptionalUserId(req)
    const ageAccess = await getReaderAgeAccess(req)

    if (!pageUsername) {
      return res.status(400).json({
        ok: false,
        message: 'Page username is required',
      })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .select('*')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const isOwner = Boolean(userId) && String(data.user_id) === String(userId)
    const canViewAdultStories = isOwner || ageAccess.can_view_adult_stories
    const includeWorks = String(req.query.include_works ?? '1') !== '0'

    let worksRequest
    if (includeWorks) {
      worksRequest = getAuthorPageWorks(data.id, canViewAdultStories)
    } else {
      let countQuery = supabase
        .from('stories')
        .select('id', { count: 'exact', head: true })
        .eq('author_id', data.id)
        .eq('status', 'published')
        .is('deleted_at', null)

      worksRequest = applyAdultStoryVisibility(countQuery, {
        can_view_adult_stories: canViewAdultStories,
      })
    }

    const [isFollowing, worksOrCount] = await Promise.all([
      getFollowStatus(data.id, userId),
      worksRequest,
    ])

    if (!includeWorks && worksOrCount.error) throw worksOrCount.error

    const works = includeWorks ? worksOrCount : []
    const totalStories = includeWorks
      ? works.length
      : Number(worksOrCount.count || 0)

    if (!isOwner) {
      await incrementAuthorPageAnalytics(data.id, 'page_views')
    }

    return res.status(200).json({
      ok: true,
      author_page: publicAuthorPage({
        ...data,
        total_stories: totalStories,
      }),
      is_following: isFollowing,
      total_followers: Number(data.total_followers || 0),
      works,
    })
  } catch (error) {
    console.error('GET PUBLIC AUTHOR PAGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch author page',
      error: error.message,
    })
  }
}


export async function getAuthorPageWorksPaginated(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 10))
    const beforeId = String(req.query.before_id || '').trim()
    const includeTotal = req.query.include_total === '1' && !beforeId

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    if (beforeId && !/^[a-zA-Z0-9_-]{1,100}$/.test(beforeId)) {
      return res.status(400).json({ ok: false, message: 'Invalid pagination cursor' })
    }

    const { data: authorPage, error: authorError } = await supabase
      .from('author_pages')
      .select('id, user_id')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (authorError) throw authorError
    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const userId = getOptionalUserId(req)
    const ageAccess = await getReaderAgeAccess(req)
    const canViewAdultStories = Boolean(
      (userId && String(userId) === String(authorPage.user_id)) ||
      ageAccess.can_view_adult_stories
    )

    let anchor = null
    if (beforeId) {
      let anchorQuery = supabase
        .from('stories')
        .select('id, updated_at')
        .eq('id', beforeId)
        .eq('author_id', authorPage.id)
        .eq('status', 'published')
        .is('deleted_at', null)

      anchorQuery = applyAdultStoryVisibility(anchorQuery, {
        can_view_adult_stories: canViewAdultStories,
      })

      const { data, error } = await anchorQuery.maybeSingle()
      if (error) throw error
      if (!data?.updated_at || Number.isNaN(new Date(data.updated_at).getTime())) {
        return res.status(400).json({ ok: false, message: 'Pagination cursor no longer available' })
      }
      anchor = data
    }

    let worksQuery = supabase
      .from('stories')
      .select(
        'id, author_id, user_id, title, story_language, main_genre, story_status, tags, description, is_adult, cover_url, status, access_type, total_episodes, total_views, total_likes, total_comments, created_at, updated_at',
        includeTotal ? { count: 'exact' } : {}
      )
      .eq('author_id', authorPage.id)
      .eq('status', 'published')
      .is('deleted_at', null)

    worksQuery = applyAdultStoryVisibility(worksQuery, {
      can_view_adult_stories: canViewAdultStories,
    })

    if (anchor) {
      const timestamp = new Date(anchor.updated_at).toISOString()
      worksQuery = worksQuery.or(
        `updated_at.lt.${timestamp},and(updated_at.eq.${timestamp},id.lt.${beforeId})`
      )
    }

    const { data: rows, error, count } = await worksQuery
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (error) throw error

    const visibleRows = (rows || []).slice(0, limit)
    const hasMore = (rows || []).length > limit
    const lastWork = visibleRows[visibleRows.length - 1]

    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      works: visibleRows.map(publicAuthorWork),
      has_more: hasMore,
      next_before_id: hasMore ? lastWork?.id || null : null,
      total_count: includeTotal ? Number(count || 0) : null,
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE WORKS PAGINATED ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load author works',
      error: error.message,
    })
  }
}


export async function getTopAuthorPages(req, res) {
  try {
    const rawLimit = Number(req.query.limit || 20)
    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.isFinite(rawLimit)
          ? Math.floor(rawLimit)
          : 20
      )
    )

    const maxResults = 100
    const maxPage = Math.max(
      1,
      Math.ceil(maxResults / limit)
    )
    const rawPage = Number(req.query.page || 1)
    const page = Math.min(
      maxPage,
      Math.max(
        1,
        Number.isFinite(rawPage)
          ? Math.floor(rawPage)
          : 1
      )
    )

    const offset = (page - 1) * limit
    const canHaveMore =
      offset + limit < maxResults
    const rangeEnd = canHaveMore
      ? offset + limit
      : offset + limit - 1

    const userId = getOptionalUserId(req)
    const ageAccess = await getReaderAgeAccess(req)

    const { data: pageRows, error } = await supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, status, total_stories, total_followers, created_at, updated_at'
      )
      .eq('status', 'active')
      .order('total_followers', { ascending: false })
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, rangeEnd)

    if (error) throw error

    const hasMore =
      canHaveMore &&
      (pageRows || []).length > limit

    const pages = (pageRows || []).slice(
      0,
      limit
    )

    const authorPageIds = pages
      .map((authorPage) => authorPage.id)
      .filter(Boolean)

    const storyCountByAuthorId = new Map()
    const followingPageIds = new Set()

    if (authorPageIds.length) {
      let storiesQuery = supabase
        .from('stories')
        .select('author_id')
        .in('author_id', authorPageIds)
        .eq('status', 'published')
        .is('deleted_at', null)

      storiesQuery = applyAdultStoryVisibility(
        storiesQuery,
        ageAccess
      )

      const {
        data: stories,
        error: storiesError,
      } = await storiesQuery

      if (storiesError) throw storiesError

      for (const story of stories || []) {
        storyCountByAuthorId.set(
          story.author_id,
          Number(
            storyCountByAuthorId.get(
              story.author_id
            ) || 0
          ) + 1
        )
      }

      if (userId) {
        const {
          data: follows,
          error: followsError,
        } = await supabase
          .from('author_page_follows')
          .select('author_page_id')
          .in('author_page_id', authorPageIds)
          .eq('follower_user_id', userId)

        if (followsError) throw followsError

        for (const follow of follows || []) {
          followingPageIds.add(
            follow.author_page_id
          )
        }
      }
    }

    const authorPages = pages.map(
      (authorPage, index) => ({
        ...publicAuthorPage({
          ...authorPage,
          total_stories: Number(
            storyCountByAuthorId.get(
              authorPage.id
            ) || 0
          ),
        }),
        rank: offset + index + 1,
        is_following:
          followingPageIds.has(
            authorPage.id
          ),
        is_owner: Boolean(
          userId &&
          String(authorPage.user_id) ===
            String(userId)
        ),
      })
    )

    return res.status(200).json({
      ok: true,
      author_pages: authorPages,
      page,
      limit,
      has_more: hasMore,
      max_results: maxResults,
    })
  } catch (error) {
    console.error(
      'GET TOP AUTHOR PAGES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load top authors',
      error: error.message,
    })
  }
}

export async function getAuthorPageFollowers(req, res) {
  try {
    const currentUserId = getOptionalUserId(req)
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const sectionValue = String(req.query.section || 'all').trim().toLowerCase()
    const section = ['all', 'top', 'mutual'].includes(sectionValue) ? sectionValue : 'all'

    const rawLimit = Number(req.query.limit || 30)
    const rawOffset = Number(req.query.offset || 0)

    const limit = Math.min(
      30,
      Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 30)
    )

    const offset = Math.max(
      0,
      Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0
    )

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, total_followers')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const isOwner = Boolean(
      currentUserId && String(authorPage.user_id) === String(currentUserId)
    )

    const { count: totalFollowers, error: countError } = await supabase
      .from('author_page_follows')
      .select('id', { count: 'exact', head: true })
      .eq('author_page_id', authorPage.id)

    if (countError) throw countError

    async function buildFollowerItems(followRows = []) {
      const followerIds = [
        ...new Set(followRows.map((item) => item.follower_user_id).filter(Boolean)),
      ]

      if (!followerIds.length) return []

      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, name, username, avatar_url')
        .in('id', followerIds)

      if (usersError) throw usersError

      const usersById = new Map((users || []).map((user) => [user.id, user]))
      const followingUserIds = new Set()

      if (currentUserId) {
        const { data: userFollows, error: userFollowsError } = await supabase
          .from('user_follows')
          .select('following_user_id')
          .eq('follower_user_id', currentUserId)
          .in('following_user_id', followerIds)

        if (userFollowsError) throw userFollowsError

        for (const item of userFollows || []) {
          followingUserIds.add(item.following_user_id)
        }
      }

      return followRows
        .map((item) => {
          const user = usersById.get(item.follower_user_id)

          if (!user) return null

          return {
            id: user.id,
            name: user.name || 'Reader',
            username: user.username || '',
            avatar_url: user.avatar_url || '',
            followed_at: item.created_at,
            is_me: currentUserId ? String(user.id) === String(currentUserId) : false,
            is_following: followingUserIds.has(user.id),
          }
        })
        .filter(Boolean)
    }

    let query = supabase
      .from('author_page_follows')
      .select('follower_user_id, created_at', { count: 'exact' })
      .eq('author_page_id', authorPage.id)

    if (section === 'mutual') {
      if (!currentUserId) {
        return res.status(200).json({
          ok: true,
          section,
          is_owner: isOwner,
          total_followers: Number(totalFollowers || 0),
          total_count: 0,
          limit,
          offset,
          has_more: false,
          followers: [],
        })
      }

      const { data: myFollowingRows, error: myFollowingError } = await supabase
        .from('user_follows')
        .select('following_user_id')
        .eq('follower_user_id', currentUserId)

      if (myFollowingError) throw myFollowingError

      const myFollowingIds = [
        ...new Set((myFollowingRows || []).map((item) => item.following_user_id).filter(Boolean)),
      ]

      if (!myFollowingIds.length) {
        return res.status(200).json({
          ok: true,
          section,
          is_owner: isOwner,
          total_followers: Number(totalFollowers || 0),
          total_count: 0,
          limit,
          offset,
          has_more: false,
          followers: [],
        })
      }

      query = query.in('follower_user_id', myFollowingIds)
    }

    const { data: followRows, count: sectionCount, error: followError } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (followError) throw followError

    const followers = await buildFollowerItems(followRows || [])
    const totalCount = section === 'mutual'
      ? Number(sectionCount || 0)
      : Number(totalFollowers || 0)

    return res.status(200).json({
      ok: true,
      section,
      is_owner: isOwner,
      total_followers: Number(totalFollowers || 0),
      total_count: totalCount,
      limit,
      offset,
      has_more: offset + followers.length < totalCount,
      followers,
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE FOLLOWERS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load followers',
      error: error.message,
    })
  }
}

export async function getAuthorPageReviews(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const userId = getOptionalUserId(req)

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data: reviewRows, error: reviewError } = await supabase
      .from('author_page_reviews')
      .select('id, reviewer_user_id, is_recommended, review_text, status, created_at, updated_at')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(50)

    if (reviewError) throw reviewError

    const reviewerIds = [
      ...new Set(
        (reviewRows || [])
          .map((item) => item.reviewer_user_id)
          .filter(Boolean)
      ),
    ]
    let usersById = new Map()

    if (reviewerIds.length) {
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, name, username, avatar_url')
        .in('id', reviewerIds)

      if (usersError) throw usersError
      usersById = new Map((users || []).map((user) => [user.id, user]))
    }

    const reviews = (reviewRows || []).map((item) => {
      const user = usersById.get(item.reviewer_user_id) || {}

      return {
        id: item.id,
        reviewer_user_id: item.reviewer_user_id,
        reviewer_name: user.name || 'Reader',
        reviewer_username: user.username || '',
        reviewer_avatar_url: user.avatar_url || '',
        is_recommended: item.is_recommended,
        review_text: item.review_text || '',
        created_at: item.created_at,
        updated_at: item.updated_at,
        is_mine: userId
          ? String(item.reviewer_user_id) === String(userId)
          : false,
      }
    })

    const totalCount = reviews.length
    const recommendCount = reviews.filter((item) => item.is_recommended).length
    const recommendPercent = totalCount
      ? Math.round((recommendCount / totalCount) * 100)
      : 0
    const myReview = userId
      ? reviews.find((item) => item.is_mine) || null
      : null

    return res.status(200).json({
      ok: true,
      summary: {
        total_count: totalCount,
        recommend_count: recommendCount,
        recommend_percent: recommendPercent,
      },
      reviews,
      my_review: myReview,
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE REVIEWS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load reviews',
      error: error.message,
    })
  }
}


export async function upsertMyAuthorPageReview(req, res) {
  try {
    const userId = req.user?.user_id
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const isRecommended = req.body.is_recommended !== false
    const reviewText = String(req.body.review_text || '').trim().slice(0, 1000)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

  if (String(authorPage.user_id) === String(userId)) {
  return res.status(400).json({
    ok: false,
    message: 'You cannot review your own author page',
  })
}

    const { data: review, error: reviewError } = await supabase
      .from('author_page_reviews')
      .upsert(
        {
          author_page_id: authorPage.id,
          reviewer_user_id: userId,
          is_recommended: isRecommended,
          review_text: reviewText,
          status: 'active',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'author_page_id,reviewer_user_id' }
      )
      .select(
        'id, reviewer_user_id, is_recommended, review_text, status, created_at, updated_at'
      )
      .single()

    if (reviewError) throw reviewError

    const { data: reviewer, error: reviewerError } = await supabase
      .from('users')
      .select('id, name, username, avatar_url')
      .eq('id', userId)
      .maybeSingle()

    if (reviewerError) throw reviewerError

    const reviewerName =
      reviewer?.name || reviewer?.username || 'A reader'
    const sourceKey =
      `author-page-review:${authorPage.id}:${userId}`

    await deleteAuthorPageNotificationBySourceKeySafely({
      authorPageId: authorPage.id,
      type: 'review',
      sourceKey,
    })

    await createAuthorPageNotificationSafely({
      authorPageId: authorPage.id,
      authorUserId: authorPage.user_id,
      type: 'review',
      title: `${reviewerName} ${
        isRecommended ? 'recommended' : 'did not recommend'
      } your page`,
      message: reviewText,
      targetUrl: `/author/page/${authorPage.page_username}`,
      sourceKey,
      metadata: {
        review_id: review.id,
        is_recommended: isRecommended,
        reviewer_id: userId,
        reviewer_name: reviewerName,
        reviewer_username: reviewer?.username || '',
        reviewer_avatar_url: reviewer?.avatar_url || '',
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Review saved',
      review,
    })
  } catch (error) {
    console.error('UPSERT AUTHOR PAGE REVIEW ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to save review',
      error: error.message,
    })
  }
}


export async function deleteMyAuthorPageReview(req, res) {
  try {
    const userId = req.user?.user_id
    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { error: reviewError } = await supabase
      .from('author_page_reviews')
      .update({
        status: 'deleted',
        updated_at: new Date().toISOString(),
      })
      .eq('author_page_id', authorPage.id)
      .eq('reviewer_user_id', userId)

    if (reviewError) throw reviewError

    await deleteAuthorPageNotificationBySourceKeySafely({
      authorPageId: authorPage.id,
      type: 'review',
      sourceKey: `author-page-review:${authorPage.id}:${userId}`,
    })

    return res.status(200).json({
      ok: true,
      message: 'Review removed',
    })
  } catch (error) {
    console.error('DELETE AUTHOR PAGE REVIEW ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to remove review',
      error: error.message,
    })
  }
}


export async function followAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id
    const pageUsername = normalizePageUsername(
      req.params.pageUsername
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!pageUsername) {
      return res.status(400).json({
        ok: false,
        message: 'Page username is required',
      })
    }

    const { data: authorPage, error: pageError } =
      await supabase
        .from('author_pages')
        .select('*')
        .eq('page_username', pageUsername)
        .eq('status', 'active')
        .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    

    const sourcePostId = String(
  req.body?.source_post_id || ''
).trim()

let attributedPostId = null

if (sourcePostId) {
  const {
    data: sourcePost,
    error: sourcePostError,
  } = await supabase
    .from('author_page_posts')
    .select('id')
    .eq('id', sourcePostId)
    .eq('author_page_id', authorPage.id)
    .eq('status', 'active')
    .maybeSingle()

  if (sourcePostError) throw sourcePostError

  if (!sourcePost) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid source post',
    })
  }

  attributedPostId = String(sourcePost.id)
}

const alreadyFollowing = await getFollowStatus(
  authorPage.id,
  userId
)

    let followCreated = false

    if (!alreadyFollowing) {
      const { error: followError } = await supabase
        .from('author_page_follows')
        .insert({
  author_page_id: authorPage.id,
  follower_user_id: userId,
  source_post_id: attributedPostId,
})

      if (followError && followError.code !== '23505') {
        throw followError
      }

      followCreated = !followError
    }

    if (followCreated) {
      await incrementAuthorPageAnalytics(
        authorPage.id,
        'new_followers'
      )
    }

    if (
  followCreated &&
  String(authorPage.user_id) !==
    String(userId)
) {
  const { data: reader, error: readerError } = await supabase
    .from('users')
    .select('id, name, username, avatar_url')
    .eq('id', userId)
    .maybeSingle()

  if (readerError) throw readerError
  const readerName = reader?.name || reader?.username || 'A reader'

        await createAuthorPageNotificationSafely({
    authorPageId: authorPage.id,
    authorUserId: authorPage.user_id,
    type: 'follower',
    title: `${readerName} followed your author page`,
    targetUrl: `/author/page/${authorPage.page_username}/followers`,
    sourceKey: `author-page-follow:${authorPage.id}:${userId}`,

              metadata: {
      reader_id: userId, reader_name: readerName,
      reader_username: reader?.username || '',
      reader_avatar_url: reader?.avatar_url || '',
    },
  })
}

    const updatedPage = await syncAuthorFollowerCount(
      authorPage.id
    )

    invalidateMyAuthorPageCache(
      updatedPage.user_id
    )

    return res.status(200).json({
      ok: true,
      message: 'Author page followed',
      author_page: publicAuthorPage(updatedPage),
      is_following: true,
      total_followers: Number(
        updatedPage.total_followers || 0
      ),
    })
  } catch (error) {
    console.error('FOLLOW AUTHOR PAGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to follow author page',
      error: error.message,
    })
  }
}

export async function unfollowAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id
    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { error: deleteError } = await supabase
      .from('author_page_follows')
      .delete()
      .eq('author_page_id', authorPage.id)
      .eq('follower_user_id', userId)

    if (deleteError) throw deleteError

    await deleteAuthorPageNotificationBySourceKeySafely({
  authorPageId: authorPage.id,
  type: 'follower',
  sourceKey: `author-page-follow:${authorPage.id}:${userId}`,
})

    const updatedPage = await syncAuthorFollowerCount(authorPage.id)

    invalidateMyAuthorPageCache(
      updatedPage.user_id
    )

    return res.status(200).json({
      ok: true,
      message: 'Author page unfollowed',
      author_page: publicAuthorPage(updatedPage),
      is_following: false,
      total_followers: Number(updatedPage.total_followers || 0),
    })
  } catch (error) {
    console.error('UNFOLLOW AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to unfollow author page', error: error.message })
  }
}

export async function getFollowedAuthorPages(req, res) {
  try {
    const userId = req.user?.user_id
    const q = String(req.query.q || '').trim()
    const sort = String(req.query.sort || 'recent')
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)))
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const { data: followRows, error: followError, count } = await supabase
      .from('author_page_follows')
      .select('author_page_id, created_at', { count: 'exact' })
      .eq('follower_user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (followError) throw followError

    const followedAtByPageId = new Map((followRows || []).map((item) => [item.author_page_id, item.created_at]))
    const authorPageIds = (followRows || []).map((item) => item.author_page_id).filter(Boolean)

    if (!authorPageIds.length) {
      return res.status(200).json({
        ok: true,
        author_pages: [],
        page,
        limit,
        total: Number(count || 0),
        has_next: false,
      })
    }

    let query = supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, status, total_stories, total_followers, created_at, updated_at')
      .in('id', authorPageIds)
      .eq('status', 'active')

    if (q) {
      query = query.or(`page_name.ilike.%${q}%,page_username.ilike.%${q}%`)
    }

    if (sort === 'popular') {
      query = query.order('total_followers', { ascending: false })
    } else if (sort === 'updated') {
      query = query.order('updated_at', { ascending: false })
    } else {
      query = query.order('created_at', { ascending: false })
    }

    const { data: pages, error: pagesError } = await query

    if (pagesError) throw pagesError

    const authorPages = (pages || []).map((pageItem) => ({
      ...publicAuthorPage(pageItem),
      followed_at: followedAtByPageId.get(pageItem.id) || null,
      is_following: true,
    }))

    return res.status(200).json({
      ok: true,
      author_pages: authorPages,
      page,
      limit,
      total: Number(count || 0),
      has_next: to + 1 < Number(count || 0),
    })
  } catch (error) {
    console.error('GET FOLLOWED AUTHOR PAGES ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load followed authors',
      error: error.message,
    })
  }
}


export async function createAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const pageName = String(req.body.page_name || req.body.pageName || '').trim()
    const pageUsername = normalizePageUsername(req.body.page_username || req.body.pageUsername)
    const bio = String(req.body.bio || '').trim() || null

    if (!pageName || !pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page name and page username are required' })
    }

    if (pageName.length < 2) {
      return res.status(400).json({ ok: false, message: 'Page name must be at least 2 characters' })
    }

    if (pageUsername.length < 3) {
      return res.status(400).json({ ok: false, message: 'Page username must be at least 3 characters' })
    }

    if (!isValidPageUsername(pageUsername)) {
      return res.status(400).json({ ok: false, message: 'Page username can only use letters, numbers, and underscore' })
    }

    const { data: existingPage, error: existingError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    if (existingPage) {
      return res.status(200).json({ ok: true, message: 'Author page already exists', author_page: publicAuthorPage(existingPage) })
    }

    const { data: usernameTaken, error: usernameError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .maybeSingle()

    if (usernameError) throw usernameError

    if (usernameTaken) {
      return res.status(409).json({ ok: false, message: 'Page username already exists' })
    }

    const { data: createdPage, error: createError } = await supabase
      .from('author_pages')
      .insert({
        user_id: userId,
        page_name: pageName,
        page_username: pageUsername,
        page_slug: pageUsername,
        bio,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (createError) throw createError

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({ is_author: true, updated_at: new Date().toISOString() })
      .eq('id', userId)

    if (userUpdateError) throw userUpdateError

    return res.status(201).json({ ok: true, message: 'Author page created successfully', author_page: publicAuthorPage(createdPage) })
  } catch (error) {
    console.error('CREATE AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create author page', error: error.message })
  }
}

export async function updateAuthorAvatar(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || '').trim()

    if (!avatarUrl) {
      return res.status(400).json({ ok: false, message: 'Avatar URL is required' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({ ok: true, message: 'Author profile photo updated', author_page: publicAuthorPage(data) })
  } catch (error) {
    console.error('UPDATE AUTHOR AVATAR ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author profile photo', error: error.message })
  }
}

export async function updateAuthorProfileImages(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || '').trim()
    const coverUrl = String(req.body.cover_url || req.body.coverUrl || '').trim()
    const slideUrls = Array.isArray(req.body.slide_urls)
    ? req.body.slide_urls.filter(Boolean).map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
    : null

   if (!avatarUrl && !coverUrl && slideUrls === null) {
  return res.status(400).json({ ok: false, message: 'Avatar URL, cover URL, or slide URLs are required' })
}

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (avatarUrl) updates.avatar_url = avatarUrl
    if (coverUrl) updates.cover_url = coverUrl
    if (slideUrls !== null) updates.slide_urls = slideUrls

    const { data, error } = await supabase
      .from('author_pages')
      .update(updates)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Author profile images updated',
      author_page: publicAuthorPage(data),
    })
  } catch (error) {
    console.error('UPDATE AUTHOR PROFILE IMAGES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author profile images', error: error.message })
  }
}

export async function updateMyAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const pageName = String(req.body.page_name || req.body.pageName || '').trim()
    const pageUsername = normalizePageUsername(req.body.page_username || req.body.pageUsername)
    const bio = String(req.body.bio || '').trim()
    const profileDetails =
    req.body.profile_details &&
    typeof req.body.profile_details === 'object' &&
    !Array.isArray(req.body.profile_details)
    ? req.body.profile_details
    : null

    if (!pageName || !pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page name and page username are required' })
    }

    if (pageName.length < 2) {
      return res.status(400).json({ ok: false, message: 'Page name must be at least 2 characters' })
    }

    if (pageUsername.length < 3) {
      return res.status(400).json({ ok: false, message: 'Page username must be at least 3 characters' })
    }

    if (!isValidPageUsername(pageUsername)) {
      return res.status(400).json({ ok: false, message: 'Page username can only use letters, numbers, and underscore' })
    }

    const { data: currentPage, error: currentError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!currentPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const pageNameChanged = pageName !== String(currentPage.page_name || '').trim()
    const pageUsernameChanged = pageUsername !== normalizePageUsername(currentPage.page_username)

    if (pageUsernameChanged) {
      const { data: usernameOwner, error: usernameError } = await supabase
        .from('author_pages')
        .select('id')
        .eq('page_username', pageUsername)
        .neq('user_id', userId)
        .maybeSingle()

      if (usernameError) throw usernameError

      if (usernameOwner) {
        return res.status(409).json({ ok: false, message: 'Page username already exists' })
      }
    }

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (pageNameChanged) updates.page_name = pageName
    if (pageUsernameChanged) {
      updates.page_username = pageUsername
      updates.page_slug = pageUsername
    }
    if (bio !== String(currentPage.bio || '').trim()) updates.bio = bio
    if (profileDetails) {
      updates.profile_details = {
        ...(currentPage.profile_details || {}),
        ...profileDetails,
      }
    }

    const { data: updatedPage, error: updateError } = await supabase
      .from('author_pages')
      .update(updates)
      .eq('user_id', userId)
      .select()
      .single()

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      message: 'Author page updated',
      author_page: publicAuthorPage(updatedPage),
    })
  } catch (error) {
    if (error?.message === 'AUTHOR_PAGE_NAME_COOLDOWN') {
  return res.status(409).json({
    ok: false,
    message: 'You can change your Page name once every 14 days after the first 3 changes.',
    next_change_at: error.details?.replace(/^next_change_at=/, '') || null,
  })
}
    console.error('UPDATE MY AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author page', error: error.message })
  }
}

