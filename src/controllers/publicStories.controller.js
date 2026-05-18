import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

function uniqueStories(stories) {
  const map = new Map()

  stories.forEach((story) => {
    if (story?.id && !map.has(story.id)) {
      map.set(story.id, story)
    }
  })

  return Array.from(map.values())
}

function EmptyCard({ title, text, icon }) {
  return (
    <div className="rounded-[22px] bg-[#f8fafc] p-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white text-[#111827] shadow-sm ring-1 ring-black/5">
        <i className={`${icon} text-[18px]`} />
      </div>
      <div className="mt-3 text-[14px] font-black text-[#111827]">{title}</div>
      <div className="mt-1 text-[12px] font-semibold leading-5 text-[#98a2b3]">{text}</div>
    </div>
  )
}

function BookCard({ story, onClick }) {
  return (
    <button type="button" onClick={onClick} className="min-w-0 text-left active:scale-[0.99]">
      <div className="aspect-[2/3] w-full overflow-hidden rounded-[14px] bg-[#eef1f5]">
        {story.cover_url ? (
          <img
            src={story.cover_url}
            alt={story.title || 'Story cover'}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[#98a2b3]">
            <i className="fa-regular fa-bookmark text-[20px]" />
          </div>
        )}
      </div>

      <h3 className="mt-2 line-clamp-2 text-[13px] font-black leading-4 text-[#111827]">
        {story.title || 'Untitled Story'}
      </h3>

      <p className="mt-0.5 line-clamp-1 text-[12px] font-semibold text-[#98a2b3]">
        {story.main_genre || 'Story'}
      </p>
    </button>
  )
}

function StoryGrid({ stories, emptyTitle, emptyText, emptyIcon, onOpenStory }) {
  if (!stories.length) {
    return <EmptyCard icon={emptyIcon} title={emptyTitle} text={emptyText} />
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      {stories.slice(0, 3).map((item) => (
        <BookCard key={item.id} story={item} onClick={() => onOpenStory(item.id)} />
      ))}
    </div>
  )
}

export default function RecommendationSection({ story }) {
  const navigate = useNavigate()
  const [authorStories, setAuthorStories] = useState([])
  const [topStories, setTopStories] = useState([])
  const [similarStories, setSimilarStories] = useState([])
  const [loading, setLoading] = useState(true)

  const authorName =
    story?.author_page?.page_name ||
    story?.authorPage?.page_name ||
    story?.author?.page_name ||
    story?.author_name ||
    'Author'

  useEffect(() => {
    let ignore = false

    async function loadRecommendations() {
      if (!story?.id) return

      setLoading(true)

      try {
        const authorUrl = story.author_id
          ? `${API_BASE_URL}/api/public/stories?authorId=${encodeURIComponent(story.author_id)}&exclude=${encodeURIComponent(story.id)}&sort=popular&limit=3`
          : ''

        const similarUrl = story.main_genre
          ? `${API_BASE_URL}/api/public/stories?genre=${encodeURIComponent(story.main_genre)}&exclude=${encodeURIComponent(story.id)}&sort=popular&limit=6`
          : ''

        const topUrl = `${API_BASE_URL}/api/public/stories?sort=popular&exclude=${encodeURIComponent(story.id)}&limit=6`

        const [authorResponse, similarResponse, topResponse] = await Promise.all([
          authorUrl ? fetch(authorUrl) : Promise.resolve(null),
          similarUrl ? fetch(similarUrl) : Promise.resolve(null),
          fetch(topUrl),
        ])

        const authorData = authorResponse ? await authorResponse.json().catch(() => ({})) : {}
        const similarData = similarResponse ? await similarResponse.json().catch(() => ({})) : {}
        const topData = await topResponse.json().catch(() => ({}))

        const nextAuthorStories = Array.isArray(authorData.stories) ? authorData.stories.slice(0, 3) : []
        const nextTopStories = Array.isArray(topData.stories) ? topData.stories : []
        const sameGenreStories = Array.isArray(similarData.stories) ? similarData.stories : []
        const filledSimilarStories = uniqueStories([...sameGenreStories, ...nextTopStories]).slice(0, 3)

        if (ignore) return

        setAuthorStories(nextAuthorStories)
        setTopStories(nextTopStories.slice(0, 3))
        setSimilarStories(filledSimilarStories)
      } catch {
        if (ignore) return

        setAuthorStories([])
        setTopStories([])
        setSimilarStories([])
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    loadRecommendations()

    return () => {
      ignore = true
    }
  }, [story?.author_id, story?.id, story?.main_genre])

  const authorSectionStories = useMemo(() => {
    return authorStories.length ? authorStories : topStories
  }, [authorStories, topStories])

  const handleOpenStory = (storyId) => {
    if (!storyId) return
    navigate(`/story/${storyId}`)
  }

  return (
    <section className="mt-2 space-y-0 sm:mt-4 sm:space-y-4">
      <div className="bg-white p-4 sm:rounded-[28px] sm:p-5 sm:shadow-sm sm:ring-1 sm:ring-black/5">
        <div className="mb-3">
          <h2 className="text-[18px] font-black text-[#111827]">Other work by {authorName}</h2>
        </div>

        {loading ? (
          <EmptyCard
            icon="fa-solid fa-spinner fa-spin"
            title="Loading stories..."
            text="Please wait while recommendations are loading."
          />
        ) : (
          <StoryGrid
            stories={authorSectionStories}
            emptyIcon="fa-solid fa-pen-nib"
            emptyTitle="No other stories yet"
            emptyText="This author does not have more published stories yet."
            onOpenStory={handleOpenStory}
          />
        )}
      </div>

      <div className="bg-white p-4 sm:rounded-[28px] sm:p-5 sm:shadow-sm sm:ring-1 sm:ring-black/5">
        <div className="mb-3">
          <h2 className="text-[18px] font-black text-[#111827]">You Might Like</h2>
        </div>

        {loading ? (
          <EmptyCard
            icon="fa-solid fa-spinner fa-spin"
            title="Loading similar stories..."
            text="Please wait while similar stories are loading."
          />
        ) : (
          <StoryGrid
            stories={similarStories}
            emptyIcon="fa-regular fa-compass"
            emptyTitle="No similar stories yet"
            emptyText="Similar stories will appear after more published stories are available."
            onOpenStory={handleOpenStory}
          />
        )}
      </div>
    </section>
  )
}
