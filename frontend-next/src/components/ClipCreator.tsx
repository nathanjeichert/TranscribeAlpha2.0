'use client'

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorSessionResponse, ClipSummary } from '@/components/TranscriptEditor'
import { buildMediaUrl, authenticatedFetch } from '@/utils/auth'

interface ClipCreatorProps {
  session: EditorSessionResponse | null
  mediaKey: string | null
  mediaUrl?: string
  mediaType?: string
  onSessionRefresh: (session: EditorSessionResponse) => void
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
  onOpenHistory?: () => void
  appVariant?: 'oncue' | 'criminal'
}

interface ClipLineEntry {
  id: string
  speaker: string
  text: string
  start: number
  end: number
  page?: number | null
  line?: number | null
  pgln?: number | null
  is_continuation?: boolean
}

interface ClipDetailResponse {
  clip_id: string
  name: string
  created_at: string
  duration: number
  start_time: number
  end_time: number
  start_pgln?: number | null
  end_pgln?: number | null
  start_page?: number | null
  start_line_number?: number | null
  end_page?: number | null
  end_line_number?: number | null
  pdf_base64?: string
  docx_base64?: string
  oncue_xml_base64: string
  viewer_html_base64?: string
  transcript: string
  lines: ClipLineEntry[]
  title_data: Record<string, string>
  lines_per_page: number
  media_blob_name?: string | null
  media_content_type?: string | null
  summary?: ClipSummary
}

interface EditorLine {
  id: string
  speaker: string
  text: string
  start: number
  end: number
  page?: number | null
  line?: number | null
  pgln?: number | null
  is_continuation?: boolean
}

type SelectionMode = 'time' | 'pageLine' | 'manual'

