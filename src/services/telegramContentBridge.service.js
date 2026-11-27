import { normalizePromotionLanguage } from '../telegramPromotion/policy.service.js'
import { GROUP_TOPICS, chooseGroupCaption, sharedStoryTags } from '../telegramPromotion/captionLibraryV2.service.js'
import { isRecommendationEligible, matchesRecommendationTopic, selectRecommendationGroup } from '../telegramPromotion/recommendationV2.service.js'
import { selectSoloV2 } from '../telegramPromotion/optionalV2.service.js'
import { createSharedSelection } from './sharedSelection.service.js'
import { createSharedCaption } from './sharedCaption.service.js'

export const sharedSelection = createSharedSelection({ normalizeLanguage: normalizePromotionLanguage, groupTopics: GROUP_TOPICS, isEligible: isRecommendationEligible, matchesTopic: matchesRecommendationTopic, selectGroup: selectRecommendationGroup, selectSolo: selectSoloV2 })
export const chooseSharedCaption = createSharedCaption({ chooseLegacyCaption: chooseGroupCaption, sharedStoryTags, normalizeLanguage: normalizePromotionLanguage })
