import React, { useCallback, useMemo, useState } from 'react'
import { EditorLine } from '../editorTypes'

interface UseEditorSearchParams {
  lines: EditorLine[]
  scrollToLine: (lineId: string) => void
  programmaticScrollRef: React.MutableRefObject<boolean>
  setManualScrollOverride: (v: boolean) => void
}

export function useEditorSearch({
  lines,
  scrollToLine,
  programmaticScrollRef: _programmaticScrollRef,
  setManualScrollOverride,
}: UseEditorSearchParams) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<string[]>([])
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(-1)

  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches])

  const performSearch = useCallback(
    (query: string) => {
      setSearchQuery(query)
      if (!query.trim()) {
        setSearchMatches([])
        setSearchCurrentIndex(-1)
        return
      }
      const lowerQuery = query.toLowerCase()
      const matches = lines
        .filter((line) => {
          const text = (line.text || '').toLowerCase()
          const speaker = (line.speaker || '').toLowerCase()
          return text.includes(lowerQuery) || speaker.includes(lowerQuery)
        })
        .map((line) => line.id)
      setSearchMatches(matches)
      if (matches.length > 0) {
        setSearchCurrentIndex(0)
        setManualScrollOverride(true)
        scrollToLine(matches[0])
      } else {
        setSearchCurrentIndex(-1)
      }
    },
    [lines, scrollToLine, setManualScrollOverride],
  )

  const goToSearchResult = useCallback(
    (direction: 'next' | 'prev') => {
      if (searchMatches.length === 0) return
      let newIndex = searchCurrentIndex
      if (direction === 'next') {
        newIndex = (searchCurrentIndex + 1) % searchMatches.length
      } else {
        newIndex = (searchCurrentIndex - 1 + searchMatches.length) % searchMatches.length
      }
      setSearchCurrentIndex(newIndex)
      const lineId = searchMatches[newIndex]
      setManualScrollOverride(true)
      scrollToLine(lineId)
    },
    [searchMatches, searchCurrentIndex, scrollToLine, setManualScrollOverride],
  )

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchMatches([])
    setSearchCurrentIndex(-1)
  }, [])

  return {
    searchQuery,
    setSearchQuery,
    searchMatches,
    searchMatchSet,
    searchCurrentIndex,
    performSearch,
    goToSearchResult,
    clearSearch,
  }
}
