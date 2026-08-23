import { supabase } from '../config/supabase.js'

const HOME_SLIDE_SECTION_KEYS = [
  'shadow_spotlight',
  'editor_weekly_picks',
  'event_perks_hub',
]

export async function getHomeSlidesBatch(req, res) {
  try {
    const { data, error } = await supabase
      .from('slides')
      .select('*')
      .in('section_key', HOME_SLIDE_SECTION_KEYS)
      .eq('is_active', true)
      .order('section_key', { ascending: true })
      .order('order_index', { ascending: true })
      .order('updated_at', {
        ascending: false,
        nullsFirst: false,
      })
      .order('created_at', { ascending: false })

    if (error) throw error

    const sections = Object.fromEntries(
      HOME_SLIDE_SECTION_KEYS.map((key) => [key, []])
    )

    for (const slide of data || []) {
      const key = String(slide?.section_key || '')

      if (sections[key]) {
        sections[key].push(slide)
      }
    }

    res.set(
      'Cache-Control',
      'public, max-age=60, stale-while-revalidate=300'
    )

    return res.status(200).json({
      ok: true,
      sections,
    })
  } catch (error) {
    console.error(
      'GET HOME SLIDES BATCH ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch home slides',
    })
  }
}
