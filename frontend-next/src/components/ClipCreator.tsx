'use client'

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorSessionResponse, ClipSummary } from '@/components/TranscriptEditor'

interface ClipCreatorProps {
  session: EditorSessionResponse | null
  sessionId: string | null
  mediaUrl?: string
  mediaType?: string
  onSessionRefresh: (session: EditorSessionResponse) => void
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
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
  docx_base64: string
  oncue_xml_base64: string
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
  sessionId,
  mediaUrl,
  mediaType,
  onSessionRefresh,
  onDownload,
  buildFilename,
}: ClipCreatorProps) {
  const lines = useMemo<EditorLine[]>(() => session?.lines ?? [], [session])
  const clipHistory = useMemo<ClipSummary[]>(() => session?.clips ?? [], [session])

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

  const effectiveMediaUrl = useMemo(() => {
    if (mediaUrl && mediaUrl.trim()) {
      return mediaUrl
    }
    const blobName = session?.media_blob_name
    if (blobName && blobName.trim()) {
      return `/api/media/${blobName}`
    }
    return null
  }, [mediaUrl, session?.media_blob_name])

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
    if (!effectiveMediaUrl) {
      setPreviewing(false)
    }
  }, [effectiveMediaUrl])

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
    if (selectionMode !== 'manual') {
      setManualStartId(first.id)
      setManualEndId(last.id)
    }
  }, [session, selectionMode])

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
    if (!clipBounds || !effectiveMediaUrl) return
    setPreviewing(true)
  }

  const fetchClipDetail = useCallback(
    async (clipId: string): Promise<ClipDetailResponse | null> => {
      if (clipCache[clipId]) {
        return clipCache[clipId]
      }
      try {
        setHistoryLoadingId(clipId)
        const response = await fetch(`/api/clips/${clipId}`)
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

  const handleDownloadDocx = useCallback(
    async (clipId: string) => {
      const detail = await fetchClipDetail(clipId)
      if (!detail) return
      const filename = buildFilename(detail.name.replace(/\s+/g, '-').toLowerCase(), '.docx')
      onDownload(detail.docx_base64, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
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

  const handleCreateClip = useCallback(async () => {
    if (!sessionId || !session) {
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
      session_id: sessionId,
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
      const response = await fetch('/api/clips', {
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

      if (data.session) {
        const refreshedSession = data.session as EditorSessionResponse
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
  }, [clipName, lines, onSessionRefresh, selectedRange, selectionMode, session, sessionId])

  const handleImportTranscript = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!importXmlFile) {
        setImportError('Select an OnCue XML file to import.')
        return
      }
      setImporting(true)
      setImportError(null)
      setImportMessage(null)
      try {
        const formData = new FormData()
        formData.append('xml_file', importXmlFile)
        if (importMediaFile) {
          formData.append('media_file', importMediaFile)
        }

        const response = await fetch('/api/transcripts/import', {
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
    const pageLabel = line.page != null && line.line != null ? `Pg ${line.page} Ln ${line.line}` : ''
    return (
      <div
        key={line.id}
        className={`border rounded-lg p-3 mb-2 transition ${
          isSelected ? 'bg-primary-100 border-primary-400' : 'bg-white border-primary-200'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-primary-600 bg-primary-200 px-2 py-1 rounded-full">
              {formatSeconds(line.start)}
            </span>
            <span className="text-xs text-primary-500">{pageLabel || '—'}</span>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-outline text-xs" onClick={() => handleManualStart(line.id)}>
              Start here
            </button>
            <button type="button" className="btn-outline text-xs" onClick={() => handleManualEnd(line.id)}>
              End here
            </button>
          </div>
        </div>
        <div className="mt-2 text-sm text-primary-900">
          <span className="font-semibold">{line.speaker}:</span> {line.text}
        </div>
      </div>
    )
  }

  const renderHistoryRow = (summary: ClipSummary) => {
    const isActive = activeClip?.clip_id === summary.clip_id
    return (
      <div
        key={summary.clip_id}
        className={`border rounded-lg p-4 transition ${
          isActive ? 'border-primary-500 bg-primary-50' : 'border-primary-200 bg-white'
        }`}
      >
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <div className="font-semibold text-primary-900">{summary.name}</div>
            <div className="text-xs text-primary-600">
              Created {new Date(summary.created_at).toLocaleString()} • {formatSeconds(summary.duration)}
            </div>
            <div className="text-xs text-primary-500 mt-1">
              {summary.start_time != null && summary.end_time != null && (
                <>
                  Source {formatSeconds(summary.start_time)} – {formatSeconds(summary.end_time)}
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => handleSelectClip(summary.clip_id)}
              disabled={historyLoadingId === summary.clip_id}
            >
              {historyLoadingId === summary.clip_id ? 'Loading…' : 'View'}
            </button>
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => handleDownloadDocx(summary.clip_id)}
            >
              DOCX
            </button>
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => handleDownloadXml(summary.clip_id)}
            >
              XML
            </button>
            {summary.media_blob_name && (
              <a
                href={`/api/media/${summary.media_blob_name}`}
                className="btn-outline text-xs"
                target="_blank"
                rel="noopener noreferrer"
              >
                Media
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  const hasSession = Boolean(sessionId && session)
  const hasLines = hasSession && lines.length > 0

  return (
    <div className="space-y-8">
      <div className="card">
        <div className="card-header">
          <h2 className="text-xl font-medium">Import Transcript</h2>
        </div>
        <div className="card-body space-y-4">
          <p className="text-sm text-primary-700">
            Bring an existing OnCue XML transcript into the clip builder. Optionally include the corresponding media file
            for preview and clip exports.
          </p>
          {importError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{importError}</div>
          )}
          {importMessage && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{importMessage}</div>
          )}
          <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={handleImportTranscript}>
            <div className="space-y-2">
              <label className="block text-xs font-medium uppercase tracking-wide text-primary-700">OnCue XML *</label>
              <input
                key={`import-xml-${importResetKey}`}
                type="file"
                accept=".xml"
                onChange={(event) => setImportXmlFile(event.target.files?.[0] ?? null)}
                className="mt-1 w-full text-sm text-primary-700 file:mr-3 file:rounded file:border-0 file:bg-primary-100 file:px-3 file:py-2 file:text-primary-800"
              />
              <p className="text-xs text-primary-500">Select the transcript exported from OnCue.</p>
            </div>
            <div className="space-y-2">
              <label className="block text-xs font-medium uppercase tracking-wide text-primary-700">Media (optional)</label>
              <input
                key={`import-media-${importResetKey}`}
                type="file"
                accept="audio/*,video/*"
                onChange={(event) => setImportMediaFile(event.target.files?.[0] ?? null)}
                className="mt-1 w-full text-sm text-primary-700 file:mr-3 file:rounded file:border-0 file:bg-primary-100 file:px-3 file:py-2 file:text-primary-800"
              />
              <p className="text-xs text-primary-500">Include matching video or audio to enable preview playback.</p>
            </div>
            <div className="md:col-span-2">
              <button type="submit" className="btn-outline w-full md:w-auto" disabled={importing}>
                {importing ? 'Importing…' : 'Import transcript'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {!hasSession ? (
        <div className="card">
          <div className="card-header">
            <h2 className="text-xl font-medium">Clip Creator</h2>
          </div>
          <div className="card-body space-y-3 text-primary-700">
            <p>Import a transcript above or generate one from the Transcription tab to start building clips.</p>
          </div>
        </div>
      ) : !hasLines ? (
        <div className="card">
          <div className="card-header">
            <h2 className="text-xl font-medium">Clip Creator</h2>
          </div>
          <div className="card-body space-y-3 text-primary-700">
            <p>
              This session does not have any transcript lines yet. Complete the transcription or import process before
              generating clips.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-header">
              <h2 className="text-xl font-medium">Build a Clip</h2>
            </div>
            <div className="card-body space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  {cardSectionTitle('Clip name')}
                  <input
                    type="text"
                    value={clipName}
                    onChange={(event) => setClipName(event.target.value)}
                    className="input-field"
                    placeholder="e.g., Opening statement"
                  />
                </div>
                <div>
                  {cardSectionTitle('Selection mode')}
                  <div className="flex gap-2 flex-wrap">
                    <button type="button" className={selectionButtonClasses(selectionMode === 'time')} onClick={() => setSelectionMode('time')}>
                      Timecodes
                    </button>
                    <button type="button" className={selectionButtonClasses(selectionMode === 'pageLine')} onClick={() => setSelectionMode('pageLine')}>
                      Page & Line
                    </button>
                    <button type="button" className={selectionButtonClasses(selectionMode === 'manual')} onClick={() => setSelectionMode('manual')}>
                      Transcript Picker
                    </button>
                  </div>
                </div>
              </div>

              {selectionMode === 'time' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-primary-700 mb-1">Start time</label>
                    <input
                      type="text"
                      className="input-field"
                      value={timeStart}
                      onChange={(event) => setTimeStart(event.target.value)}
                      placeholder="0:00.000"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-primary-700 mb-1">End time</label>
                    <input
                      type="text"
                      className="input-field"
                      value={timeEnd}
                      onChange={(event) => setTimeEnd(event.target.value)}
                      placeholder="0:30.000"
                    />
                  </div>
                </div>
              )}

              {selectionMode === 'pageLine' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-1">Start page</label>
                      <input type="text" className="input-field" value={pageStart} onChange={(event) => setPageStart(event.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-1">Start line</label>
                      <input type="text" className="input-field" value={lineStart} onChange={(event) => setLineStart(event.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-1">End page</label>
                      <input type="text" className="input-field" value={pageEnd} onChange={(event) => setPageEnd(event.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-1">End line</label>
                      <input type="text" className="input-field" value={lineEnd} onChange={(event) => setLineEnd(event.target.value)} />
                    </div>
                  </div>
                </div>
              )}

              {selectionMode === 'manual' && (
                <p className="text-sm text-primary-700">
                  Click “Start here” and “End here” on the transcript lines below to define your clip. You can still fine-tune using
                  timecodes or page numbers afterwards.
                </p>
              )}

              <div>
                {cardSectionTitle('Transcript lines')}
                <div className="max-h-96 overflow-y-auto pr-1">
                  {lines.map((line, index) => renderLineRow(line, index))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="text-sm text-primary-700">
                    <span className="font-semibold">Clip span:</span>{' '}
                    {clipBounds ? `${formatSeconds(clipBounds.start)} – ${formatSeconds(clipBounds.end)}` : 'Select lines to calculate'}
                  </div>
                  <div className="text-sm text-primary-600">
                    <span className="font-semibold">Duration:</span>{' '}
                    {clipBounds ? formatSeconds(clipBounds.end - clipBounds.start) : '—'}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={handlePreviewClip}
                    disabled={!clipBounds || !effectiveMediaUrl || isSubmitting}
                  >
                    {previewing ? 'Previewing…' : 'Preview clip'}
                  </button>
                  <button type="button" className="btn-primary" onClick={handleCreateClip} disabled={isSubmitting || !selectedRange}>
                    {isSubmitting ? 'Creating…' : 'Create clip'}
                  </button>
                </div>
              </div>

              {creationError && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{creationError}</div>}
              {creationMessage && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">{creationMessage}</div>}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
            <div className="card">
              <div className="card-header">
                <h2 className="text-xl font-medium">Media preview</h2>
              </div>
              <div className="card-body space-y-4">
                {effectiveMediaUrl ? (
                  <div className="bg-primary-900 rounded-lg p-4">
                    {isVideo ? (
                      <video ref={videoRef} src={effectiveMediaUrl} controls preload="metadata" className="w-full rounded" />
                    ) : (
                      <audio ref={audioRef} src={effectiveMediaUrl} controls preload="metadata" className="w-full" />
                    )}
                  </div>
                ) : (
                  <p className="text-primary-700">No media preview available for this session.</p>
                )}
                {clipBounds && (
                  <div className="text-xs text-primary-600">
                    Clip will run from {formatSeconds(clipBounds.start)} to {formatSeconds(clipBounds.end)}.
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h2 className="text-xl font-medium">Clip history</h2>
              </div>
              <div className="card-body space-y-4">
                {clipHistory.length === 0 && <p className="text-primary-700">No clips yet. Create your first clip to see it here.</p>}
                {clipHistory.map((summary) => renderHistoryRow(summary))}
              </div>
            </div>
          </div>

          {activeClip && (
            <div className="card">
              <div className="card-header">
                <h2 className="text-xl font-medium">Selected clip</h2>
              </div>
              <div className="card-body space-y-4">
                <div>
                  <div className="text-lg font-semibold text-primary-900">{activeClip.name}</div>
                  <div className="text-sm text-primary-600">
                    {formatSeconds(activeClip.duration)} • Source {formatSeconds(activeClip.start_time)} – {formatSeconds(activeClip.end_time)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="btn-primary text-sm"
                    onClick={() =>
                      onDownload(
                        activeClip.docx_base64,
                        buildFilename(activeClip.name.replace(/\s+/g, '-').toLowerCase(), '.docx'),
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      )
                    }
                  >
                    Download DOCX
                  </button>
                  <button
                    type="button"
                    className="btn-primary text-sm"
                    onClick={() =>
                      onDownload(
                        activeClip.oncue_xml_base64,
                        buildFilename(activeClip.name.replace(/\s+/g, '-').toLowerCase(), '.xml'),
                        'application/xml',
                      )
                    }
                  >
                    Download XML
                  </button>
                  {activeClip.media_blob_name && (
                    <a
                      href={`/api/media/${activeClip.media_blob_name}`}
                      className="btn-outline text-sm"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Download clip media
                    </a>
                  )}
                </div>
                <div>
                  {cardSectionTitle('Transcript preview')}
                  <div className="bg-primary-50 border border-primary-200 rounded-lg p-4 max-h-64 overflow-y-auto">
                    {activeClip.lines.map((line) => (
                      <div key={line.id} className="text-sm text-primary-800 mb-2">
                        <span className="font-semibold">{line.speaker}</span>: {line.text}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
