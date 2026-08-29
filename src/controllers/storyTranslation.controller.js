import {
  StoryTranslationError,
  translateStoryContent,
} from '../services/storyTranslation.service.js'

export async function translateStory(req, res) {
  try {
    const content = String(req.body?.content || '')
    const targetLanguage = String(
      req.body?.target_language ||
      req.body?.targetLanguage ||
      ''
    )

    const result = await translateStoryContent({
      content,
      targetLanguage,
    })

    return res.status(200).json({
      ok: true,
      target_language: targetLanguage.trim().toLowerCase(),
      translated_content: result.translatedContent,
      cached: result.cached,
    })
  } catch (error) {
    console.error('STORY_TRANSLATION_ERROR:', error)

    if (error instanceof StoryTranslationError) {
      return res.status(error.statusCode).json({
        ok: false,
        code: error.code,
        message:
          error.statusCode >= 500
            ? 'Translation is temporarily unavailable'
            : error.message,
      })
    }

    return res.status(500).json({
      ok: false,
      code: 'TRANSLATION_FAILED',
      message: 'Translation is temporarily unavailable',
    })
  }
}
