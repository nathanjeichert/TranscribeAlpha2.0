'use client'

import JSZip from 'jszip'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDashboard } from '@/context/DashboardContext'
import {
  deleteClip,
  deleteSequence,
  getTranscript,
  listCaseClips,
  listCaseSequences,
  saveClip,
  saveTranscript,
  saveSequence,
  type ClipRecord,
  type ClipSequenceEntry,
  type ClipSequenceRecord,
  type TranscriptData,
} from '@/lib/storage'
import {
  getMediaFile,
  getMediaObjectURL,
  promptRelinkMedia,
  storeMediaHandle,
} from '@/lib/mediaHandles'
import WaveSurfer from 'wavesurfer.js'
import { authenticatedFetch } from '@/utils/auth'
import { guardedPush } from '@/utils/navigationGuard'
import { routes } from '@/utils/routes'

interface ViewerLine {
  id: string
  speaker: string
  text: string
  rendered_text?: string
  start: number
  end: number
  page?: number | null
  line?: number | null
  pgln?: number | null
  is_continuation?: boolean
}

interface ViewerTranscript extends TranscriptData {
  media_key: string
  title_data: Record<string, string>
  lines: ViewerLine[]
  audio_duration: number
  lines_per_page: number
  case_id?: string | null
}

interface TitleCardState {
  visible: boolean
  title: string
  meta: string
  subtitle?: string
}

type SequencePauseBehavior = 'black-screen' | 'title-card' | 'continuous'

type SequenceState =
  | { phase: 'idle' }
  | { phase: 'title-card'; sequenceId: string; clipIndex: number }
  | { phase: 'transitioning'; sequenceId: string; clipIndex: number }
  | { phase: 'playing'; sequenceId: string; clipIndex: number }
  | { phase: 'finished'; sequenceId: string }

type ViewerMode = 'document' | 'caption'
type ToolsTab = 'clips' | 'sequences'

