import { useCallback, useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { sleep } from '@/utils/helpers'
import { SEARCH_TOLERANCE, type ViewerTranscript, type ViewerLine } from '@/utils/transcriptFormat'

const PROGRAMMATIC_SCROLL_RESET_MS = 700

interface UsePlayerSyncParams {
  videoRef: React.RefObject<HTMLVideoElement>
  audioRef: React.RefObject<HTMLAudioElement>
  waveformRef: React.RefObject<HTMLDivElement>
  lineRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  transcriptScrollRef: React.RefObject<HTMLDivElement>
  transcript: ViewerTranscript | null
  isVideo: boolean
  mediaUrl: string | null
}

export function usePlayerSync({
  videoRef,
  audioRef,
  waveformRef,
  lineRefs,
  transcriptScrollRef,
  transcript,
  isVideo,
  mediaUrl,
}: UsePlayerSyncParams) {
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const [showReturnToCurrent, setShowReturnToCurrent] = useState(false)
  const [activeClipPlaybackId, setActiveClipPlaybackId] = useState<string | null>(null)

  const programmaticScrollRef = useRef(false)
  const clipRafRef = useRef<number | null>(null)
  const clipFinishRef = useRef<(() => void) | null>(null)
  const wavesurferRef = useRef<WaveSurfer | null>(null)

  const getPlayerElement = useCallback((): HTMLMediaElement | null => {
    return isVideo ? videoRef.current : audioRef.current
  }, [isVideo, videoRef, audioRef])

  const stopClipPlaybackLoop = useCallback(() => {
    if (clipRafRef.current) {
      cancelAnimationFrame(clipRafRef.current)
      clipRafRef.current = null
    }
    clipFinishRef.current?.()
    clipFinishRef.current = null
    setActiveClipPlaybackId(null)
  }, [])

  const findLineAtTime = useCallback((value: number): ViewerLine | null => {
    if (!transcript || !transcript.lines.length) return null

    let low = 0
    let high = transcript.lines.length - 1

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const line = transcript.lines[mid]
      if (value >= line.start && value < line.end) return line
      if (value < line.start) high = mid - 1
      else low = mid + 1
    }

    for (let index = Math.min(high, transcript.lines.length - 1); index >= 0; index -= 1) {
      const line = transcript.lines[index]
      if (value + SEARCH_TOLERANCE >= line.end) return line
    }

    return null
  }, [transcript])

  const nearestLineFromTime = useCallback((value: number): ViewerLine | null => {
    if (!transcript) return null
    let best: ViewerLine | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const line of transcript.lines) {
      const center = (line.start + line.end) / 2
      const distance = Math.abs(center - value)
      if (distance < bestDistance) {
        best = line
        bestDistance = distance
      }
    }
    return best
  }, [transcript])

  const seekToLine = useCallback((line: ViewerLine, autoplay = true) => {
    const player = getPlayerElement()
    if (!player) return
    const target = Math.max(0, line.start)
    player.currentTime = target
    if (autoplay) {
      player.play().catch(() => {
        // Ignore autoplay failures
      })
    }
  }, [getPlayerElement])

  const returnToCurrentLine = useCallback(() => {
    if (!activeLineId) return
    const target = lineRefs.current[activeLineId]
    if (!target) return

    programmaticScrollRef.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setAutoFollow(true)
    setShowReturnToCurrent(false)
    window.setTimeout(() => {
      programmaticScrollRef.current = false
    }, PROGRAMMATIC_SCROLL_RESET_MS)
  }, [activeLineId, lineRefs])

  const handleTimeUpdate = useCallback(() => {
    const player = getPlayerElement()
    if (!player) return
    const t = player.currentTime
    setCurrentTime(t)
    const found = findLineAtTime(t)
    setActiveLineId(found?.id || null)
  }, [findLineAtTime, getPlayerElement])

  const handleLoadedMetadata = useCallback(() => {
    const player = getPlayerElement()
    if (!player) return
    setDuration(Number.isFinite(player.duration) ? player.duration : transcript?.audio_duration || 0)
  }, [getPlayerElement, transcript?.audio_duration])

  const waitForCanPlay = useCallback(async () => {
    await sleep(50)
    const player = getPlayerElement()
    if (!player) return

    if (player.readyState >= 2) return

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup()
        reject(new Error('Media loading timed out.'))
      }, 15000)

      const cleanup = () => {
        window.clearTimeout(timer)
        player.removeEventListener('canplay', onReady)
        player.removeEventListener('error', onError)
      }

      const onReady = () => {
        cleanup()
        resolve()
      }

      const onError = () => {
        cleanup()
        const error = player.error
        reject(new Error(`Media failed to load (code ${error?.code ?? 'unknown'}).`))
      }

      player.addEventListener('canplay', onReady)
      player.addEventListener('error', onError)
    })
  }, [getPlayerElement])

  const playRange = useCallback(async (
    start: number,
    end: number,
    clipId?: string,
    abortRef?: React.MutableRefObject<boolean>,
  ) => {
    const player = getPlayerElement()
    if (!player) return

    stopClipPlaybackLoop()
    player.currentTime = Math.max(0, start)
    setActiveClipPlaybackId(clipId || null)

    try {
      await player.play()
    } catch {
      setActiveClipPlaybackId(null)
      return
    }

    await new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        player.pause()
        clipFinishRef.current = null
        if (clipRafRef.current) {
          cancelAnimationFrame(clipRafRef.current)
          clipRafRef.current = null
        }
        setActiveClipPlaybackId(null)
        resolve()
      }

      clipFinishRef.current = finish

      const tick = () => {
        if (resolved) return
        if (abortRef?.current || player.currentTime >= end || player.ended) {
          finish()
          return
        }
        clipRafRef.current = requestAnimationFrame(tick)
      }

      clipRafRef.current = requestAnimationFrame(tick)
    })
  }, [getPlayerElement, stopClipPlaybackLoop])

  // Auto-scroll to active line
  useEffect(() => {
    if (!activeLineId || !autoFollow) return
    const target = lineRefs.current[activeLineId]
    if (!target) return

    programmaticScrollRef.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      programmaticScrollRef.current = false
    }, PROGRAMMATIC_SCROLL_RESET_MS)
  }, [activeLineId, autoFollow, lineRefs])

  // Detect manual scroll to disable auto-follow
  useEffect(() => {
    const container = transcriptScrollRef.current
    if (!container) return

    const onScroll = () => {
      if (programmaticScrollRef.current) return
      if (autoFollow) {
        setAutoFollow(false)
        setShowReturnToCurrent(true)
      }
    }

    container.addEventListener('scroll', onScroll)
    return () => container.removeEventListener('scroll', onScroll)
  }, [autoFollow, transcriptScrollRef])

  // WaveSurfer: initialize for audio-only playback
  useEffect(() => {
    if (isVideo || !mediaUrl || !waveformRef.current) {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy()
        wavesurferRef.current = null
      }
      return
    }

    const audioElement = audioRef.current
    if (!audioElement) return

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      height: 'auto',
      waveColor: 'rgba(100, 116, 139, 0.35)',
      progressColor: 'rgba(51, 65, 85, 0.7)',
      cursorColor: 'rgba(245, 158, 11, 0.8)',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      media: audioElement,
    })

    wavesurferRef.current = ws

    return () => {
      ws.destroy()
      wavesurferRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, mediaUrl])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopClipPlaybackLoop()
    }
  }, [stopClipPlaybackLoop])

  return {
    currentTime,
    duration,
    setDuration,
    activeLineId,
    setActiveLineId,
    selectedLineId,
    setSelectedLineId,
    autoFollow,
    setAutoFollow,
    showReturnToCurrent,
    setShowReturnToCurrent,
    activeClipPlaybackId,
    programmaticScrollRef,
    handleTimeUpdate,
    handleLoadedMetadata,
    findLineAtTime,
    nearestLineFromTime,
    seekToLine,
    returnToCurrentLine,
    stopClipPlaybackLoop,
    playRange,
    waitForCanPlay,
    getPlayerElement,
  }
}
