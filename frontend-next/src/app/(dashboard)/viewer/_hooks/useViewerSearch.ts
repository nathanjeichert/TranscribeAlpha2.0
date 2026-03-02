import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewerTranscript } from '@/utils/transcriptFormat'

const PROGRAMMATIC_SCROLL_RESET_MS = 700

interface UseViewerSearchParams {
  transcript: ViewerTranscript | null
  lineRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  programmaticScrollRef: React.MutableRefObject<boolean>
  initialHighlightLineId?: string | null
}

export function useViewerSearch({
  transcript,
  lineRefs,
  programmaticScrollRef,
  initialHighlightLineId,
}: UseViewerSearchParams) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)
  const [highlightLineId, setHighlightLineId] = useState<string | null>(initialHighlightLineId ?? null)

  // Keep highlight in sync if the initial value changes (URL param on navigation)
  const initializedRef = useRef(false)
  useEffect(() => {
    if (!initializedRef.current && initialHighlightLineId) {
      setHighlightLineId(initialHighlightLineId)
      initializedRef.current = true
    }
  }, [initialHighlightLineId])

  const searchMatches = useMemo(() => {
    if (!transcript || !searchQuery.trim()) return [] as string[]
    const lower = searchQuery.toLowerCase()
    return transcript.lines
      .filter((line) => {
        const text = (line.rendered_text || line.text || '').toLowerCase()
        const speaker = (line.speaker || '').toLowerCase()
        return text.includes(lower) || speaker.includes(lower)
      })
      .map((line) => line.id)
  }, [transcript, searchQuery])

  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches])

  const currentSearchLineId = searchMatches.length > 0
    ? searchMatches[((searchCursor % searchMatches.length) + searchMatches.length) % searchMatches.length]
    : null

  // Reset cursor when query changes
  useEffect(() => {
    setSearchCursor(0)
  }, [searchQuery])

  const goToSearchResult = useCallback((direction: 1 | -1) => {
    if (!searchMatches.length) return
    setSearchCursor((prev) => {
      const next = (prev + direction + searchMatches.length) % searchMatches.length
      const lineId = searchMatches[next]

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const target = lineRefs.current[lineId]
          if (!target) return
          programmaticScrollRef.current = true
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
          window.setTimeout(() => {
            programmaticScrollRef.current = false
          }, PROGRAMMATIC_SCROLL_RESET_MS)
        })
      })
      return next
    })
  }, [lineRefs, programmaticScrollRef, searchMatches])

  return {
    searchQuery,
    setSearchQuery,
    searchMatches,
    searchMatchSet,
    searchCursor,
    currentSearchLineId,
    highlightLineId,
    setHighlightLineId,
    goToSearchResult,
  }
}