const SEARCH_TOLERANCE = 0.05
const PROGRAMMATIC_SCROLL_RESET_MS = 700
const PRESENTATION_UI_IDLE_MS = 1400
const SPEAKER_LINE_PATTERN = /^(\s*)([A-Z][A-Z0-9 .,'"&/()-]*:)(\s*)(.*)$/

const formatClock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${mins}:${String(secs).padStart(2, '0')}`
}

const formatRange = (start: number, end: number) => `${formatClock(start)} - ${formatClock(end)}`

const parseTimeInput = (value: string): number | null => {
  const trimmed = value.trim()
  if (!trimmed) return null

  const parts = trimmed.split(':').map((part) => part.trim())
  if (parts.some((part) => !part.length)) return null

  const numeric = parts.map((part) => Number(part))
  if (numeric.some((part) => Number.isNaN(part))) return null

  if (numeric.length === 1) return numeric[0]
  if (numeric.length === 2) return numeric[0] * 60 + numeric[1]
  if (numeric.length === 3) return numeric[0] * 3600 + numeric[1] * 60 + numeric[2]
  return null
}

const escapeScriptBoundary = (value: string) => value.replace(/<\/script/gi, '<\\/script')

const sanitizeFilename = (value: string) => {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  return cleaned || 'item'
}

const sanitizeDownloadStem = (value: string) => {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'transcript'
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms)
})

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const normalizeSpeakerToken = (speaker: string) => speaker.trim().replace(/:+$/, '').toUpperCase()

const buildLineText = (line: ViewerLine) => {
  const rendered = typeof line.rendered_text === 'string' ? line.rendered_text : ''
  if (rendered.trim()) return rendered

  const base = typeof line.text === 'string' ? line.text : ''
  const speaker = normalizeSpeakerToken(line.speaker || '')
  if (!line.is_continuation && speaker && base.trim()) {
    const compact = collapseWhitespace(base).toUpperCase()
    if (!compact.startsWith(`${speaker}:`)) {
      return `          ${speaker}:   ${base}`
    }
  }
  return base
}

const splitSpeakerPrefix = (line: ViewerLine) => {
  const lineText = buildLineText(line)
  if (!lineText) {
    return {
      lineText,
      leading: '',
      speakerLabel: null as string | null,
      trailing: '',
    }
  }

  if (line.is_continuation) {
    return {
      lineText,
      leading: '',
      speakerLabel: null as string | null,
      trailing: '',
    }
  }

  const match = lineText.match(SPEAKER_LINE_PATTERN)
  if (!match) {
    return {
      lineText,
      leading: '',
      speakerLabel: null as string | null,
      trailing: '',
    }
  }

  return {
    lineText,
    leading: match[1] || '',
    speakerLabel: match[2] || null,
    trailing: `${match[3] || ''}${match[4] || ''}`,
  }
}

const captionTextForLine = (line: ViewerLine | null | undefined) => {
  if (!line) return ''
  const baseText = collapseWhitespace(line.text || line.rendered_text || '')
  if (!baseText) return ''

  const speaker = normalizeSpeakerToken(line.speaker || '')
  if (!line.is_continuation && speaker) {
    if (baseText.toUpperCase().startsWith(`${speaker}:`)) return baseText
    return `${speaker}: ${baseText}`
  }

  return baseText
}

function normalizeTranscript(raw: TranscriptData, fallbackMediaKey: string): ViewerTranscript {
  const rawLines = Array.isArray(raw.lines) ? raw.lines : []
  const lines: ViewerLine[] = rawLines
    .map((entry, index) => {
      const lineObj = (entry || {}) as Record<string, unknown>
      const start = Number(lineObj.start)
      const end = Number(lineObj.end)
      const page = Number(lineObj.page)
      const lineNum = Number(lineObj.line)
      const pgln = Number(lineObj.pgln)
      return {
        id: String(lineObj.id || `line-${index}`),
        speaker: String(lineObj.speaker || ''),
        text: String(lineObj.text || ''),
        rendered_text: typeof lineObj.rendered_text === 'string' ? lineObj.rendered_text : undefined,
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : Number.isFinite(start) ? start : 0,
        page: Number.isFinite(page) ? page : null,
        line: Number.isFinite(lineNum) ? lineNum : null,
        pgln: Number.isFinite(pgln) ? pgln : null,
        is_continuation: Boolean(lineObj.is_continuation),
      }
    })
    .sort((a, b) => a.start - b.start)

  return {
    ...raw,
    media_key: String(raw.media_key || fallbackMediaKey),
    title_data: raw.title_data || {},
    lines,
    audio_duration: Number(raw.audio_duration || 0),
    lines_per_page: Number(raw.lines_per_page || 25),
  }
}

function linesToViewerPayload(transcript: ViewerTranscript) {
  const speakers = Array.from(
    new Set(
      transcript.lines
        .map((line) => line.speaker)
        .filter((speaker) => speaker && speaker.trim().length > 0),
    ),
  )

  const lines = transcript.lines.map((line, index) => ({
    id: line.id,
    speaker: line.speaker,
    text: line.text,
    rendered_text: line.rendered_text || line.text,
    start: line.start,
    end: line.end,
    page_number: line.page || Math.floor(index / transcript.lines_per_page) + 1,
    line_number: line.line || ((index % transcript.lines_per_page) + 1),
    pgln: line.pgln || 101 + index,
    is_continuation: Boolean(line.is_continuation),
  }))

  const pageMap = new Map<number, number[]>()
  lines.forEach((line, idx) => {
    const page = line.page_number
    if (!pageMap.has(page)) pageMap.set(page, [])
    pageMap.get(page)?.push(idx)
  })

  const pages = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([pageNum, lineIndexes]) => ({
      page_number: pageNum,
      line_indexes: lineIndexes,
      pgln_start: lineIndexes.length ? lines[lineIndexes[0]].pgln : 101,
      pgln_end: lineIndexes.length ? lines[lineIndexes[lineIndexes.length - 1]].pgln : 101,
    }))

  return {
    meta: {
      title: transcript.title_data || {},
      duration_seconds: transcript.audio_duration || 0,
      lines_per_page: transcript.lines_per_page || 25,
      speakers,
    },
    media: {
      filename: transcript.media_filename || transcript.title_data?.FILE_NAME || 'media.mp4',
      content_type: transcript.media_content_type || 'video/mp4',
      relative_path: transcript.media_filename || transcript.title_data?.FILE_NAME || 'media.mp4',
    },
    lines,
    pages,
  }
}

export default function ViewerPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryMediaKey = searchParams.get('key')
  const queryCaseId = searchParams.get('case')

  const { activeMediaKey, setActiveMediaKey, appVariant } = useDashboard()

  const [currentMediaKey, setCurrentMediaKey] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<ViewerTranscript | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [mediaAvailable, setMediaAvailable] = useState(true)
  const [mediaLoading, setMediaLoading] = useState(false)

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const [showReturnToCurrent, setShowReturnToCurrent] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)

  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const [clips, setClips] = useState<ClipRecord[]>([])
  const [sequences, setSequences] = useState<ClipSequenceRecord[]>([])
  const [clipsLoading, setClipsLoading] = useState(false)

  const [clipName, setClipName] = useState('')
  const [clipStart, setClipStart] = useState('')
  const [clipEnd, setClipEnd] = useState('')
  const [clipError, setClipError] = useState('')
  const [editingClipId, setEditingClipId] = useState<string | null>(null)
  const [editClipName, setEditClipName] = useState('')
  const [editClipStart, setEditClipStart] = useState('')
  const [editClipEnd, setEditClipEnd] = useState('')
  const [dragClipId, setDragClipId] = useState<string | null>(null)

  const [newSequenceName, setNewSequenceName] = useState('')
  const [selectedSequenceId, setSelectedSequenceId] = useState<string | null>(null)
  const [sequenceNameDrafts, setSequenceNameDrafts] = useState<Record<string, string>>({})
  const [sequenceError, setSequenceError] = useState('')
  const [viewerMode, setViewerMode] = useState<ViewerMode>('document')
  const [showToolsPanel, setShowToolsPanel] = useState(false)
  const [activeToolsTab, setActiveToolsTab] = useState<ToolsTab>('clips')

  const [presentationMode, setPresentationMode] = useState(false)
  const [titleCard, setTitleCard] = useState<TitleCardState | null>(null)
  const [sequenceState, setSequenceState] = useState<SequenceState>({ phase: 'idle' })

  const [activeClipPlaybackId, setActiveClipPlaybackId] = useState<string | null>(null)
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

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const viewerShellRef = useRef<HTMLDivElement>(null)
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const waveformRef = useRef<HTMLDivElement>(null)
  const wavesurferRef = useRef<WaveSurfer | null>(null)

  const blobUrlRef = useRef<string | null>(null)
  const programmaticScrollRef = useRef(false)
  const clipRafRef = useRef<number | null>(null)
  const presentationUiTimerRef = useRef<number | null>(null)
  const sequenceAbortRef = useRef(false)
  const clipFinishRef = useRef<(() => void) | null>(null)
  const sequenceResumeRef = useRef<(() => void) | null>(null)
  const transcriptCacheRef = useRef<Record<string, ViewerTranscript>>({})
  const templateCacheRef = useRef<string | null>(null)

  const isVideo = useMemo(
    () => (transcript?.media_content_type || '').startsWith('video/'),
    [transcript?.media_content_type],
  )

  const effectiveCaseId = useMemo(() => {
    if (queryCaseId) return queryCaseId
    if (transcript?.case_id && String(transcript.case_id).trim()) return String(transcript.case_id)
    return ''
  }, [queryCaseId, transcript?.case_id])

  const groupedPages = useMemo(() => {
    if (!transcript) return [] as Array<{ page: number; lines: ViewerLine[] }>
    const map = new Map<number, ViewerLine[]>()
    transcript.lines.forEach((line, idx) => {
      const pageNum = line.page || Math.floor(idx / transcript.lines_per_page) + 1
      if (!map.has(pageNum)) map.set(pageNum, [])
      map.get(pageNum)?.push(line)
    })

    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([page, lines]) => ({ page, lines }))
  }, [transcript])

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

  const visibleClips = useMemo(() => {
    const sorted = [...clips].sort((a, b) => {
      const aOrder = Number.isFinite(a.order) ? Number(a.order) : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.order) ? Number(b.order) : Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return (a.created_at || '').localeCompare(b.created_at || '')
    })

    if (queryCaseId) return sorted
    if (!currentMediaKey) return []
    return sorted.filter((clip) => clip.source_media_key === currentMediaKey)
  }, [clips, currentMediaKey, queryCaseId])

  const groupedVisibleClips = useMemo(() => {
    const groups = new Map<string, ClipRecord[]>()
    visibleClips.forEach((clip) => {
      if (!groups.has(clip.source_media_key)) groups.set(clip.source_media_key, [])
      groups.get(clip.source_media_key)?.push(clip)
    })
    return Array.from(groups.entries())
  }, [visibleClips])

  const canEditClips = !!effectiveCaseId
  const currentSearchLineId = searchMatches.length > 0
    ? searchMatches[((searchCursor % searchMatches.length) + searchMatches.length) % searchMatches.length]
    : null

  const activeLineIndex = useMemo(() => {
    if (!transcript || !activeLineId) return -1
    return transcript.lines.findIndex((line) => line.id === activeLineId)
  }, [activeLineId, transcript])

  const captionWindow = useMemo(() => {
    if (!transcript || activeLineIndex < 0) {
      return {
        prev2: '',
        prev1: '',
        current: '',
        next1: '',
        next2: '',
      }
    }

    const at = (index: number) => captionTextForLine(transcript.lines[index])
    return {
      prev2: at(activeLineIndex - 2),
      prev1: at(activeLineIndex - 1),
      current: at(activeLineIndex),
      next1: at(activeLineIndex + 1),
      next2: at(activeLineIndex + 2),
    }
  }, [activeLineIndex, transcript])

  const getPlayerElement = useCallback((): HTMLMediaElement | null => {
    return isVideo ? videoRef.current : audioRef.current
  }, [isVideo])

  const stopClipPlaybackLoop = useCallback(() => {
    if (clipRafRef.current) {
      cancelAnimationFrame(clipRafRef.current)
      clipRafRef.current = null
    }
    clipFinishRef.current?.()
    clipFinishRef.current = null
    setActiveClipPlaybackId(null)
  }, [])

  const revokeMediaUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
  }, [])

  const loadMediaForTranscript = useCallback(async (record: ViewerTranscript) => {
    if (appVariant !== 'criminal') return

    revokeMediaUrl()
    setMediaLoading(true)

    const handleId = record.media_handle_id || record.media_key
    const objectUrl = await getMediaObjectURL(handleId)
    if (objectUrl) {
      blobUrlRef.current = objectUrl
      setMediaUrl(objectUrl)
      setMediaAvailable(true)
    } else {
      setMediaUrl(null)
      setMediaAvailable(false)
    }
    setMediaLoading(false)
  }, [appVariant, revokeMediaUrl])

  const loadCaseArtifacts = useCallback(async (caseId: string) => {
    if (appVariant !== 'criminal') {
      setClips([])
      setSequences([])
      return
    }

    setClipsLoading(true)
    try {
      const [caseClips, caseSequences] = await Promise.all([
        listCaseClips(caseId),
        listCaseSequences(caseId),
      ])
      setClips(caseClips)
      setSequences(caseSequences)
    } finally {
      setClipsLoading(false)
    }
  }, [appVariant])

  const loadTranscriptByKey = useCallback(async (mediaKey: string, silent = false) => {
    if (appVariant !== 'criminal') {
      if (!silent) setIsLoading(false)
      return null
    }

    if (!silent) {
      setIsLoading(true)
      setError('')
    }

    try {
      let record = transcriptCacheRef.current[mediaKey]
      if (!record) {
        const raw = await getTranscript(mediaKey)
        if (!raw) throw new Error('Transcript not found')
        record = normalizeTranscript(raw, mediaKey)
        transcriptCacheRef.current[mediaKey] = record
      }

      setTranscript(record)
      setCurrentMediaKey(record.media_key)
      setDuration(record.audio_duration || 0)
      setCurrentTime(0)
      setActiveLineId(null)
      setSelectedLineId(null)
      setActiveMediaKey(record.media_key)
      setAutoFollow(true)
      setShowReturnToCurrent(false)
      await loadMediaForTranscript(record)

      return record
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load transcript'
      setError(message)
      return null
    } finally {
      if (!silent) setIsLoading(false)
    }
  }, [appVariant, loadMediaForTranscript, setActiveMediaKey])

  useEffect(() => {
    if (queryMediaKey) {
      setCurrentMediaKey(queryMediaKey)
      return
    }
    if (activeMediaKey) {
      setCurrentMediaKey(activeMediaKey)
    }
  }, [queryMediaKey, activeMediaKey])

  useEffect(() => {
    if (appVariant !== 'criminal') {
      setIsLoading(false)
      return
    }

    if (!currentMediaKey) {
      setIsLoading(false)
      return
    }

    loadTranscriptByKey(currentMediaKey)
  }, [appVariant, currentMediaKey, loadTranscriptByKey])

  useEffect(() => {
    if (appVariant !== 'criminal') {
      setClips([])
      setSequences([])
      return
    }

    if (!effectiveCaseId) {
      setClips([])
      setSequences([])
      return
    }
    loadCaseArtifacts(effectiveCaseId)
  }, [appVariant, effectiveCaseId, loadCaseArtifacts])

  useEffect(() => {
    setSequenceNameDrafts((prev) => {
      const next: Record<string, string> = {}
      sequences.forEach((sequence) => {
        next[sequence.sequence_id] = prev[sequence.sequence_id] ?? sequence.name
      })
      return next
    })
  }, [sequences])

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

  useEffect(() => {
    return () => {
      revokeMediaUrl()
      stopClipPlaybackLoop()
      clearPresentationUiTimer()
      sequenceAbortRef.current = true
    }
  }, [clearPresentationUiTimer, revokeMediaUrl, stopClipPlaybackLoop])

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
  }, [activeLineId])

  useEffect(() => {
    if (!activeLineId || !autoFollow) return
    const target = lineRefs.current[activeLineId]
    if (!target) return

    programmaticScrollRef.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      programmaticScrollRef.current = false
    }, PROGRAMMATIC_SCROLL_RESET_MS)
  }, [activeLineId, autoFollow])

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
  }, [autoFollow])

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
  }, [clearPresentationUiTimer])

  const exitPresentationMode = useCallback(async () => {
    sequenceAbortRef.current = true
    stopClipPlaybackLoop()
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
  }, [clearPresentationUiTimer, stopClipPlaybackLoop])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const typingInField =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }

      if (typingInField) return

      const player = getPlayerElement()
      if (!player) return

      if (event.code === 'Space') {
        event.preventDefault()
        if (sequenceResumeRef.current) {
          const resume = sequenceResumeRef.current
          sequenceResumeRef.current = null
          setWaitingForResume(false)
          resume()
          return
        }
        if (player.paused) player.play().catch(() => {})
        else player.pause()
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        player.currentTime = Math.max(0, player.currentTime - 5)
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const next = player.currentTime + 5
        if (Number.isFinite(player.duration)) player.currentTime = Math.min(player.duration, next)
        else player.currentTime = next
        return
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (!presentationMode) {
          void enterPresentationMode()
        }
        return
      }

      if (event.key.toLowerCase() === 'c') {
        event.preventDefault()
        setViewerMode((prev) => (prev === 'document' ? 'caption' : 'document'))
        return
      }

      if (event.key === 'Escape' && presentationMode) {
        event.preventDefault()
        void exitPresentationMode()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enterPresentationMode, exitPresentationMode, getPlayerElement, presentationMode])

  useEffect(() => {
    if (!exportMenuOpen) return

    const onDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (exportMenuRef.current && !exportMenuRef.current.contains(target)) {
        setExportMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', onDocumentPointerDown)
    return () => document.removeEventListener('mousedown', onDocumentPointerDown)
  }, [exportMenuOpen])

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && presentationMode) {
        sequenceAbortRef.current = true
        stopClipPlaybackLoop()
        setShowBlackScreen(false)
        setWaitingForResume(false)
        if (sequenceResumeRef.current) {
          sequenceResumeRef.current()
          sequenceResumeRef.current = null
        }
        setPresentationMode(false)
        setPresentationUiVisible(false)
        clearPresentationUiTimer()
        setTitleCard(null)
        setSequenceState({ phase: 'idle' })
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [clearPresentationUiTimer, presentationMode, stopClipPlaybackLoop])

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
  }, [searchMatches])

  useEffect(() => {
    setSearchCursor(0)
  }, [searchQuery])

  const relinkMedia = useCallback(async () => {
    if (!transcript) return
    const expected = transcript.media_filename || transcript.title_data?.FILE_NAME || 'media file'
    const result = await promptRelinkMedia(expected)
    if (!result) return

    await storeMediaHandle(result.handleId, result.handle)

    const nextTranscript: ViewerTranscript = {
      ...transcript,
      media_handle_id: result.handleId,
    }

    const caseId = transcript.case_id && String(transcript.case_id).trim()
      ? String(transcript.case_id)
      : undefined

    await saveTranscript(transcript.media_key, nextTranscript, caseId)
    transcriptCacheRef.current[transcript.media_key] = nextTranscript
    setTranscript(nextTranscript)
    await loadMediaForTranscript(nextTranscript)
  }, [loadMediaForTranscript, transcript])

  const nearestLineFromTime = useCallback((value: number): ViewerLine | null => {
    if (!transcript) return null
    let best: ViewerLine | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const line of transcript.lines as ViewerLine[]) {
      const center = (line.start + line.end) / 2
      const distance = Math.abs(center - value)
      if (distance < bestDistance) {
        best = line
        bestDistance = distance
      }
    }
    return best
  }, [transcript])

  const persistClipOrder = useCallback(async (orderedVisibleClips: ClipRecord[]) => {
    if (!effectiveCaseId) return

    const orderMap = new Map<string, number>()
    orderedVisibleClips.forEach((clip, idx) => {
      orderMap.set(clip.clip_id, idx)
    })

    const updatedAll = clips.map((clip, idx) => {
      if (orderMap.has(clip.clip_id)) {
        return { ...clip, order: orderMap.get(clip.clip_id) }
      }
      const base = Number.isFinite(clip.order) ? Number(clip.order) : idx + orderedVisibleClips.length
      return { ...clip, order: base + orderedVisibleClips.length }
    })

    await Promise.all(updatedAll.map(async (clip) => {
      await saveClip(effectiveCaseId, clip)
    }))

    await loadCaseArtifacts(effectiveCaseId)
  }, [clips, effectiveCaseId, loadCaseArtifacts])

  const createClip = useCallback(async () => {
    setClipError('')
    if (!transcript || !currentMediaKey || !effectiveCaseId) {
      setClipError('Clips are available only for transcripts assigned to a case.')
      return
    }

    const startVal = parseTimeInput(clipStart)
    const endVal = parseTimeInput(clipEnd)

    if (startVal === null || endVal === null) {
      setClipError('Enter valid start and end times (M:SS or H:MM:SS).')
      return
    }

    const maxDuration = duration || transcript.audio_duration || Number.MAX_SAFE_INTEGER
    const start = Math.max(0, Math.min(startVal, maxDuration))
    const end = Math.max(0, Math.min(endVal, maxDuration))

    if (end <= start) {
      setClipError('End time must be greater than start time.')
      return
    }

    const startLine = nearestLineFromTime(start)
    const endLine = nearestLineFromTime(end)

    const maxOrder = clips.reduce((max, clip) => {
      const order = Number.isFinite(clip.order) ? Number(clip.order) : max
      return Math.max(max, order)
    }, -1)

    const clip: ClipRecord = {
      clip_id: crypto.randomUUID(),
      name: clipName.trim() || `Clip ${clips.length + 1}`,
      source_media_key: currentMediaKey,
      start_time: start,
      end_time: end,
      start_pgln: startLine ? (startLine.pgln ?? null) : null,
      end_pgln: endLine ? (endLine.pgln ?? null) : null,
      start_page: startLine ? (startLine.page ?? null) : null,
      start_line: startLine ? (startLine.line ?? null) : null,
      end_page: endLine ? (endLine.page ?? null) : null,
      end_line: endLine ? (endLine.line ?? null) : null,
      created_at: new Date().toISOString(),
      order: maxOrder + 1,
    }

    await saveClip(effectiveCaseId, clip)
    await loadCaseArtifacts(effectiveCaseId)

    setClipName('')
    setClipStart('')
    setClipEnd('')
  }, [clipEnd, clipName, clipStart, clips, currentMediaKey, duration, effectiveCaseId, loadCaseArtifacts, nearestLineFromTime, transcript])

  const startEditingClip = useCallback((clip: ClipRecord) => {
    setEditingClipId(clip.clip_id)
    setEditClipName(clip.name)
    setEditClipStart(formatClock(clip.start_time))
    setEditClipEnd(formatClock(clip.end_time))
  }, [])

  const saveEditedClip = useCallback(async () => {
    setClipError('')
    if (!effectiveCaseId || !editingClipId) return
    const existing = clips.find((clip) => clip.clip_id === editingClipId)
    if (!existing) return

    const startVal = parseTimeInput(editClipStart)
    const endVal = parseTimeInput(editClipEnd)
    if (startVal === null || endVal === null || endVal <= startVal) {
      setClipError('Provide a valid clip range before saving.')
      return
    }

    const updated: ClipRecord = {
      ...existing,
      name: editClipName.trim() || existing.name,
      start_time: startVal,
      end_time: endVal,
      updated_at: new Date().toISOString(),
    }

    await saveClip(effectiveCaseId, updated)
    await loadCaseArtifacts(effectiveCaseId)
    setEditingClipId(null)
  }, [clips, editClipEnd, editClipName, editClipStart, editingClipId, effectiveCaseId, loadCaseArtifacts])

  const removeClip = useCallback(async (clip: ClipRecord) => {
    setClipError('')
    if (!effectiveCaseId) return
    if (!window.confirm(`Delete clip "${clip.name}"?`)) return
    await deleteClip(effectiveCaseId, clip.clip_id)
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

  const playRange = useCallback(async (start: number, end: number, clipId?: string) => {
    const player = getPlayerElement()
    if (!player) return

    sequenceAbortRef.current = false
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
        if (sequenceAbortRef.current || player.currentTime >= end || player.ended) {
          finish()
          return
        }
        clipRafRef.current = requestAnimationFrame(tick)
      }

      clipRafRef.current = requestAnimationFrame(tick)
    })
  }, [getPlayerElement, stopClipPlaybackLoop])

  const playClip = useCallback(async (clip: ClipRecord) => {
    setClipError('')
    if (!currentMediaKey || !effectiveCaseId) return

    if (clip.source_media_key !== currentMediaKey) {
      const openOther = window.confirm('This clip belongs to another recording. Open that recording in Viewer now?')
      if (openOther) {
        guardedPush(router, routes.viewer(clip.source_media_key, effectiveCaseId))
      }
      return
    }

    await playRange(clip.start_time, clip.end_time, clip.clip_id)
  }, [currentMediaKey, effectiveCaseId, playRange, router])

  const reorderVisibleClips = useCallback(async (sourceClipId: string, targetClipId: string) => {
    setClipError('')
    const list = [...visibleClips]
    const fromIdx = list.findIndex((clip) => clip.clip_id === sourceClipId)
    const toIdx = list.findIndex((clip) => clip.clip_id === targetClipId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return

    const [moved] = list.splice(fromIdx, 1)
    list.splice(toIdx, 0, moved)

    await persistClipOrder(list)
  }, [persistClipOrder, visibleClips])

  const createSequence = useCallback(async () => {
    setSequenceError('')
    if (!effectiveCaseId) {
      setSequenceError('Sequences are available only for case transcripts.')
      return
    }

    const name = newSequenceName.trim() || `Sequence ${sequences.length + 1}`
    const now = new Date().toISOString()

    const sequence: ClipSequenceRecord = {
      sequence_id: crypto.randomUUID(),
      name,
      created_at: now,
      updated_at: now,
      entries: [],
    }

    await saveSequence(effectiveCaseId, sequence)
    await loadCaseArtifacts(effectiveCaseId)
    setNewSequenceName('')
    setSelectedSequenceId(sequence.sequence_id)
  }, [effectiveCaseId, loadCaseArtifacts, newSequenceName, sequences.length])

  const removeSequence = useCallback(async (sequence: ClipSequenceRecord) => {
    if (!effectiveCaseId) return
    if (!window.confirm(`Delete sequence "${sequence.name}"?`)) return
    await deleteSequence(effectiveCaseId, sequence.sequence_id)
    await loadCaseArtifacts(effectiveCaseId)
    if (selectedSequenceId === sequence.sequence_id) {
      setSelectedSequenceId(null)
    }
  }, [effectiveCaseId, loadCaseArtifacts, selectedSequenceId])

  const renameSequence = useCallback(async (sequence: ClipSequenceRecord, nextName: string) => {
    if (!effectiveCaseId) return
    const trimmed = nextName.trim()
    if (!trimmed) return

    const updated: ClipSequenceRecord = {
      ...sequence,
      name: trimmed,
      updated_at: new Date().toISOString(),
    }

    await saveSequence(effectiveCaseId, updated)
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

  const commitSequenceRename = useCallback(async (sequence: ClipSequenceRecord) => {
    const draftName = sequenceNameDrafts[sequence.sequence_id] ?? sequence.name
    const trimmed = draftName.trim()
    if (!trimmed) {
      setSequenceNameDrafts((prev) => ({ ...prev, [sequence.sequence_id]: sequence.name }))
      return
    }
    if (trimmed === sequence.name) return
    await renameSequence(sequence, trimmed)
  }, [renameSequence, sequenceNameDrafts])

  const addClipToSequence = useCallback(async (sequence: ClipSequenceRecord, clipId: string) => {
    if (!effectiveCaseId) return
    const clip = clips.find((item) => item.clip_id === clipId)
    if (!clip) return

    const nextEntries: ClipSequenceEntry[] = [
      ...sequence.entries,
      {
        clip_id: clip.clip_id,
        source_media_key: clip.source_media_key,
        order: sequence.entries.length,
      },
    ]

    await saveSequence(effectiveCaseId, {
      ...sequence,
      entries: nextEntries,
      updated_at: new Date().toISOString(),
    })
    await loadCaseArtifacts(effectiveCaseId)
  }, [clips, effectiveCaseId, loadCaseArtifacts])

  const removeSequenceEntry = useCallback(async (sequence: ClipSequenceRecord, index: number) => {
    if (!effectiveCaseId) return

    const nextEntries = sequence.entries
      .filter((_, idx) => idx !== index)
      .map((entry, idx) => ({ ...entry, order: idx }))

    await saveSequence(effectiveCaseId, {
      ...sequence,
      entries: nextEntries,
      updated_at: new Date().toISOString(),
    })
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

  const moveSequenceEntry = useCallback(async (sequence: ClipSequenceRecord, from: number, to: number) => {
    if (!effectiveCaseId) return
    if (to < 0 || to >= sequence.entries.length) return

    const next = [...sequence.entries]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)

    const normalized = next.map((entry, idx) => ({ ...entry, order: idx }))
    await saveSequence(effectiveCaseId, {
      ...sequence,
      entries: normalized,
      updated_at: new Date().toISOString(),
    })
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

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
      setSequenceError('Select clips before presenting this sequence.')
      return
    }

    setSequenceError('')
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
              const normalized = normalizeTranscript(raw, key)
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

        await playRange(clip.start_time, clip.end_time, clip.clip_id)

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
      setSequenceError(message)
      sequenceAbortRef.current = true
    } finally {
      setTitleCard(null)
      setShowBlackScreen(false)
      setWaitingForResume(false)
      sequenceResumeRef.current = null
      await exitPresentationMode()
    }
  }, [clipGapSeconds, clips, currentMediaKey, enterPresentationMode, exitPresentationMode, loadTranscriptByKey, playRange, sequencePauseBehavior, waitForCanPlay, waitForUserResume])

  const excerptLinesForClip = useCallback((record: ViewerTranscript, clip: ClipRecord) => {
    return record.lines.filter(
      (line) => line.end >= clip.start_time - SEARCH_TOLERANCE && line.start <= clip.end_time + SEARCH_TOLERANCE,
    )
  }, [])

  const requestClipPdfBlob = useCallback(async (record: ViewerTranscript, clip: ClipRecord) => {
    const lineEntries = excerptLinesForClip(record, clip)
    if (!lineEntries.length) {
      throw new Error('No transcript lines overlap this clip range.')
    }

    const response = await authenticatedFetch('/api/format-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title_data: record.title_data,
        lines_per_page: record.lines_per_page,
        line_entries: lineEntries,
      }),
    })

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail?.detail || 'Failed to export clip PDF')
    }

    return response.blob()
  }, [excerptLinesForClip])

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(objectUrl)
  }, [])

  const exportClipPdf = useCallback(async (clip: ClipRecord) => {
    if (!transcript) return
    setClipError('')
    setExporting(true)
    try {
      const record = clip.source_media_key === transcript.media_key
        ? transcript
        : transcriptCacheRef.current[clip.source_media_key] || null

      const transcriptRecord = record || await loadTranscriptByKey(clip.source_media_key, true)
      if (!transcriptRecord) {
        throw new Error('Unable to load transcript for clip export.')
      }

      const blob = await requestClipPdfBlob(transcriptRecord, clip)
      const filename = sanitizeFilename(`${clip.name || 'clip'}-${clip.clip_id}`)
      downloadBlob(blob, `${filename}.pdf`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export clip PDF'
      setClipError(message)
    } finally {
      setExporting(false)
    }
  }, [downloadBlob, loadTranscriptByKey, requestClipPdfBlob, transcript])

  const exportSequenceZip = useCallback(async (sequence: ClipSequenceRecord) => {
    setExporting(true)
    setSequenceError('')

    try {
      const zip = new JSZip()
      const folder = zip.folder(sanitizeFilename(sequence.name))
      if (!folder) throw new Error('Failed to initialize zip output')

      const orderedEntries = [...sequence.entries].sort((a, b) => a.order - b.order)
      let exportIndex = 1

      for (const entry of orderedEntries) {
        const clip = clips.find((item) => item.clip_id === entry.clip_id)
        if (!clip) continue

        const transcriptRecord = transcriptCacheRef.current[entry.source_media_key] || await loadTranscriptByKey(entry.source_media_key, true)
        if (!transcriptRecord) continue

        const pdfBlob = await requestClipPdfBlob(transcriptRecord, clip)
        const index = String(exportIndex).padStart(2, '0')
        const baseName = sanitizeFilename(clip.name || `clip-${clip.clip_id}`)
        folder.file(`${index}-${baseName}.pdf`, pdfBlob)
        exportIndex += 1
      }

      const output = await zip.generateAsync({ type: 'blob' })
      downloadBlob(output, `${sanitizeFilename(sequence.name)}.zip`)
      setSequenceError('Media clip files are disabled until ffmpeg worker integration is merged.')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export sequence zip'
      setSequenceError(message)
    } finally {
      setExporting(false)
    }
  }, [clips, downloadBlob, loadTranscriptByKey, requestClipPdfBlob])

  const getViewerTemplate = useCallback(async () => {
    if (templateCacheRef.current) return templateCacheRef.current

    const response = await authenticatedFetch('/api/viewer-template')
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail?.detail || 'Failed to fetch viewer template')
    }

    const template = await response.text()
    templateCacheRef.current = template
    return template
  }, [])

  const toBase64 = useCallback(async (file: File) => {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize)
      binary += String.fromCharCode(...Array.from(chunk))
    }
    return btoa(binary)
  }, [])

  const exportStandaloneViewer = useCallback(async () => {
    if (!transcript) return
    setExporting(true)

    try {
      const template = await getViewerTemplate()
      const payload = linesToViewerPayload(transcript)
      const transcriptJson = escapeScriptBoundary(JSON.stringify(payload))

      const mediaHandleId = transcript.media_handle_id || transcript.media_key
      const mediaFile = await getMediaFile(mediaHandleId)
      if (!mediaFile) {
        throw new Error('Media file not available. Relink media before exporting standalone viewer.')
      }

      const fileSizeMb = mediaFile.size / (1024 * 1024)
      const proceed = window.confirm(
        `This export embeds the entire media file (${fileSizeMb.toFixed(1)} MB). Continue?`,
      )
      if (!proceed) return

      const mediaBase64 = await toBase64(mediaFile)

      let html = template.replace('__TRANSCRIPT_JSON__', transcriptJson)
      const mediaTag = `<script id="media-data" type="application/octet-stream">${mediaBase64}</script>`
      const mediaPlaceholder = '<script id="media-data" type="application/octet-stream"></script>'
      const htmlWithMedia = html.replace(mediaPlaceholder, mediaTag)
      if (htmlWithMedia === html) {
        console.warn('Standalone viewer template is missing media placeholder script tag.')
        throw new Error('Standalone viewer template missing media placeholder; embedded media export failed.')
      }
      html = htmlWithMedia

      const blob = new Blob([html], { type: 'text/html' })
      const baseName = sanitizeFilename(transcript.title_data?.FILE_NAME || transcript.media_filename || transcript.media_key)
      downloadBlob(blob, `${baseName}-viewer.html`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export standalone viewer'
      setError(message)
    } finally {
      setExporting(false)
    }
  }, [downloadBlob, getViewerTemplate, toBase64, transcript])

  const exportTranscriptPdf = useCallback(() => {
    if (!transcript?.pdf_base64) return
    const bytes = atob(transcript.pdf_base64)
    const array = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i += 1) {
      array[i] = bytes.charCodeAt(i)
    }
    const mediaNameRaw = transcript.title_data?.FILE_NAME || transcript.media_filename || transcript.media_key || 'transcript'
    const mediaBaseName = sanitizeDownloadStem(String(mediaNameRaw).replace(/\.[^.]+$/, ''))
    downloadBlob(new Blob([array], { type: 'application/pdf' }), `${mediaBaseName} transcript.pdf`)
  }, [downloadBlob, transcript?.media_filename, transcript?.media_key, transcript?.pdf_base64, transcript?.title_data])

  const noTranscript = !currentMediaKey

  if (appVariant !== 'criminal') {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
          Viewer is available in the criminal variant only.
        </div>
      </div>
    )
  }

  if (noTranscript) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center">
          <h2 className="text-xl font-semibold text-gray-900">No Transcript Selected</h2>
          <p className="mt-2 text-sm text-gray-600">Open a transcript from Cases or Recent to launch Viewer.</p>
          <Link href={routes.home()} className="btn-primary mt-6 inline-flex px-4 py-2">
            Back to Dashboard
          </Link>
        </div>
      </div>
    )
  }

  const presentationControlsVisible = !presentationMode || presentationUiVisible

  const playerSharedProps = {
    controls: presentationControlsVisible,
    src: mediaUrl || undefined,
    onTimeUpdate: handleTimeUpdate,
    onLoadedMetadata: handleLoadedMetadata,
  }

  const isDocumentMode = viewerMode === 'document'
  const toolsVisible = !presentationMode && showToolsPanel
  const mediaStatusOverlay = (
    <>
      {!mediaAvailable && (
        <div className="absolute bottom-3 left-3 right-3 rounded border border-amber-200 bg-amber-50/95 p-3 text-sm text-amber-900">
          <p className="mb-2">Media file not found.</p>
          <button type="button" onClick={() => void relinkMedia()} className="btn-outline px-3 py-1.5 text-xs">
            Locate File
          </button>
        </div>
      )}

      {mediaLoading && (
        <div className="absolute right-3 top-3 rounded border border-stone-300 bg-white/95 px-2 py-1 text-xs text-stone-700">
          Loading media...
        </div>
      )}
    </>
  )

  return (
    <div ref={viewerShellRef} className="h-full bg-gradient-to-b from-blue-50/55 via-stone-100 to-stone-200 text-stone-900">
      {showBlackScreen && (
        <div
          className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-black"
          onClick={() => {
            if (sequenceResumeRef.current) {
              const resume = sequenceResumeRef.current
              sequenceResumeRef.current = null
              setWaitingForResume(false)
              resume()
            }
          }}
        >
          <div className="text-sm text-white/30 select-none">Press space to continue</div>
        </div>
      )}

      {titleCard?.visible && !showBlackScreen && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/45 ${waitingForResume ? 'cursor-pointer' : 'pointer-events-none'}`}
          onClick={() => {
            if (sequenceResumeRef.current) {
              const resume = sequenceResumeRef.current
              sequenceResumeRef.current = null
              setWaitingForResume(false)
              resume()
            }
          }}
        >
          <div className="rounded-xl border border-stone-300 bg-stone-50/95 px-8 py-6 text-center text-stone-900 shadow-2xl">
            <div className="text-2xl font-semibold">{titleCard.title}</div>
            <div className="mt-2 text-sm text-stone-700">{titleCard.meta}</div>
            {titleCard.subtitle && (
              <div className="mt-1 text-xs text-stone-500">{titleCard.subtitle}</div>
            )}
            {waitingForResume && (
              <div className="mt-3 text-xs text-stone-400 select-none">Press space to continue</div>
            )}
          </div>
        </div>
      )}

      {!presentationMode && (
        <div className="border-b border-blue-100 bg-white/95 px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (queryCaseId) {
                    guardedPush(router, routes.caseDetail(queryCaseId))
                  } else {
                    guardedPush(router, routes.home())
                  }
                }}
                className="btn-outline px-3 py-1.5 text-sm"
              >
                {queryCaseId ? 'Back to Case' : 'Back to Dashboard'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (currentMediaKey) guardedPush(router, routes.editor(currentMediaKey))
                }}
                className="btn-outline px-3 py-1.5 text-sm"
              >
                Edit Transcript
              </button>
            </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center rounded-lg border border-blue-200 bg-blue-50/60 p-0.5">
                  <button
                    type="button"
                    className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'document' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                    onClick={() => setViewerMode('document')}
                  >
                    Doc
                  </button>
                  <button
                    type="button"
                    className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'caption' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                    onClick={() => setViewerMode('caption')}
                  >
                    Caption
                  </button>
                </div>

              <button
                type="button"
                className="btn-outline px-3 py-1.5 text-sm"
                onClick={() => setShowToolsPanel((prev) => !prev)}
              >
                {showToolsPanel ? 'Hide Tools' : 'Show Tools'}
              </button>

              <button
                type="button"
                className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-900 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={exportTranscriptPdf}
                disabled={!transcript?.pdf_base64}
                title={transcript?.pdf_base64 ? 'Download transcript PDF' : 'PDF is not available for this transcript'}
              >
                Download PDF
              </button>

              <div ref={exportMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setExportMenuOpen((open) => !open)}
                  className="btn-outline px-3 py-1.5 text-sm"
                >
                  Export
                </button>
                {exportMenuOpen && (
                  <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
                    <button
                      type="button"
                      className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-gray-50"
                      onClick={() => {
                        setExportMenuOpen(false)
                        exportTranscriptPdf()
                      }}
                      disabled={!transcript?.pdf_base64}
                    >
                      Download PDF
                    </button>
                    <button
                      type="button"
                      className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-gray-50"
                      onClick={() => {
                        setExportMenuOpen(false)
                        void exportStandaloneViewer()
                      }}
                    >
                      Standalone HTML (Embedded Media)
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setSequenceState({ phase: 'idle' })
                  void enterPresentationMode()
                }}
                className="btn-primary px-3 py-1.5 text-sm"
              >
                Present
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      )}

      <div className={`min-h-0 ${presentationMode ? 'h-screen' : 'h-[calc(100vh-74px)]'}`}>
        <div className={`grid h-full min-h-0 ${toolsVisible ? 'grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]' : 'grid-cols-1'}`}>
          <div className={`grid h-full min-h-0 ${isDocumentMode ? 'grid-cols-1 xl:grid-cols-[minmax(340px,44%)_minmax(0,1fr)]' : 'grid-cols-1'}`}>
            <section
              className="relative flex min-h-0 flex-col bg-stone-100"
              onMouseMove={() => {
                if (presentationMode) revealPresentationUi()
              }}
              onMouseLeave={() => {
                if (presentationMode) {
                  clearPresentationUiTimer()
                  setPresentationUiVisible(false)
                }
              }}
            >
              {presentationMode && (
                <div
                  onMouseEnter={revealPresentationUi}
                  onMouseMove={revealPresentationUi}
                  className={`absolute right-4 top-4 z-30 flex items-center gap-2 transition-opacity duration-200 ${
                    presentationControlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                  }`}
                >
                  <div className="flex items-center rounded border border-blue-200 bg-white/95 p-0.5 shadow-sm">
                    <button
                      type="button"
                      className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'document' ? 'bg-blue-700 text-white' : 'text-blue-800 hover:bg-blue-100/80'}`}
                      onClick={() => setViewerMode('document')}
                    >
                      Doc
                    </button>
                    <button
                      type="button"
                      className={`rounded px-2.5 py-1 text-xs font-medium ${viewerMode === 'caption' ? 'bg-blue-700 text-white' : 'text-blue-800 hover:bg-blue-100/80'}`}
                      onClick={() => setViewerMode('caption')}
                    >
                      Caption
                    </button>
                  </div>
                  <button
                    type="button"
                    className="rounded border border-stone-300 bg-white/95 px-3 py-1.5 text-sm text-stone-800 shadow-sm hover:bg-stone-100"
                    onClick={() => void exitPresentationMode()}
                  >
                    Exit
                  </button>
                </div>
              )}

              {!presentationMode && (
                <div className="border-b border-blue-100 bg-white/95 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-medium text-stone-900">
                      {transcript?.title_data?.CASE_NAME || transcript?.title_data?.FILE_NAME || transcript?.media_key}
                    </div>
                    <div className="text-xs font-medium text-blue-800/80">
                      {formatClock(currentTime)} / {formatClock(duration || transcript?.audio_duration || 0)}
                    </div>
                  </div>
                </div>
              )}

              <div className="min-h-0 flex-1 p-3">
                {isVideo ? (
                  /* Video element: layout differs by mode */
                  viewerMode === 'caption' ? (
                    <div className="flex h-full min-h-0 flex-col gap-3">
                      <div className="relative min-h-0 flex-1 rounded-xl border border-blue-200 bg-white">
                        <video
                          ref={videoRef}
                          {...playerSharedProps}
                          className="h-full w-full rounded-xl bg-black object-contain"
                        />
                        {mediaStatusOverlay}
                      </div>
                      <div className="shrink-0 max-h-[24vh] overflow-y-auto rounded-xl border border-stone-300 bg-[#fffef8] px-6 py-4 shadow-sm">
                        <div className="space-y-2 font-mono">
                          <div className="text-base text-stone-400">{captionWindow.prev2}</div>
                          <div className="text-lg text-stone-500">{captionWindow.prev1}</div>
                          <div className="rounded border border-blue-200 bg-blue-50/45 px-3 py-2 text-2xl leading-snug text-stone-900">
                            {captionWindow.current}
                          </div>
                          <div className="text-lg text-stone-500">{captionWindow.next1}</div>
                          <div className="text-base text-stone-400">{captionWindow.next2}</div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="relative h-full rounded-xl border border-stone-300 bg-stone-50">
                      <video
                        ref={videoRef}
                        {...playerSharedProps}
                        className="h-full w-full rounded-xl bg-black object-contain"
                      />
                      {mediaStatusOverlay}
                    </div>
                  )
                ) : (
                  /* Audio: waveform always mounted, captions shown below in caption mode */
                  <div className="flex h-full min-h-0 flex-col gap-3">
                    <audio
                      ref={audioRef}
                      {...playerSharedProps}
                      className="hidden"
                    />
                    <div className="relative min-h-0 flex-1 rounded-xl overflow-hidden bg-gradient-to-b from-slate-800 to-slate-900">
                      <div className="absolute inset-0 flex items-center px-6">
                        <div ref={waveformRef} className="w-full" />
                      </div>
                      {mediaStatusOverlay}
                    </div>
                    {viewerMode === 'caption' && (
                      <div className="shrink-0 max-h-[24vh] overflow-y-auto rounded-xl border border-stone-300 bg-[#fffef8] px-6 py-4 shadow-sm">
                        <div className="space-y-2 font-mono">
                          <div className="text-base text-stone-400">{captionWindow.prev2}</div>
                          <div className="text-lg text-stone-500">{captionWindow.prev1}</div>
                          <div className="rounded border border-blue-200 bg-blue-50/45 px-3 py-2 text-2xl leading-snug text-stone-900">
                            {captionWindow.current}
                          </div>
                          <div className="text-lg text-stone-500">{captionWindow.next1}</div>
                          <div className="text-base text-stone-400">{captionWindow.next2}</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            {isDocumentMode && (
              <section className="relative flex min-h-0 flex-col bg-gradient-to-b from-blue-50/35 to-stone-100 text-stone-900">
                {!presentationMode && (
                  <div className="px-4 pb-2 pt-3">
                    <div className="rounded-xl border border-blue-100 bg-white p-2 shadow-sm">
                      <div className="flex items-center gap-2">
                        <input
                          ref={searchInputRef}
                          className="h-9 flex-1 rounded border border-blue-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-500 focus:border-blue-400 focus:outline-none"
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              goToSearchResult(event.shiftKey ? -1 : 1)
                            }
                          }}
                          placeholder="Search transcript"
                        />
                        <button type="button" className="btn-outline border-blue-200 px-2 py-1 text-xs text-blue-800 hover:bg-blue-50" onClick={() => goToSearchResult(-1)} disabled={!searchMatches.length}>
                          Prev
                        </button>
                        <button type="button" className="btn-outline border-blue-200 px-2 py-1 text-xs text-blue-800 hover:bg-blue-50" onClick={() => goToSearchResult(1)} disabled={!searchMatches.length}>
                          Next
                        </button>
                        <span className="min-w-[54px] text-right text-xs text-blue-700/80">
                          {searchMatches.length ? `${((searchCursor % searchMatches.length) + searchMatches.length) % searchMatches.length + 1}/${searchMatches.length}` : '0/0'}
                        </span>
                      </div>
                      <div className="mt-1.5 text-[11px] text-blue-700/75">
                        Single-click selects a line. Double-click starts playback from that line.
                      </div>
                    </div>
                  </div>
                )}

                <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto px-4 pb-6">
                  {showReturnToCurrent && activeLineId && (
                    <div className="sticky top-2 z-20 mb-2 flex justify-end">
                      <button type="button" className="rounded border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800" onClick={returnToCurrentLine}>
                        Return to current line
                      </button>
                    </div>
                  )}

                  {isLoading ? (
                    <div className="rounded-xl border border-blue-100 bg-white px-4 py-6 text-sm text-stone-600">
                      Loading transcript...
                    </div>
                  ) : groupedPages.length === 0 ? (
                    <div className="rounded-xl border border-blue-100 bg-white px-4 py-6 text-sm text-stone-600">
                      No transcript lines available.
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {groupedPages.map((pageBlock) => (
                        <div
                          key={pageBlock.page}
                          className="relative mx-auto w-full max-w-[8.5in] bg-white shadow-[0_4px_24px_rgba(15,23,42,0.12)]"
                          style={{ padding: '24px' }}
                        >
                          {/* Double page border */}
                          <div
                            className="absolute inset-0 border border-stone-400 pointer-events-none"
                            style={{ margin: '8px' }}
                          />
                          <div
                            className="absolute inset-0 border border-stone-400 pointer-events-none"
                            style={{ margin: '12px' }}
                          />

                          <div
                            className="relative font-mono"
                            style={{ fontFamily: '"Courier New", Courier, monospace' }}
                          >
                            <div>
                              {pageBlock.lines.map((line) => {
                                const active = activeLineId === line.id
                                const selected = selectedLineId === line.id
                                const match = searchMatchSet.has(line.id)
                                const currentMatch = currentSearchLineId === line.id
                                const lineDisplay = splitSpeakerPrefix(line)

                                const lineClasses = [
                                  'group grid cursor-pointer grid-cols-[36px_minmax(0,1fr)] gap-2 px-1 font-mono text-[12pt] leading-[2] text-stone-900 transition-colors hover:bg-blue-50/30',
                                  active ? 'bg-amber-100/80' : '',
                                  selected ? 'ring-1 ring-inset ring-blue-400 bg-blue-50/70' : '',
                                  match ? 'bg-amber-50' : '',
                                  currentMatch ? 'outline outline-1 outline-amber-400' : '',
                                ]

                                return (
                                  <div
                                    key={line.id}
                                    ref={(node) => {
                                      lineRefs.current[line.id] = node
                                    }}
                                    className={lineClasses.join(' ')}
                                    onClick={() => {
                                      setSelectedLineId(line.id)
                                    }}
                                    onDoubleClick={() => {
                                      setSelectedLineId(line.id)
                                      seekToLine(line, true)
                                    }}
                                  >
                                    <div className="pt-0.5 text-right text-[10px] tabular-nums text-stone-400 select-none">
                                      {line.line || '-'}
                                    </div>
                                    <div className="whitespace-pre-wrap break-words">
                                      {lineDisplay.speakerLabel ? (
                                        <>
                                          {lineDisplay.leading}
                                          <span className="font-bold text-stone-900">
                                            {lineDisplay.speakerLabel}
                                          </span>
                                          {lineDisplay.trailing}
                                        </>
                                      ) : (
                                        lineDisplay.lineText || line.text
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>

                            {/* Page number at bottom center */}
                            <div className="mt-2 text-center text-[10px] font-mono tabular-nums text-stone-500 select-none">
                              {pageBlock.page}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>

          {toolsVisible && (
            <aside className="flex h-full min-h-0 flex-col border-l border-blue-100 bg-gradient-to-b from-white to-blue-50/35">
              <div className="border-b border-blue-100 px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-gray-900">Tools</div>
                  <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => setShowToolsPanel(false)}>
                    Hide
                  </button>
                </div>
                <div className="mt-3 flex items-center rounded-lg border border-blue-200 bg-blue-50/60 p-0.5">
                  <button
                    type="button"
                    className={`flex-1 rounded px-2.5 py-1.5 text-xs font-medium ${activeToolsTab === 'clips' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                    onClick={() => setActiveToolsTab('clips')}
                  >
                    Clips
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded px-2.5 py-1.5 text-xs font-medium ${activeToolsTab === 'sequences' ? 'bg-blue-700 text-white shadow-sm' : 'text-blue-800 hover:bg-blue-100/80'}`}
                    onClick={() => setActiveToolsTab('sequences')}
                  >
                    Sequences
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {activeToolsTab === 'clips' ? (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-gray-200 p-3">
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-gray-900">Clip Builder</h3>
                        {clipsLoading && <span className="text-xs text-gray-500">Loading...</span>}
                      </div>

                      {!canEditClips && (
                        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          Clips require case context. Open this transcript from Case Detail to edit clips.
                        </div>
                      )}

                      <div className="space-y-2">
                        <input
                          type="text"
                          value={clipName}
                          onChange={(e) => setClipName(e.target.value)}
                          className="input-field h-9 w-full text-sm"
                          placeholder="Clip name"
                          disabled={!canEditClips}
                        />

                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            value={clipStart}
                            onChange={(e) => setClipStart(e.target.value)}
                            className="input-field h-9 text-sm"
                            placeholder="Start (0:00)"
                            disabled={!canEditClips}
                          />
                          <input
                            type="text"
                            value={clipEnd}
                            onChange={(e) => setClipEnd(e.target.value)}
                            className="input-field h-9 text-sm"
                            placeholder="End (0:00)"
                            disabled={!canEditClips}
                          />
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-outline px-2 py-1 text-xs"
                            disabled={!canEditClips}
                            onClick={() => setClipStart(formatClock(currentTime))}
                          >
                            Set Start
                          </button>
                          <button
                            type="button"
                            className="btn-outline px-2 py-1 text-xs"
                            disabled={!canEditClips}
                            onClick={() => setClipEnd(formatClock(currentTime))}
                          >
                            Set End
                          </button>
                          <button
                            type="button"
                            className="btn-outline px-2 py-1 text-xs"
                            disabled={!canEditClips || !selectedLineId}
                            onClick={() => {
                              const selected = transcript?.lines.find((line) => line.id === selectedLineId)
                              if (selected) setClipStart(formatClock(selected.start))
                            }}
                          >
                            Start from line
                          </button>
                          <button
                            type="button"
                            className="btn-outline px-2 py-1 text-xs"
                            disabled={!canEditClips || !selectedLineId}
                            onClick={() => {
                              const selected = transcript?.lines.find((line) => line.id === selectedLineId)
                              if (selected) setClipEnd(formatClock(selected.end))
                            }}
                          >
                            End from line
                          </button>
                        </div>

                        <button
                          type="button"
                          className="btn-primary w-full px-3 py-2 text-sm"
                          disabled={!canEditClips}
                          onClick={() => void createClip()}
                        >
                          Save Clip
                        </button>
                      </div>
                    </div>

                    {clipError && (
                      <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                        {clipError}
                      </div>
                    )}

                    <div className="space-y-3">
                      {groupedVisibleClips.length === 0 ? (
                        <div className="rounded border border-dashed border-gray-200 p-3 text-xs text-gray-500">
                          No clips created yet.
                        </div>
                      ) : (
                        groupedVisibleClips.map(([sourceKey, sourceClips]) => (
                          <div key={sourceKey}>
                            {queryCaseId && (
                              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                {sourceKey === currentMediaKey ? 'Current recording' : sourceKey}
                              </div>
                            )}
                            <div className="space-y-2">
                              {sourceClips.map((clip) => (
                                <div
                                  key={clip.clip_id}
                                  className={`rounded-lg border p-2 text-xs ${activeClipPlaybackId === clip.clip_id ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}
                                  draggable={canEditClips}
                                  onDragStart={() => setDragClipId(clip.clip_id)}
                                  onDragOver={(event) => {
                                    if (!canEditClips) return
                                    event.preventDefault()
                                  }}
                                  onDrop={(event) => {
                                    if (!canEditClips) return
                                    event.preventDefault()
                                    if (dragClipId) {
                                      void reorderVisibleClips(dragClipId, clip.clip_id)
                                    }
                                    setDragClipId(null)
                                  }}
                                >
                                  {editingClipId === clip.clip_id ? (
                                    <div className="space-y-2">
                                      <input
                                        className="input-field h-8 w-full text-xs"
                                        value={editClipName}
                                        onChange={(e) => setEditClipName(e.target.value)}
                                      />
                                      <div className="grid grid-cols-2 gap-2">
                                        <input
                                          className="input-field h-8 text-xs"
                                          value={editClipStart}
                                          onChange={(e) => setEditClipStart(e.target.value)}
                                        />
                                        <input
                                          className="input-field h-8 text-xs"
                                          value={editClipEnd}
                                          onChange={(e) => setEditClipEnd(e.target.value)}
                                        />
                                      </div>
                                      <div className="flex gap-2">
                                        <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void saveEditedClip()}>
                                          Save
                                        </button>
                                        <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => setEditingClipId(null)}>
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="font-medium text-gray-800">{clip.name}</div>
                                      <div className="mt-0.5 text-gray-600">{formatRange(clip.start_time, clip.end_time)}</div>
                                      <div className="mt-2 flex flex-wrap gap-1">
                                        <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => void playClip(clip)}>
                                          Play
                                        </button>
                                        <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => startEditingClip(clip)}>
                                          Edit
                                        </button>
                                        <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => void exportClipPdf(clip)} disabled={exporting}>
                                          Export PDF
                                        </button>
                                        <button type="button" className="btn-outline px-2 py-1 text-xs text-red-700" onClick={() => void removeClip(clip)}>
                                          Delete
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-gray-200 p-3">
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-gray-900">Sequences</h3>
                      </div>

                      <label className="mb-3 block text-xs text-gray-700">
                        <span className="mb-1 block font-medium">Between clips</span>
                        <select
                          className="w-full rounded-lg border border-primary-300 bg-white px-2 py-1.5 text-xs shadow-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
                          value={sequencePauseBehavior}
                          onChange={(e) => setSequencePauseBehavior(e.target.value as SequencePauseBehavior)}
                        >
                          <option value="black-screen">Pause on black screen</option>
                          <option value="title-card">Pause on title card</option>
                          <option value="continuous">Play continuously</option>
                        </select>
                      </label>

                      {sequencePauseBehavior === 'continuous' && (
                        <label className="mb-3 block text-xs text-gray-700">
                          <span className="mb-1 block font-medium">Gap between clips (seconds)</span>
                          <input
                            type="number"
                            min="0"
                            max="30"
                            step="0.5"
                            className="w-full rounded-lg border border-primary-300 bg-white px-2 py-1.5 text-xs shadow-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
                            value={clipGapSeconds}
                            onChange={(e) => {
                              const val = Number(e.target.value)
                              if (Number.isFinite(val) && val >= 0) setClipGapSeconds(val)
                            }}
                          />
                        </label>
                      )}

                      {sequenceState.phase !== 'idle' && (
                        <div className="mb-2 text-xs text-primary-700">
                          Playback: {sequenceState.phase}
                        </div>
                      )}

                      <div className="space-y-2">
                        <input
                          className="input-field h-9 w-full text-sm"
                          value={newSequenceName}
                          onChange={(e) => setNewSequenceName(e.target.value)}
                          placeholder="New sequence name"
                          disabled={!canEditClips}
                        />
                        <button
                          type="button"
                          className="btn-primary w-full px-3 py-1.5 text-sm"
                          disabled={!canEditClips}
                          onClick={() => void createSequence()}
                        >
                          Create Sequence
                        </button>
                      </div>
                    </div>

                    {sequenceError && (
                      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        {sequenceError}
                      </div>
                    )}

                    <div className="space-y-2">
                      {sequences.length === 0 ? (
                        <div className="rounded border border-dashed border-gray-200 p-3 text-xs text-gray-500">
                          No sequences yet.
                        </div>
                      ) : (
                        sequences.map((sequence) => {
                          const ordered = [...sequence.entries].sort((a, b) => a.order - b.order)
                          const totalDuration = ordered.reduce((total, entry) => {
                            const clip = clips.find((item) => item.clip_id === entry.clip_id)
                            if (!clip) return total
                            return total + Math.max(0, clip.end_time - clip.start_time)
                          }, 0)

                          return (
                            <div key={sequence.sequence_id} className="rounded-lg border border-gray-200 bg-gray-50 p-2">
                              <div className="flex items-center justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => setSelectedSequenceId((prev) => prev === sequence.sequence_id ? null : sequence.sequence_id)}
                                  className="flex-1 text-left"
                                >
                                  <div className="text-xs font-semibold text-gray-900">{sequence.name}</div>
                                  <div className="text-[11px] text-gray-600">
                                    {ordered.length} clips • {formatClock(totalDuration)}
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  className="btn-outline px-2 py-1 text-xs"
                                  onClick={() => void runSequencePresentation(sequence)}
                                >
                                  Present
                                </button>
                                <button
                                  type="button"
                                  className="btn-outline px-2 py-1 text-xs"
                                  onClick={() => void exportSequenceZip(sequence)}
                                  disabled={exporting}
                                >
                                  ZIP
                                </button>
                                <button
                                  type="button"
                                  className="btn-outline px-2 py-1 text-xs text-red-700"
                                  onClick={() => void removeSequence(sequence)}
                                >
                                  Delete
                                </button>
                              </div>

                              {selectedSequenceId === sequence.sequence_id && (
                                <div className="mt-2 space-y-2 border-t border-gray-200 pt-2">
                                  <input
                                    className="input-field h-8 w-full text-xs"
                                    value={sequenceNameDrafts[sequence.sequence_id] ?? sequence.name}
                                    onChange={(event) => {
                                      const nextName = event.target.value
                                      setSequenceNameDrafts((prev) => ({ ...prev, [sequence.sequence_id]: nextName }))
                                    }}
                                    onBlur={() => {
                                      void commitSequenceRename(sequence)
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        event.currentTarget.blur()
                                      }
                                    }}
                                  />

                                  <select
                                    className="w-full rounded-lg border border-primary-300 bg-white px-2 py-1.5 text-xs shadow-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
                                    onChange={(event) => {
                                      const value = event.target.value
                                      if (value) {
                                        void addClipToSequence(sequence, value)
                                        event.target.value = ''
                                      }
                                    }}
                                  >
                                    <option value="">Add clip...</option>
                                    {clips.map((clip) => (
                                      <option key={clip.clip_id} value={clip.clip_id}>
                                        {clip.name} ({formatRange(clip.start_time, clip.end_time)})
                                      </option>
                                    ))}
                                  </select>

                                  <div className="space-y-1">
                                    {ordered.map((entry, index) => {
                                      const clip = clips.find((item) => item.clip_id === entry.clip_id)
                                      if (!clip) return null

                                      return (
                                        <div key={`${entry.clip_id}-${index}`} className="flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1">
                                          <div className="min-w-0 flex-1">
                                            <div className="truncate text-xs font-medium text-gray-800">{clip.name}</div>
                                            <div className="text-[11px] text-gray-600">{formatRange(clip.start_time, clip.end_time)}</div>
                                          </div>
                                          <button
                                            type="button"
                                            className="btn-outline px-1.5 py-0.5 text-[11px]"
                                            onClick={() => void moveSequenceEntry(sequence, index, index - 1)}
                                            disabled={index === 0}
                                          >
                                            ↑
                                          </button>
                                          <button
                                            type="button"
                                            className="btn-outline px-1.5 py-0.5 text-[11px]"
                                            onClick={() => void moveSequenceEntry(sequence, index, index + 1)}
                                            disabled={index === ordered.length - 1}
                                          >
                                            ↓
                                          </button>
                                          <button
                                            type="button"
                                            className="btn-outline px-1.5 py-0.5 text-[11px] text-red-700"
                                            onClick={() => void removeSequenceEntry(sequence, index)}
                                          >
                                            x
                                          </button>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
