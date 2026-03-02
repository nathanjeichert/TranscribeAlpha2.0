import { useCallback, useEffect, useRef, useState } from 'react'
import { getTranscript, type ClipRecord, type ClipSequenceRecord } from '@/lib/storage'
import { normalizeViewerTranscript, formatRange, type ViewerTranscript } from '@/utils/transcriptFormat'
import { sleep } from '@/utils/helpers'
import type { TitleCardState, SequencePauseBehavior, SequenceState } from '../viewerTypes'

const PRESENTATION_UI_IDLE_MS = 1400

interface UsePresentationModeParams {
  viewerShellRef: React.RefObject<HTMLDivElement>
  clips: ClipRecord[]
  currentMediaKey: string | null
  transcriptCacheRef: React.MutableRefObject<Record<string, ViewerTranscript>>
  playRange: (start: number, end: number, clipId?: string, abortRef?: React.MutableRefObject<boolean>) => Promise<void>
  loadTranscriptByKey: (mediaKey: string, silent?: boolean) => Promise<ViewerTranscript | null>
  waitForCanPlay: () => Promise<void>
}

export function usePresentationMode({
  viewerShellRef,
  clips,
  currentMediaKey,
  transcriptCacheRef,
  playRange,
  loadTranscriptByKey,
  waitForCanPlay,
}: UsePresentationModeParams) {
  const [presentationMode, setPresentationMode] = useState(false)
  const [titleCard, setTitleCard] = useState<TitleCardState | null>(null)
  const [sequenceState, setSequenceState] = useState<SequenceState>({ phase: 'idle' })
  const [presentationUiVisible, setPresentationUiVisible] = useState(false)
  const [showBlackScreen, setShowBlackScreen] = useState(false)
  const [waitingForResume, setWaitingForResume] = useState(false)
  const [sequencePauseBehavior, setSequencePauseBehavior] = useState<SequencePauseBehavior>(() => {
    if (typeof window === 'undefined') return 'black-screen'
    const saved = localStorage.getItem('sequence-pause-behavior')
    if (saved === 'black-screen' || saved === 'title-card' || saved === 'continuous') return saved
    return 'black-screen'
  })
  const [clipGapSeconds, setClipGapSeconds] = useState<number>(() => {
    if (typeof window === 'undefined') return 3
    const saved = localStorage.getItem('sequence-clip-gap')
    const parsed = Number(saved)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3
  })

  const presentationUiTimerRef = useRef<number | null>(null)
  const sequenceAbortRef = useRef(false)
  const sequenceResumeRef = useRef<(() => void) | null>(null)

  // Persist settings to localStorage
  useEffect(() => {
    localStorage.setItem('sequence-pause-behavior', sequencePauseBehavior)
  }, [sequencePauseBehavior])

  useEffect(() => {
    localStorage.setItem('sequence-clip-gap', String(clipGapSeconds))
  }, [clipGapSeconds])

  const clearPresentationUiTimer = useCallback(() => {
    if (presentationUiTimerRef.current) {
      window.clearTimeout(presentationUiTimerRef.current)
      presentationUiTimerRef.current = null
    }
  }, [])

  const revealPresentationUi = useCallback(() => {
    if (!presentationMode) return
    setPresentationUiVisible(true)
    clearPresentationUiTimer()
    presentationUiTimerRef.current = window.setTimeout(() => {
      setPresentationUiVisible(false)
      presentationUiTimerRef.current = null
    }, PRESENTATION_UI_IDLE_MS)
  }, [clearPresentationUiTimer, presentationMode])

  useEffect(() => {
    if (!presentationMode) {
      setPresentationUiVisible(false)
      clearPresentationUiTimer()
    }
  }, [clearPresentationUiTimer, presentationMode])

  const enterPresentationMode = useCallback(async () => {
    const target = viewerShellRef.current
    setPresentationMode(true)
    setPresentationUiVisible(true)
    clearPresentationUiTimer()
    presentationUiTimerRef.current = window.setTimeout(() => {
      setPresentationUiVisible(false)
      presentationUiTimerRef.current = null
    }, PRESENTATION_UI_IDLE_MS)

    if (target && !document.fullscreenElement) {
      try {
        await target.requestFullscreen()
      } catch {
        // Ignore fullscreen errors; presentation still toggles layout mode.
      }
    }
  }, [clearPresentationUiTimer, viewerShellRef])

  const exitPresentationMode = useCallback(async () => {
    sequenceAbortRef.current = true
    setTitleCard(null)
    setShowBlackScreen(false)
    setWaitingForResume(false)
    if (sequenceResumeRef.current) {
      sequenceResumeRef.current()
      sequenceResumeRef.current = null
    }
    setSequenceState({ phase: 'idle' })
    setPresentationMode(false)
    setPresentationUiVisible(false)
    clearPresentationUiTimer()

    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch {
        // Ignore exit fullscreen errors.
      }
    }
  }, [clearPresentationUiTimer])

  const waitForUserResume = useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (sequenceAbortRef.current) {
        resolve()
        return
      }
      setWaitingForResume(true)
      sequenceResumeRef.current = () => {
        setWaitingForResume(false)
        resolve()
      }
    })
  }, [])

  const runSequencePresentation = useCallback(async (sequence: ClipSequenceRecord) => {
    if (!sequence.entries.length) {
      return
    }

    sequenceAbortRef.current = false
    await enterPresentationMode()

    try {
      const orderedEntries = [...sequence.entries].sort((a, b) => a.order - b.order)
      let activeTranscriptKey = currentMediaKey
      const pauseMode = sequencePauseBehavior

      // Pre-load transcript display names for title cards
      const transcriptNames: Record<string, string> = {}
      for (const entry of orderedEntries) {
        const key = entry.source_media_key
        if (transcriptNames[key] !== undefined) continue
        const cached = transcriptCacheRef.current[key]
        if (cached) {
          transcriptNames[key] = cached.title_data?.FILE_NAME || cached.media_filename || ''
        } else {
          try {
            const raw = await getTranscript(key)
            if (raw) {
              const normalized = normalizeViewerTranscript(raw as Parameters<typeof normalizeViewerTranscript>[0], key)
              transcriptCacheRef.current[key] = normalized
              transcriptNames[key] = normalized.title_data?.FILE_NAME || normalized.media_filename || ''
            } else {
              transcriptNames[key] = ''
            }
          } catch {
            transcriptNames[key] = ''
          }
        }
      }

      for (let clipIndex = 0; clipIndex < orderedEntries.length; clipIndex += 1) {
        if (sequenceAbortRef.current) break
        const entry = orderedEntries[clipIndex]
        const clip = clips.find((item) => item.clip_id === entry.clip_id)
        if (!clip) continue

        const mediaName = transcriptNames[clip.source_media_key] || ''

        // --- Black screen pause (before title card) ---
        if (pauseMode === 'black-screen') {
          setShowBlackScreen(true)
          setSequenceState({ phase: 'title-card', sequenceId: sequence.sequence_id, clipIndex })
          await waitForUserResume()
          setShowBlackScreen(false)
          if (sequenceAbortRef.current) break
        }

        // --- Title card ---
        setSequenceState({ phase: 'title-card', sequenceId: sequence.sequence_id, clipIndex })
        setTitleCard({
          visible: true,
          title: clip.name,
          meta: `Clip ${clipIndex + 1} of ${orderedEntries.length} — ${formatRange(clip.start_time, clip.end_time)}`,
          subtitle: mediaName || undefined,
        })

        if (pauseMode === 'title-card') {
          await waitForUserResume()
          if (sequenceAbortRef.current) break
        } else {
          await sleep(3000)
          if (sequenceAbortRef.current) break
        }

        setTitleCard(null)
        setSequenceState({ phase: 'transitioning', sequenceId: sequence.sequence_id, clipIndex })

        // --- Load transcript/media if different recording ---
        if (clip.source_media_key !== activeTranscriptKey) {
          const loaded = await loadTranscriptByKey(clip.source_media_key, true)
          if (!loaded) continue
          await sleep(100)
          await waitForCanPlay()
          activeTranscriptKey = clip.source_media_key
        }

        setSequenceState({ phase: 'playing', sequenceId: sequence.sequence_id, clipIndex })

        await playRange(clip.start_time, clip.end_time, clip.clip_id, sequenceAbortRef)

        // Gap between clips in continuous mode
        if (pauseMode === 'continuous' && clipGapSeconds > 0) {
          await sleep(clipGapSeconds * 1000)
        }
      }

      if (!sequenceAbortRef.current) {
        setSequenceState({ phase: 'finished', sequenceId: sequence.sequence_id })
        setTitleCard({
          visible: true,
          title: 'End of Presentation',
          meta: sequence.name,
        })
        await sleep(2000)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Sequence presentation failed'
      // Re-throw so callers can surface the error
      sequenceAbortRef.current = true
      throw new Error(message)
    } finally {
      setTitleCard(null)
      setShowBlackScreen(false)
      setWaitingForResume(false)
      sequenceResumeRef.current = null
      await exitPresentationMode()
    }
  }, [clipGapSeconds, clips, currentMediaKey, enterPresentationMode, exitPresentationMode, loadTranscriptByKey, playRange, sequencePauseBehavior, transcriptCacheRef, waitForCanPlay, waitForUserResume])

  return {
    presentationMode,
    titleCard,
    sequenceState,
    presentationUiVisible,
    showBlackScreen,
    waitingForResume,
    sequencePauseBehavior,
    setSequencePauseBehavior,
    clipGapSeconds,
    setClipGapSeconds,
    sequenceAbortRef,
    sequenceResumeRef,
    enterPresentationMode,
    exitPresentationMode,
    revealPresentationUi,
    clearPresentationUiTimer,
    runSequencePresentation,
  }
}
