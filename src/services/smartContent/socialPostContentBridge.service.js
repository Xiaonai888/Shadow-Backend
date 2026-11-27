import { normalizePromotionLanguage, evaluatePromotion } from '../telegramPromotion/policy.service.js'
import { isRecommendationEligible, matchesRecommendationTopic } from '../telegramPromotion/recommendationV2.service.js'
import { extractPromotionText, truncatePromotionText } from '../telegramPromotion/extractor.service.js'
import { updateStatusV2 } from '../telegramPromotion/messageV2.service.js'
import { selectMangaPreview } from '../telegramPromotion/mangaPreviewV2.service.js'
import { chooseSharedCaption } from './telegramContentBridge.service.js'
import { createSharedPostContent } from './sharedPostContent.service.js'

export const sharedSocialPostContent = createSharedPostContent({normalizeLanguage:normalizePromotionLanguage,evaluatePromotion,isEligible:isRecommendationEligible,matchesTopic:matchesRecommendationTopic,extractText:extractPromotionText,truncateText:truncatePromotionText,chooseCaption:chooseSharedCaption,updateStatus:updateStatusV2,selectMangaPreview})
