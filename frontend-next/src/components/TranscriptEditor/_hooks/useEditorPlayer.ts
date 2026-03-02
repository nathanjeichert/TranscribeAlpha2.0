import React, { useCallback, useEffect, useRef, useState } from 'react'
import { EditorLine } from '../editorTypes'

interface UseEditorPlayerParams {
  videoRef: React.RefObject<HTMLVideoElement | null>
  audioRef: React.RefObject<HTMLAudioElement | null>
  resolvedMediaUrl: string | undefined
  isVideo: boolean
  lineBoundaries: Array<{ id: string; start: number; end: number }>
  scrollToActiveLine: (lineId: string) => void
}

export function useEditorPlayer({
  videoRef,
  audioRef,
  resolvedMediaUrl,
  isVideo,
  lineBoundaries,
  scrollToActiveLine,
}: UseEditorPlayerParams) {
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [manualScrollOverride, setManualScrollOverride] = useState(false)

  const activeLineMarkerRef = useRef<string | null>(null)
  const timeUpdateRafRef = useRef<number | null>(null)

  useEffect(() => {
    const player = resolvedMediaUrl ? (isVideo ? videoRef.current : audioRef.current) : null
    if (!player) return

    const handleTimeUpdate = () => {
      if (timeUpdateRafRef.current !== null) return
      timeUpdateRafRef.current = requestAnimationFrame(() => {
        timeUpdateRafRef.current = null
        const currentTime = player.currentTime
        let currentLineId: string | null = null
        for (let i = 0; i < lineBoundaries.length; i += 1) {
          const boundary = lineBoundaries[i]
          if (currentTime >= boundary.start && currentTime < boundary.end + 0.01) {
            currentLineId = boundary.id
            break
          }
        }
        if (!currentLineId && lineBoundaries.length) {
          const lastBoundary = lineBoundaries[lineBoundaries.length - 1]
          if (currentTime >= lastBoundary.end) {
            currentLineId = lastBoundary.id
          }
        }
        if (currentLineId && currentLineId !== activeLineMarkerRef.current) {
          activeLineMarkerRef.current = currentLineId
          setActiveLineId(currentLineId)
          if (autoScroll && !manualScrollOverride) {
            scrollToActiveLine(currentLineId)
          }
        }
      })
    }

    player.addEventListener('timeupdate', handleTimeUpdate)
    return () => {
      player.removeEventListener('timeupdate', handleTimeUpdate)
      if (timeUpdateRafRef.current !== null) {
        cancelAnimationFrame(timeUpdateRafRef.current)
        timeUpdateRafRef.current = null
      }
    }
  }, [resolvedMediaUrl, isVideo, lineBoundaries, autoScroll, manualScrollOverride, scrollToActiveLine, videoRef, audioRef])

  useEffect(() => {
    if (!autoScroll) {
      setManualScrollOverride(false)
    }
  }, [autoScroll])

  const playLine = useCallback(
    (line: EditorLine) => {
      if (!resolvedMediaUrl) return
      setSelectedLineId(line.id)
      const player = isVideo ? videoRef.current : audioRef.current
      if (!player) return

      const seekAndPlay = () => {
        player.currentTime = line.start
        player.play().catch(() => {})
      }

      if (player.readyState >= 1) {
        seekAndPlay()
      } else {
        const handleLoadedMetadata = () => {
          player.removeEventListener('loadedmetadata', handleLoadedMetadata)
          seekAndPlay()
        }
        player.addEventListener('loadedmetadata', handleLoadedMetadata)
        if (player.readyState === 0) {
          player.load()
        }
      }
    },
    [resolvedMediaUrl, isVideo, videoRef, audioRef],
  )

  const handleReturnToCurrentLine = useCallback(() => {
    if (!activeLineId) return
    setManualScrollOverride(false)
    scrollToActiveLine(activeLineId)
  }, [activeLineId, scrollToActiveLine])

  const isTypingInField = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  }, [])

  const resetActiveState = useCallback(() => {
    setActiveLineId(null)
    setSelectedLineId(null)
    activeLineMarkerRef.current = null
  }, [])

  const showReturnToCurrent = manualScrollOverride && autoScroll

  return {
    activeLineId,
    setActiveLineId,
    selectedLineId,
    setSelectedLineId,
    autoScroll,
    setAutoScroll,
    manualScrollOverride,
    setManualScrollOverride,
    playLine,
    handleReturnToCurrentLine,
    isTypingInField,
    resetActiveState,
    showReturnToCurrent,
  }
}