const formatSeconds = (value: number | undefined | null) => {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '0:00.000'
  }
  const totalMillis = Math.max(0, Math.round(value * 1000))
  const totalSeconds = Math.floor(totalMillis / 1000)
  const millis = totalMillis % 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const secondsPart = seconds.toString().padStart(2, '0')
  const millisPart = millis.toString().padStart(3, '0')
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secondsPart}.${millisPart}`
  }
  return `${minutes}:${secondsPart}.${millisPart}`
}

const parseTimeInput = (value: string): number | null => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const parts = trimmed.split(':')
  let seconds = 0
  let multiplier = 1
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const component = parts[index].trim()
    if (!component) {
      return null
    }
    const numeric = Number(component)
    if (Number.isNaN(numeric)) {
      return null
    }
    seconds += numeric * multiplier
    multiplier *= 60
  }
  return seconds
}

const selectionButtonClasses = (active: boolean) =>
  `px-3 py-2 rounded-lg text-sm font-medium transition ${
    active ? 'bg-primary-900 text-white shadow-md' : 'bg-primary-100 text-primary-700 hover:bg-primary-200'
  }`

const cardSectionTitle = (label: string) => (
  <h3 className="text-lg font-medium text-primary-900 mb-3">{label}</h3>
)

export default function ClipCreator({
  session,
  mediaKey,
  mediaUrl,
  mediaType,
  onSessionRefresh,
  onDownload,
  buildFilename,
  onOpenHistory,
  appVariant = 'oncue',
}: ClipCreatorProps) {
  const lines = useMemo<EditorLine[]>(() => session?.lines ?? [], [session])
  const clipHistory = useMemo<ClipSummary[]>(() => session?.clips ?? [], [session])
  const isCriminal = appVariant === 'criminal'

  const [selectionMode, setSelectionMode] = useState<SelectionMode>('time')
  const [timeStart, setTimeStart] = useState('')
  const [timeEnd, setTimeEnd] = useState('')
  const [pageStart, setPageStart] = useState('')
  const [lineStart, setLineStart] = useState('')
  const [pageEnd, setPageEnd] = useState('')
  const [lineEnd, setLineEnd] = useState('')
  const [manualStartId, setManualStartId] = useState<string | null>(null)
  const [manualEndId, setManualEndId] = useState<string | null>(null)
  const [clipName, setClipName] = useState('')
  const [creationError, setCreationError] = useState<string | null>(null)
  const [creationMessage, setCreationMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [clipCache, setClipCache] = useState<Record<string, ClipDetailResponse>>({})
  const [activeClip, setActiveClip] = useState<ClipDetailResponse | null>(null)
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [importXmlFile, setImportXmlFile] = useState<File | null>(null)
  const [importMediaFile, setImportMediaFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [importResetKey, setImportResetKey] = useState(0)
  const [importExpanded, setImportExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(-1)
  const [showSettings, setShowSettings] = useState(false)
  const [resolvedMediaUrl, setResolvedMediaUrl] = useState<string | null>(null)

  // Search functionality
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return []
    const lowerQuery = searchQuery.toLowerCase()
    return lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => {
        const text = (line.text || '').toLowerCase()
        const speaker = (line.speaker || '').toLowerCase()
        return text.includes(lowerQuery) || speaker.includes(lowerQuery)
      })
      .map(({ idx }) => idx)
  }, [lines, searchQuery])

  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({})

  const goToSearchResult = useCallback((direction: 'next' | 'prev') => {
    if (searchMatches.length === 0) return
    let newIndex = searchCurrentIndex
    if (direction === 'next') {
      newIndex = (searchCurrentIndex + 1) % searchMatches.length
    } else {
      newIndex = (searchCurrentIndex - 1 + searchMatches.length) % searchMatches.length
    }
    setSearchCurrentIndex(newIndex)
    const lineIndex = searchMatches[newIndex]
    const el = lineRefs.current[lineIndex]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [searchMatches, searchCurrentIndex])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchCurrentIndex(-1)
  }, [])

  const baseMediaUrl = useMemo(() => {
    if (activeClip?.media_blob_name) {
      return `/api/media/${activeClip.media_blob_name}`
    }
    if (mediaUrl && mediaUrl.trim()) {
      return mediaUrl
    }
    const blobName = session?.media_blob_name
    if (blobName && blobName.trim()) {
      return `/api/media/${blobName}`
    }
    return null
  }, [mediaUrl, session?.media_blob_name, activeClip?.media_blob_name])

  const effectiveMediaType = useMemo(() => {
    if (mediaType && mediaType.trim()) {
      return mediaType
    }
    const sessionType = session?.media_content_type
    return sessionType && sessionType.trim() ? sessionType : undefined
  }, [mediaType, session?.media_content_type])

  const isVideo = useMemo(() => (effectiveMediaType ?? '').startsWith('video/'), [effectiveMediaType])
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const playerRef = isVideo ? videoRef : audioRef

  useEffect(() => {
    if (!baseMediaUrl) {
      setResolvedMediaUrl(null)
      setPreviewing(false)
      return
    }
    let isActive = true
    const resolveMedia = async () => {
      const resolved = await buildMediaUrl(baseMediaUrl)
      if (isActive) {
        setResolvedMediaUrl(resolved)
      }
    }
    void resolveMedia()
    return () => {
      isActive = false
    }
  }, [baseMediaUrl])

  useEffect(() => {
    if (!resolvedMediaUrl) {
      setPreviewing(false)
    }
  }, [resolvedMediaUrl])

  const handleMediaError = useCallback(async () => {
    if (!baseMediaUrl) return
    const currentPlayer = isVideo ? videoRef.current : audioRef.current
    const resumeTime = currentPlayer?.currentTime ?? 0
    const wasPaused = currentPlayer?.paused ?? true
    const refreshed = await buildMediaUrl(baseMediaUrl, true)
    setResolvedMediaUrl(refreshed)
    setTimeout(() => {
      const nextPlayer = isVideo ? videoRef.current : audioRef.current
      if (!nextPlayer) return
      nextPlayer.currentTime = resumeTime
      if (!wasPaused) {
        nextPlayer.play().catch(() => {})
      }
    }, 0)
  }, [baseMediaUrl, isVideo])

  useEffect(() => {
    if (!session) {
      setClipName('')
      setTimeStart('')
      setTimeEnd('')
      setPageStart('')
      setLineStart('')
      setPageEnd('')
      setLineEnd('')
      setManualStartId(null)
      setManualEndId(null)
      setActiveClip(null)
      setClipCache({})
      return
    }

    setActiveClip(null)
    setClipCache({})
    const defaultName = `Clip ${(session.clips?.length ?? 0) + 1}`
    setClipName(defaultName)
    setSelectionMode('time')
  }, [session])

  useEffect(() => {
    setImportExpanded(!session)
  }, [session])

  useEffect(() => {
    if (!session) {
      return
    }
    const sessionLines = session.lines ?? []
    if (!sessionLines.length) {
      return
    }
    const first = sessionLines[0]
    const last = sessionLines[sessionLines.length - 1]
    setTimeStart(formatSeconds(first.start))
    setTimeEnd(formatSeconds(last.end))
    setPageStart(first.page != null ? String(first.page) : '')
    setLineStart(first.line != null ? String(first.line) : '')
    setPageEnd(last.page != null ? String(last.page) : '')
    setLineEnd(last.line != null ? String(last.line) : '')
    setManualStartId(first.id)
    setManualEndId(last.id)
  }, [session])

  const parsePageInput = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  const findLineIndexById = useCallback(
    (id: string | null) => {
      if (!id) return null
      const index = lines.findIndex((line) => line.id === id)
      return index >= 0 ? index : null
    },
    [lines],
  )

  const findLineIndexByPageLine = useCallback(
    (pageStr: string, lineStr: string) => {
      const page = parsePageInput(pageStr)
      const line = parsePageInput(lineStr)
      if (page === null || line === null) {
        return null
      }
      const index = lines.findIndex((entry) => entry.page === page && entry.line === line)
      return index >= 0 ? index : null
    },
    [lines],
  )

  const findLineIndexByTime = useCallback(
    (input: string, preferStart: boolean) => {
      const seconds = parseTimeInput(input)
      if (seconds === null) return null
      if (!lines.length) return null
      if (preferStart) {
        for (let idx = 0; idx < lines.length; idx += 1) {
          const entry = lines[idx]
          if (seconds <= entry.start) return idx
          if (seconds >= entry.start && seconds <= Math.max(entry.end, entry.start)) return idx
        }
        return lines.length - 1
      }
      for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
        const entry = lines[idx]
        if (seconds >= entry.end) return idx
        if (seconds >= entry.start && seconds <= Math.max(entry.end, entry.start)) return idx
      }
      return 0
    },
    [lines],
  )

  const selectedRange = useMemo(() => {
    if (!lines.length) return null

    let startIndex: number | null = null
    let endIndex: number | null = null

    if (selectionMode === 'manual') {
      startIndex = findLineIndexById(manualStartId)
      endIndex = findLineIndexById(manualEndId)
    } else if (selectionMode === 'pageLine') {
      startIndex = findLineIndexByPageLine(pageStart, lineStart)
      endIndex = findLineIndexByPageLine(pageEnd, lineEnd)
    } else {
      startIndex = findLineIndexByTime(timeStart, true)
      endIndex = findLineIndexByTime(timeEnd, false)
    }

    if (startIndex === null || endIndex === null) {
      return null
    }

    const start = Math.min(startIndex, endIndex)
    const end = Math.max(startIndex, endIndex)
    return { startIndex: start, endIndex: end }
  }, [
    lines,
    selectionMode,
    manualStartId,
    manualEndId,
    pageStart,
    lineStart,
    pageEnd,
    lineEnd,
    timeStart,
    timeEnd,
    findLineIndexById,
    findLineIndexByPageLine,
    findLineIndexByTime,
  ])

  const selectedLines = useMemo(() => {
    if (!selectedRange) return []
    return lines.slice(selectedRange.startIndex, selectedRange.endIndex + 1)
  }, [lines, selectedRange])

  const clipBounds = useMemo(() => {
    if (!selectedRange || selectedLines.length === 0) return null
    const first = selectedLines[0]
    const last = selectedLines[selectedLines.length - 1]
    return {
      start: Math.max(0, first.start),
      end: Math.max(first.start + 0.01, last.end),
    }
  }, [selectedRange, selectedLines])

  useEffect(() => {
    if (!clipBounds || !selectedRange || !lines.length) return

    const startLine = lines[selectedRange.startIndex]
    const endLine = lines[selectedRange.endIndex]
    if (!startLine || !endLine) return

    setTimeStart(formatSeconds(startLine.start))
    setTimeEnd(formatSeconds(endLine.end))

    if (startLine.page != null && startLine.line != null) {
      setPageStart(String(startLine.page))
      setLineStart(String(startLine.line))
    }
    if (endLine.page != null && endLine.line != null) {
      setPageEnd(String(endLine.page))
      setLineEnd(String(endLine.line))
    }

    setManualStartId(startLine.id)
    setManualEndId(endLine.id)
  }, [clipBounds, selectedRange, lines])

  useEffect(() => {
    if (!previewing) {
      return
    }
    const bounds = clipBounds
    if (!bounds) {
      setPreviewing(false)
      return
    }
    const player = playerRef.current
    if (!player) {
      setPreviewing(false)
      return
    }

    const handleTimeUpdate = () => {
      if (player.currentTime >= bounds.end) {
        player.pause()
        player.currentTime = bounds.start
        setPreviewing(false)
      }
    }

    player.currentTime = bounds.start
    const playPromise = player.play()
    if (playPromise) {
      playPromise.catch(() => setPreviewing(false))
    }
    player.addEventListener('timeupdate', handleTimeUpdate)

    return () => {
      player.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [previewing, clipBounds, playerRef])

  const handleManualStart = (lineId: string) => {
    setSelectionMode('manual')
    setManualStartId(lineId)
  }

  const handleManualEnd = (lineId: string) => {
    setSelectionMode('manual')
    setManualEndId(lineId)
  }

  const handlePreviewClip = () => {
    if (!clipBounds || !resolvedMediaUrl) return
    setPreviewing(true)
  }

  const fetchClipDetail = useCallback(
    async (clipId: string): Promise<ClipDetailResponse | null> => {
      if (clipCache[clipId]) {
        return clipCache[clipId]
      }
      try {
        setHistoryLoadingId(clipId)
        const response = await authenticatedFetch(`/api/clips/${clipId}`)
        if (!response.ok) {
          return null
        }
        const data: ClipDetailResponse = await response.json()
        setClipCache((prev) => ({ ...prev, [clipId]: data }))
        return data
      } catch (err) {
        console.warn('Failed to load clip detail', err)
        return null
      } finally {
        setHistoryLoadingId(null)
      }
    },
    [clipCache],
  )

  const handleSelectClip = useCallback(
    async (clipId: string) => {
      const detail = await fetchClipDetail(clipId)
      if (detail) {
        setActiveClip(detail)
      }
    },
    [fetchClipDetail],
  )

  const handleDownloadPdf = useCallback(
    async (clipId: string) => {
      const detail = await fetchClipDetail(clipId)
      if (!detail) return
      const pdfData = detail.pdf_base64 ?? detail.docx_base64
      if (!pdfData) return
      const filename = buildFilename(detail.name.replace(/\s+/g, '-').toLowerCase(), '.pdf')
      onDownload(pdfData, filename, 'application/pdf')
    },
    [buildFilename, fetchClipDetail, onDownload],
  )

  const handleDownloadXml = useCallback(
    async (clipId: string) => {
      const detail = await fetchClipDetail(clipId)
      if (!detail) return
      const filename = buildFilename(detail.name.replace(/\s+/g, '-').toLowerCase(), '.xml')
      onDownload(detail.oncue_xml_base64, filename, 'application/xml')
    },
    [buildFilename, fetchClipDetail, onDownload],
  )

  const handleDownloadViewer = useCallback(
    async (clipId: string) => {
      const detail = await fetchClipDetail(clipId)
      if (!detail?.viewer_html_base64) return
      const filename = buildFilename(detail.name.replace(/\s+/g, '-').toLowerCase(), '.html')
      onDownload(detail.viewer_html_base64, filename, 'text/html')
    },
    [buildFilename, fetchClipDetail, onDownload],
  )

  const handleCreateClip = useCallback(async () => {
    if (!mediaKey || !session) {
      setCreationError('Load or generate a transcript before creating clips.')
      return
    }
    if (!selectedRange) {
      setCreationError('Select a valid start and end point for the clip.')
      return
    }

    const startLine = lines[selectedRange.startIndex]
    const endLine = lines[selectedRange.endIndex]
    if (!startLine || !endLine) {
      setCreationError('Unable to resolve selected transcript lines.')
      return
    }

    const payload = {
      media_key: mediaKey,
      clip_label: clipName.trim() || undefined,
      start_line_id: startLine.id,
      end_line_id: endLine.id,
      start_pgln: startLine.pgln ?? undefined,
      end_pgln: endLine.pgln ?? undefined,
      start_page: startLine.page ?? undefined,
      start_line: startLine.line ?? undefined,
      end_page: endLine.page ?? undefined,
      end_line: endLine.line ?? undefined,
      start_time: startLine.start,
      end_time: endLine.end,
      lines_per_page: session.lines_per_page,
      selection_source: selectionMode,
    }

    setIsSubmitting(true)
    setCreationError(null)
    setCreationMessage(null)

    try {
      const response = await authenticatedFetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Clip creation failed' }))
        throw new Error(errorData.detail || 'Clip creation failed')
      }

      const data = await response.json()
      const clip: ClipDetailResponse = data.clip
      setClipCache((prev) => ({ ...prev, [clip.clip_id]: clip }))
      setActiveClip(clip)
      setCreationMessage('Clip created successfully. Downloads are ready below.')

      const refreshedSession = (data.transcript || data.session) as EditorSessionResponse | undefined
      if (refreshedSession) {
        onSessionRefresh(refreshedSession)
        const nextCount = Array.isArray(refreshedSession.clips) ? refreshedSession.clips.length + 1 : 1
        setClipName(`Clip ${nextCount}`)
      }
    } catch (err: any) {
      const message = typeof err?.message === 'string' ? err.message : 'Clip creation failed'
      setCreationError(message)
    } finally {
      setIsSubmitting(false)
    }
  }, [clipName, lines, mediaKey, onSessionRefresh, selectedRange, selectionMode, session])

  const handleImportTranscript = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!importXmlFile) {
        setImportError('Select a transcript file to import.')
        return
      }
      setImporting(true)
      setImportError(null)
      setImportMessage(null)
      try {
        const formData = new FormData()
        formData.append('transcript_file', importXmlFile)
        if (importMediaFile) {
          formData.append('media_file', importMediaFile)
        }

        const response = await authenticatedFetch('/api/transcripts/import', {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to import transcript')
        }
        const data: EditorSessionResponse = await response.json()
        onSessionRefresh(data)
        setImportMessage('Transcript imported successfully. Clip builder is ready.')
        setImportXmlFile(null)
        setImportMediaFile(null)
        setImportResetKey((value) => value + 1)
      } catch (err: any) {
        const message = typeof err?.message === 'string' ? err.message : 'Failed to import transcript'
        setImportError(message)
      } finally {
        setImporting(false)
      }
    },
    [importXmlFile, importMediaFile, onSessionRefresh],
  )

  const renderLineRow = (line: EditorLine, index: number) => {
    const isSelected =
      selectedRange && index >= selectedRange.startIndex && index <= selectedRange.endIndex
    const isSearchMatch = searchMatches.includes(index)
    const isCurrentSearchMatch = searchMatches[searchCurrentIndex] === index
    const pageLabel = line.page != null && line.line != null ? `${line.page}:${line.line}` : ''
    let bgClass = 'bg-white hover:bg-gray-50'
    if (isCurrentSearchMatch) {
      bgClass = 'bg-amber-200'
    } else if (isSearchMatch) {
      bgClass = 'bg-amber-50'
    } else if (isSelected) {
      bgClass = 'bg-primary-50'
    }
    return (
      <div
        key={line.id}
        ref={(el) => { lineRefs.current[index] = el }}
        className={`px-3 py-2 border-b border-gray-100 last:border-b-0 transition ${bgClass}`}
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-16 text-xs font-mono text-gray-500 pt-0.5">
            {formatSeconds(line.start).replace(/\.\d{3}$/, '')}
          </div>
          <div className="flex-shrink-0 w-12 text-xs text-gray-400 pt-0.5">
            {pageLabel || '—'}
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold text-gray-900">{line.speaker}:</span>{' '}
            <span className="text-sm text-gray-700">{line.text}</span>
          </div>
          <div className="flex-shrink-0 flex gap-1">
            <button
              type="button"
              className={`px-2 py-0.5 rounded text-xs font-medium transition ${
                manualStartId === line.id ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-green-100 hover:text-green-700'
              }`}
              onClick={() => handleManualStart(line.id)}
            >
              Start
            </button>
            <button
              type="button"
              className={`px-2 py-0.5 rounded text-xs font-medium transition ${
                manualEndId === line.id ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-red-100 hover:text-red-700'
              }`}
              onClick={() => handleManualEnd(line.id)}
            >
              End
            </button>
          </div>
        </div>
      </div>
    )
  }

  const renderHistoryRow = (summary: ClipSummary) => {
    const isActive = activeClip?.clip_id === summary.clip_id
    return (
      <div
        key={summary.clip_id}
        className={`p-3 rounded-lg transition ${
          isActive ? 'bg-primary-50 ring-1 ring-primary-200' : 'bg-gray-50 hover:bg-gray-100'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900 text-sm truncate">{summary.name}</div>
            <div className="text-xs text-gray-500">
              {formatSeconds(summary.duration)} • {formatSeconds(summary.start_time ?? 0)} – {formatSeconds(summary.end_time ?? 0)}
            </div>
          </div>
          <div className="flex gap-1 flex-shrink-0">
            <button
              type="button"
              className="px-2 py-1 rounded bg-white border border-gray-200 text-xs font-medium text-gray-700 hover:bg-gray-50"
              onClick={() => handleSelectClip(summary.clip_id)}
              disabled={historyLoadingId === summary.clip_id}
            >
              {historyLoadingId === summary.clip_id ? '...' : 'View'}
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded bg-white border border-gray-200 text-xs font-medium text-gray-700 hover:bg-gray-50"
              onClick={() => handleDownloadPdf(summary.clip_id)}
            >
              PDF
            </button>
            {isCriminal ? (
              <button
                type="button"
                className="px-2 py-1 rounded bg-white border border-gray-200 text-xs font-medium text-gray-700 hover:bg-gray-50"
                onClick={() => handleDownloadViewer(summary.clip_id)}
              >
                HTML
              </button>
            ) : (
              <button
                type="button"
                className="px-2 py-1 rounded bg-white border border-gray-200 text-xs font-medium text-gray-700 hover:bg-gray-50"
                onClick={() => handleDownloadXml(summary.clip_id)}
              >
                XML
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const hasSession = Boolean(mediaKey && session)
  const hasLines = hasSession && lines.length > 0

  return (
    <div className="space-y-6">
      {/* Compact Import Section */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <button
          onClick={() => setImportExpanded(!importExpanded)}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 text-sm font-medium text-gray-900"
        >
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span>Import Existing Transcript</span>
          </div>
          <svg className={`w-4 h-4 text-gray-500 transition-transform ${importExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {importExpanded && (
          <div className="p-4 border-t border-gray-200 bg-gray-50 space-y-4">
            <p className="text-sm text-gray-600">
              Import an existing {isCriminal ? 'HTML viewer' : 'OnCue XML'} transcript with its media file.
            </p>
            {importError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{importError}</div>
            )}
            {importMessage && (
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{importMessage}</div>
            )}
            <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={handleImportTranscript}>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {isCriminal ? 'Transcript (HTML/XML)' : 'Transcript (XML)'}
                </label>
                <input
                  key={`import-xml-${importResetKey}`}
                  type="file"
                  accept={isCriminal ? '.html,.htm,.xml' : '.xml'}
                  onChange={(event) => setImportXmlFile(event.target.files?.[0] ?? null)}
                  className="w-full text-sm file:mr-2 file:rounded file:border-0 file:bg-gray-200 file:px-3 file:py-1.5 file:text-gray-700"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Media File</label>
                <input
                  key={`import-media-${importResetKey}`}
                  type="file"
                  accept="audio/*,video/*"
                  onChange={(event) => setImportMediaFile(event.target.files?.[0] ?? null)}
                  className="w-full text-sm file:mr-2 file:rounded file:border-0 file:bg-gray-200 file:px-3 file:py-1.5 file:text-gray-700"
                />
              </div>
              <div className="md:col-span-2">
                <button type="submit" className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50" disabled={importing || !importXmlFile || !importMediaFile}>
                  {importing ? 'Importing…' : 'Import'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {!hasSession ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No Transcript Loaded</h3>
          <p className="text-gray-600 mb-4">Import a transcript above or generate one to start building clips.</p>
        </div>
      ) : !hasLines ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No Transcript Lines</h3>
          <p className="text-gray-600">Complete the transcription or import process before creating clips.</p>
        </div>
      ) : (
        <>
          {/* Main Clip Creator */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200">
            {/* Header Toolbar */}
            <div className="flex items-center justify-between gap-4 p-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={clipName}
                  onChange={(event) => setClipName(event.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium w-48"
                  placeholder="Clip name..."
                />
                <div className="w-px h-6 bg-gray-200" />
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${selectionMode === 'time' ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                    onClick={() => setSelectionMode('time')}
                  >
                    Time
                  </button>
                  <button
                    type="button"
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${selectionMode === 'pageLine' ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                    onClick={() => setSelectionMode('pageLine')}
                  >
                    Page:Line
                  </button>
                  <button
                    type="button"
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${selectionMode === 'manual' ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                    onClick={() => setSelectionMode('manual')}
                  >
                    Manual
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium flex items-center gap-2"
                  onClick={() => setShowSettings(!showSettings)}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  Settings
                </button>
                {onOpenHistory && (
                  <button className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium" onClick={onOpenHistory}>
                    History
                  </button>
                )}
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium"
                  onClick={handlePreviewClip}
                  disabled={!clipBounds || !resolvedMediaUrl || isSubmitting}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="px-4 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium disabled:opacity-50"
                  onClick={handleCreateClip}
                  disabled={isSubmitting || !selectedRange}
                >
                  {isSubmitting ? 'Creating…' : 'Create Clip'}
                </button>
              </div>
            </div>

            {/* Collapsible Settings Panel */}
            {showSettings && (
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                {selectionMode === 'time' && (
                  <div className="flex flex-wrap items-end gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Start Time</label>
                      <input
                        type="text"
                        className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm w-28"
                        value={timeStart}
                        onChange={(event) => setTimeStart(event.target.value)}
                        placeholder="0:00.000"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">End Time</label>
                      <input
                        type="text"
                        className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm w-28"
                        value={timeEnd}
                        onChange={(event) => setTimeEnd(event.target.value)}
                        placeholder="0:30.000"
                      />
                    </div>
                    <span className="text-xs text-gray-500 pb-2">Times snap to nearest line boundaries</span>
                  </div>
                )}
                {selectionMode === 'pageLine' && (
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="flex gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Start Page</label>
                        <input type="text" className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm w-20" value={pageStart} onChange={(event) => setPageStart(event.target.value)} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Start Line</label>
                        <input type="text" className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm w-20" value={lineStart} onChange={(event) => setLineStart(event.target.value)} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">End Page</label>
                        <input type="text" className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm w-20" value={pageEnd} onChange={(event) => setPageEnd(event.target.value)} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">End Line</label>
                        <input type="text" className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm w-20" value={lineEnd} onChange={(event) => setLineEnd(event.target.value)} />
                      </div>
                    </div>
                  </div>
                )}
                {selectionMode === 'manual' && (
                  <p className="text-sm text-gray-600">
                    Click &quot;Start&quot; and &quot;End&quot; buttons on transcript lines below to define your clip range.
                  </p>
                )}
              </div>
            )}

            {/* Status Bar */}
            {(creationError || creationMessage || clipBounds) && (
              <div className="px-4 py-2 border-b border-gray-200 flex items-center gap-4 text-sm">
                {creationError && <span className="text-red-600">{creationError}</span>}
                {creationMessage && <span className="text-green-600">{creationMessage}</span>}
                {!creationError && !creationMessage && clipBounds && (
                  <>
                    <span className="text-gray-600">
                      <span className="font-medium">Range:</span> {formatSeconds(clipBounds.start)} – {formatSeconds(clipBounds.end)}
                    </span>
                    <span className="text-gray-600">
                      <span className="font-medium">Duration:</span> {formatSeconds(clipBounds.end - clipBounds.start)}
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="p-4">
              {/* Search Bar */}
              <div className="mb-3">
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Search transcript..."
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm pr-24"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value)
                      if (e.target.value.trim()) {
                        setSearchCurrentIndex(0)
                      } else {
                        setSearchCurrentIndex(-1)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        goToSearchResult(e.shiftKey ? 'prev' : 'next')
                      } else if (e.key === 'Escape') {
                        clearSearch()
                      }
                    }}
                  />
                  {searchQuery && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                      <span className="text-xs text-gray-500">
                        {searchMatches.length > 0 ? `${searchCurrentIndex + 1}/${searchMatches.length}` : '0/0'}
                      </span>
                      <button type="button" className="p-1 text-gray-400 hover:text-gray-600" onClick={() => goToSearchResult('prev')}>
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        </svg>
                      </button>
                      <button type="button" className="p-1 text-gray-400 hover:text-gray-600" onClick={() => goToSearchResult('next')}>
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      <button type="button" className="p-1 text-gray-400 hover:text-gray-600" onClick={clearSearch}>
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Transcript Lines */}
              <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-gray-200">
                {lines.map((line, index) => renderLineRow(line, index))}
              </div>
            </div>
          </div>

          {/* Media Preview & Clip History Grid */}
          <div className="grid grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)] gap-6">
            {/* Media Preview - Sidebar */}
            <div className="space-y-4">
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="bg-gray-900 p-3">
                  {resolvedMediaUrl ? (
                    isVideo ? (
                      <video
                        key={resolvedMediaUrl ?? 'media'}
                        ref={videoRef}
                        src={resolvedMediaUrl}
                        onError={() => { void handleMediaError() }}
                        controls
                        preload="metadata"
                        className="w-full rounded-lg"
                      />
                    ) : (
                      <audio
                        key={resolvedMediaUrl ?? 'media'}
                        ref={audioRef}
                        src={resolvedMediaUrl}
                        onError={() => { void handleMediaError() }}
                        controls
                        preload="metadata"
                        className="w-full"
                      />
                    )
                  ) : (
                    <div className="py-8 text-center text-gray-400 text-sm">No media loaded</div>
                  )}
                </div>
                {clipBounds && session?.audio_duration && !activeClip && (
                  <div className="p-3 border-t border-gray-200">
                    <div className="text-xs text-gray-500 mb-1">Clip region</div>
                    <div className="h-2 bg-gray-200 rounded-full relative overflow-hidden">
                      <div
                        className="absolute h-full bg-primary-500 rounded-full"
                        style={{
                          left: `${(clipBounds.start / session.audio_duration) * 100}%`,
                          width: `${((clipBounds.end - clipBounds.start) / session.audio_duration) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>0:00</span>
                      <span>{formatSeconds(session.audio_duration)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Quick Stats */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                <h3 className="text-sm font-medium text-gray-900 mb-3">Session Info</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between text-gray-600">
                    <span>Lines</span>
                    <span className="font-medium text-gray-900">{lines.length}</span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Clips Created</span>
                    <span className="font-medium text-gray-900">{clipHistory.length}</span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Duration</span>
                    <span className="font-medium text-gray-900">{formatSeconds(session?.audio_duration ?? 0)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Clip History - Main Area */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200">
              <div className="px-4 py-3 border-b border-gray-200">
                <h3 className="text-sm font-medium text-gray-900">Clip History</h3>
              </div>
              <div className="p-4">
                {clipHistory.length === 0 ? (
                  <div className="py-8 text-center">
                    <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                      <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-gray-500 text-sm">No clips yet</p>
                    <p className="text-gray-400 text-xs mt-1">Created clips will appear here</p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                    {clipHistory.map((summary) => renderHistoryRow(summary))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Active Clip Detail */}
          {activeClip && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200">
              <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
                <div>
                  <h3 className="text-sm font-medium text-gray-900">{activeClip.name}</h3>
                  <p className="text-xs text-gray-500">
                    {formatSeconds(activeClip.duration)} • {formatSeconds(activeClip.start_time)} – {formatSeconds(activeClip.end_time)}
                  </p>
                </div>
                <button
                  type="button"
                  className="text-gray-400 hover:text-gray-600 p-1"
                  onClick={() => setActiveClip(null)}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-4">
                <div className="bg-gray-50 rounded-lg p-4 max-h-48 overflow-y-auto">
                  {activeClip.lines.map((line) => (
                    <div key={line.id} className="text-sm text-gray-800 mb-2">
                      <span className="font-semibold text-gray-900">{line.speaker}:</span> {line.text}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
