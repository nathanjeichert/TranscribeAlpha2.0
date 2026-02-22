'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { authenticatedFetch } from '@/utils/auth'
import { saveTranscript as localSaveTranscript } from '@/lib/storage'
import { getMediaFile } from '@/lib/mediaHandles'

interface EditorLine {
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
  timestamp_error?: boolean
}

export interface ClipSummary {
  clip_id: string
  name: string
  created_at: string
  duration: number
  start_time: number
  end_time: number
  start_pgln?: number | null
  end_pgln?: number | null
  start_page?: number | null
  start_line?: number | null
  end_page?: number | null
  end_line?: number | null
  media_blob_name?: string | null
  media_content_type?: string | null
  file_name?: string | null
}

export interface EditorSessionResponse {
  session_id?: string | null
  media_key?: string | null
  media_handle_id?: string | null
  media_blob_name?: string | null
  media_filename?: string | null
  media_content_type?: string | null
  title_data: Record<string, string>
  audio_duration: number
  lines_per_page: number
  lines: EditorLine[]
  created_at?: string
  updated_at?: string
  expires_at?: string
  pdf_base64?: string | null
  // Deprecated, retained for legacy sessions.
  docx_base64?: string | null
  oncue_xml_base64?: string | null
  viewer_html_base64?: string | null
  source_turns?: unknown[]
  transcript?: string | null
  transcript_text?: string | null
  clips?: ClipSummary[]
}

export type EditorSaveResponse = EditorSessionResponse

interface TranscriptEditorProps {
  mediaKey?: string | null
  initialData?: EditorSessionResponse | null
  mediaUrl?: string
  mediaType?: string
  pdfBase64?: string | null
  docxBase64?: string | null
  xmlBase64?: string | null
  viewerHtmlBase64?: string | null
  appVariant?: 'oncue' | 'criminal'
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
  onSessionChange: (session: EditorSessionResponse) => void
  onSaveComplete: (result: EditorSaveResponse) => void
  onRequestMediaImport?: () => void
  onOpenViewer?: () => void
  onOpenHistory?: () => void
  onGeminiRefine?: () => void
  isGeminiBusy?: boolean
  geminiError?: string | null
}

const secondsToLabel = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00.000'
  }
  const wholeSeconds = Math.floor(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainingSeconds = wholeSeconds % 60
  const millis = Math.floor((seconds - wholeSeconds) * 1000)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${millis
    .toString()
    .padStart(3, '0')}`
}

const AUTO_SHIFT_STORAGE_KEY = 'editor_auto_shift_next'
const AUTO_SHIFT_PADDING_SECONDS = 0.01

const escapeScriptBoundary = (value: string) => value.replace(/<\/script/gi, '<\\/script')

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...Array.from(chunk))
  }
  return btoa(binary)
}

function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
}

function buildRenderedText(line: Pick<EditorLine, 'speaker' | 'text' | 'is_continuation'>): string {
  const speaker = (line.speaker || '').trim().replace(/:+$/, '')
  const text = line.text || ''
  if (line.is_continuation) return text
  if (!speaker) return text
  const compact = text.trimStart().toUpperCase()
  if (compact.startsWith(`${speaker.toUpperCase()}:`)) {
    return text
  }
  return `          ${speaker}:   ${text}`
}

function sanitizeDownloadStem(value: string): string {
  const sanitized = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || 'transcript'
}

function normalizeLineEntriesForArtifacts(lineEntries: EditorLine[], linesPerPage: number): EditorLine[] {
  const safeLinesPerPage = linesPerPage > 0 ? linesPerPage : 25
  return lineEntries.map((line, index) => {
    const pageNumber = Number.isFinite(line.page as number)
      ? Number(line.page)
      : Math.floor(index / safeLinesPerPage) + 1
    const lineNumber = Number.isFinite(line.line as number)
      ? Number(line.line)
      : (index % safeLinesPerPage) + 1
    const start = Number.isFinite(line.start) ? Number(line.start) : 0
    const rawEnd = Number.isFinite(line.end) ? Number(line.end) : start
    return {
      ...line,
      id: line.id || `line-${index}`,
      speaker: line.speaker || '',
      text: line.text || '',
      rendered_text: buildRenderedText(line),
      start,
      end: rawEnd >= start ? rawEnd : start,
      page: pageNumber,
      line: lineNumber,
      pgln: Number.isFinite(line.pgln as number) ? Number(line.pgln) : (pageNumber * 100) + lineNumber,
      is_continuation: Boolean(line.is_continuation),
    }
  })
}

function buildViewerPayloadFromLines(
  lineEntries: EditorLine[],
  titleData: Record<string, string>,
  audioDuration: number,
  linesPerPage: number,
  mediaFilename: string,
  mediaContentType: string,
) {
  const normalizedEntries = normalizeLineEntriesForArtifacts(lineEntries, linesPerPage)
  const speakers = Array.from(
    new Set(
      normalizedEntries
        .map((line) => line.speaker)
        .filter((speaker) => speaker && speaker.trim().length > 0),
    ),
  )

  const normalizedLines = normalizedEntries.map((line, index) => {
    const pageNumber = Number(line.page)
    const lineNumber = Number(line.line)
    return {
      id: line.id || `line-${index}`,
      speaker: line.speaker || '',
      text: line.text || '',
      rendered_text: line.rendered_text || buildRenderedText(line),
      start: Number.isFinite(line.start) ? line.start : 0,
      end: Number.isFinite(line.end) ? line.end : (Number.isFinite(line.start) ? line.start : 0),
      page_number: pageNumber,
      line_number: lineNumber,
      pgln: Number.isFinite(line.pgln as number) ? Number(line.pgln) : (pageNumber * 100) + lineNumber,
      is_continuation: Boolean(line.is_continuation),
    }
  })

  const pageMap = new Map<number, number[]>()
  normalizedLines.forEach((line, idx) => {
    if (!pageMap.has(line.page_number)) pageMap.set(line.page_number, [])
    pageMap.get(line.page_number)?.push(idx)
  })

  const pages = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([pageNumber, lineIndexes]) => ({
      page_number: pageNumber,
      line_indexes: lineIndexes,
      pgln_start: lineIndexes.length ? normalizedLines[lineIndexes[0]].pgln : 101,
      pgln_end: lineIndexes.length ? normalizedLines[lineIndexes[lineIndexes.length - 1]].pgln : 101,
    }))

  return {
    meta: {
      title: titleData || {},
      duration_seconds: Number.isFinite(audioDuration) ? audioDuration : 0,
      lines_per_page: linesPerPage > 0 ? linesPerPage : 25,
      speakers,
    },
    media: {
      filename: mediaFilename,
      content_type: mediaContentType || 'video/mp4',
      relative_path: mediaFilename,
    },
    lines: normalizedLines,
    pages,
  }
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildOncueXmlFromLineEntries(
  lineEntries: EditorLine[],
  titleData: Record<string, string>,
  audioDuration: number,
  linesPerPage: number,
): string {
  const filename = (titleData.FILE_NAME || 'audio.mp3').trim() || 'audio.mp3'
  const mediaId =
    (titleData.MEDIA_ID || '').trim() ||
    filename.replace(/\.[^/.]+$/, '') ||
    'deposition'
  const dateAttr = titleData.DATE ? ` date="${escapeXmlAttribute(titleData.DATE)}"` : ''
  const sortedEntries = [...lineEntries].sort((a, b) => {
    const pageA = Number(a.page ?? 1)
    const pageB = Number(b.page ?? 1)
    if (pageA !== pageB) return pageA - pageB
    const lineA = Number(a.line ?? 1)
    const lineB = Number(b.line ?? 1)
    return lineA - lineB
  })
  const lastPgln = sortedEntries.length
    ? Number(sortedEntries[sortedEntries.length - 1].pgln ?? 101)
    : 101

  const parts: string[] = []
  parts.push('<onCue xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
  parts.push(
    `<deposition mediaId="${escapeXmlAttribute(mediaId)}" linesPerPage="${Math.max(1, linesPerPage)}"${dateAttr}>`,
  )
  parts.push(
    `<depoVideo ID="1" filename="${escapeXmlAttribute(filename)}" startTime="0" stopTime="${Math.round(
      Math.max(0, audioDuration),
    )}" firstPGLN="101" lastPGLN="${lastPgln}" startTuned="no" stopTuned="no">`,
  )

  for (const entry of sortedEntries) {
    const page = Number(entry.page ?? 1)
    const line = Number(entry.line ?? 1)
    const pgln = Number(entry.pgln ?? (page * 100) + line)
    const start = Number(entry.start ?? 0)
    const end = Number(entry.end ?? start)
    const rendered = entry.rendered_text || buildRenderedText(entry)
    parts.push(
      `<depoLine prefix="" text="${escapeXmlAttribute(rendered)}" page="${page}" line="${line}" pgLN="${pgln}" videoID="1" videoStart="${start.toFixed(
        2,
      )}" videoStop="${end.toFixed(2)}" isEdited="no" isSynched="yes" isRedacted="no" />`,
    )
  }

  parts.push('</depoVideo></deposition></onCue>')
  return parts.join('')
}

export default function TranscriptEditor({
  mediaKey: initialMediaKey,
  initialData,
  mediaUrl,
  mediaType,
  pdfBase64,
  docxBase64,
  xmlBase64,
  viewerHtmlBase64,
  appVariant = 'oncue',
  onDownload,
  buildFilename,
  onSessionChange,
  onSaveComplete,
  onRequestMediaImport,
  onOpenViewer,
  onOpenHistory,
  onGeminiRefine,
  isGeminiBusy,
  geminiError,
}: TranscriptEditorProps) {
  const [lines, setLines] = useState<EditorLine[]>(initialData?.lines ?? [])
  const [sessionMeta, setSessionMeta] = useState<EditorSessionResponse | null>(initialData ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [activeMediaKey, setActiveMediaKey] = useState<string | null>(initialData?.media_key ?? initialMediaKey ?? null)
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [editingField, setEditingField] = useState<{ lineId: string; field: 'speaker' | 'text'; value: string } | null>(null)
  const [autoShiftNextLine, setAutoShiftNextLine] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<string[]>([])
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(-1)
  const [resolvedMediaUrl, setResolvedMediaUrl] = useState<string | undefined>(undefined)

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const programmaticScrollRef = useRef(false)
  const scrollReleaseTimerRef = useRef<number | null>(null)
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const activeLineMarker = useRef<string | null>(null)
  // Skip resetting isDirty/history in SYNC EFFECT when we've just done a local update (e.g., resync)
  const skipSyncEffectReset = useRef(false)

  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [renameFeedback, setRenameFeedback] = useState<string | null>(null)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [history, setHistory] = useState<EditorLine[][]>([])
  const [future, setFuture] = useState<EditorLine[][]>([])
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const lastSnapshotRef = useRef<number>(0)

  // Collapsible panel states
  const [showSettings, setShowSettings] = useState(false)
  const [manualScrollOverride, setManualScrollOverride] = useState(false)

  // Refs for auto-save to avoid resetting timer on every edit
  const linesRef = useRef<EditorLine[]>(initialData?.lines ?? [])
  const isDirtyRef = useRef(false)
  const sessionMetaRef = useRef<EditorSessionResponse | null>(initialData ?? null)
  const viewerTemplateCacheRef = useRef<string | null>(null)

  // Rev AI Re-sync State
  const [isResyncing, setIsResyncing] = useState(false)
  const [resyncError, setResyncError] = useState<string | null>(null)

  const baseMediaUrl = useMemo(() => mediaUrl || undefined, [mediaUrl])

  useEffect(() => {
    setResolvedMediaUrl(baseMediaUrl)
  }, [baseMediaUrl])

  const effectiveMediaType = useMemo(
    () => mediaType ?? sessionMeta?.media_content_type ?? undefined,
    [mediaType, sessionMeta],
  )

  const isVideo = useMemo(
    () => (effectiveMediaType ?? '').startsWith('video/'),
    [effectiveMediaType],
  )

  const handleMediaError = useCallback(async () => {
    if (!baseMediaUrl) return
    setResolvedMediaUrl(baseMediaUrl)
  }, [baseMediaUrl])

  // Keep refs in sync with state for auto-save interval
  useEffect(() => { linesRef.current = lines }, [lines])
  useEffect(() => { isDirtyRef.current = isDirty }, [isDirty])
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])

  const lineBoundaries = useMemo(
    () =>
      lines.map((line) => {
        const start = Number.isFinite(line.start) ? line.start : 0
        const end = Number.isFinite(line.end) ? line.end : start
        return {
          id: line.id,
          start,
          end: end > start ? end : start + 0.05,
        }
      }),
    [lines],
  )

  const isLineVisibleInTranscript = useCallback((lineId: string) => {
    const container = transcriptScrollRef.current
    const row = lineRefs.current[lineId]
    if (!container || !row) return false
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return rowRect.top >= containerRect.top && rowRect.bottom <= containerRect.bottom
  }, [])

  const scrollTranscriptToLine = useCallback((lineId: string, behavior: ScrollBehavior = 'smooth') => {
    const target = lineRefs.current[lineId]
    const container = transcriptScrollRef.current
    if (!target || !container) return
    programmaticScrollRef.current = true
    // Scroll within the editor container only, not the whole page
    const targetTop = target.offsetTop - container.offsetTop
    const targetCenter = targetTop - container.clientHeight / 2 + target.clientHeight / 2
    container.scrollTo({ top: targetCenter, behavior })
    if (scrollReleaseTimerRef.current) {
      window.clearTimeout(scrollReleaseTimerRef.current)
    }
    scrollReleaseTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false
      scrollReleaseTimerRef.current = null
    }, behavior === 'smooth' ? 450 : 150)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollReleaseTimerRef.current) {
        window.clearTimeout(scrollReleaseTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!initialData) return
    setSessionMeta(initialData)
    setLines(initialData.lines ?? [])
    // Only update activeMediaKey from props, not from internal state (to avoid circular updates)
    const resolvedKey = initialData.media_key ?? initialMediaKey ?? null
    if (resolvedKey) {
      setActiveMediaKey(resolvedKey)
    }

    // Skip resetting edit state if we just did a local update (e.g., resync)
    if (skipSyncEffectReset.current) {
      skipSyncEffectReset.current = false
    } else {
      setHistory([])
      setFuture([])
      setIsDirty(false)
    }

    setActiveLineId(null)
    setSelectedLineId(null)
    setEditingField(null)
    setSnapshotError(null)
    activeLineMarker.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData, initialMediaKey])

  // Track the current editing session to avoid re-selecting text on every keystroke
  const editingLineId = editingField?.lineId
  const editingFieldName = editingField?.field

  useEffect(() => {
    if (!editingLineId || !editingFieldName) return
    if (editInputRef.current) {
      editInputRef.current.focus()
      if (editingFieldName === 'speaker' && 'select' in editInputRef.current) {
        ;(editInputRef.current as HTMLInputElement).select()
      }
    }
  }, [editingLineId, editingFieldName]) // Only run when lineId or field changes, not when value changes

  const hasPendingInlineEdit = useMemo(() => {
    if (!editingField) return false
    const line = lines.find((entry) => entry.id === editingField.lineId)
    if (!line) return false
    const currentValue = editingField.field === 'speaker' ? line.speaker : line.text
    return currentValue !== editingField.value
  }, [editingField, lines])

  const materializeLinesForSave = useCallback((): EditorLine[] => {
    if (!editingField || !hasPendingInlineEdit) return lines
    return lines.map((line) =>
      line.id === editingField.lineId
        ? {
          ...line,
          [editingField.field]: editingField.value,
          ...(editingField.field === 'speaker' || editingField.field === 'text' ? { rendered_text: undefined } : null),
        }
        : line,
    )
  }, [editingField, hasPendingInlineEdit, lines])

  useEffect(() => {
    const player = resolvedMediaUrl ? (isVideo ? videoRef.current : audioRef.current) : null
    if (!player) return

    const handleTimeUpdate = () => {
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
      if (currentLineId && currentLineId !== activeLineMarker.current) {
        activeLineMarker.current = currentLineId
        setActiveLineId(currentLineId)
        if (autoScroll && !manualScrollOverride) {
          scrollTranscriptToLine(currentLineId)
        }
      }
    }

    player.addEventListener('timeupdate', handleTimeUpdate)
    return () => {
      player.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [resolvedMediaUrl, isVideo, lineBoundaries, autoScroll, manualScrollOverride, scrollTranscriptToLine])

  const handleLineFieldChange = useCallback(
    (lineId: string, field: keyof EditorLine, value: string | number) => {
      setLines((prev) => {
        const normalizedValue =
          field === 'speaker' || field === 'text'
            ? typeof value === 'string'
              ? value
              : value.toString()
            : typeof value === 'number'
              ? value
              : parseFloat(value as string) || 0

        const nextLines = prev.map((line) =>
          line.id === lineId
            ? {
              ...line,
              [field]: normalizedValue,
              ...(field === 'speaker' || field === 'text' ? { rendered_text: undefined } : null),
              ...(field === 'start' || field === 'end' ? { timestamp_error: false } : null),
            }
            : line,
        )

        if (field === 'end' && autoShiftNextLine) {
          const targetIndex = nextLines.findIndex((line) => line.id === lineId)
          if (targetIndex >= 0 && nextLines[targetIndex + 1]) {
            const targetLine = nextLines[targetIndex]
            const followingLine = nextLines[targetIndex + 1]
            const numericEnd =
              typeof normalizedValue === 'number'
                ? normalizedValue
                : parseFloat(normalizedValue as string) || targetLine.end
            const adjustedStart = Math.max(0, parseFloat((numericEnd + AUTO_SHIFT_PADDING_SECONDS).toFixed(3)))
            nextLines[targetIndex + 1] = { ...followingLine, start: adjustedStart }
          }
        }

        return nextLines
      })
      setIsDirty(true)
    },
    [autoShiftNextLine],
  )

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

      // Check if media metadata is loaded (readyState >= 1 means HAVE_METADATA)
      if (player.readyState >= 1) {
        seekAndPlay()
      } else {
        // Wait for metadata to load before seeking
        const handleLoadedMetadata = () => {
          player.removeEventListener('loadedmetadata', handleLoadedMetadata)
          seekAndPlay()
        }
        player.addEventListener('loadedmetadata', handleLoadedMetadata)
        // Also trigger a load if the player hasn't started loading
        if (player.readyState === 0) {
          player.load()
        }
      }
    },
    [resolvedMediaUrl, isVideo],
  )

  useEffect(() => {
    if (!activeMediaKey) return

    const interval = setInterval(async () => {
      // Read from refs to get latest values without resetting the timer
      if (!isDirtyRef.current) return
      const currentSessionMeta = sessionMetaRef.current
      if (!currentSessionMeta) return

      try {
        const now = Date.now()
        if (now - lastSnapshotRef.current < 5000) return  // Debounce

        const caseId = (currentSessionMeta as unknown as Record<string, unknown>).case_id
        const dataToSave = {
          ...currentSessionMeta,
          lines: linesRef.current,
          updated_at: new Date().toISOString(),
        }
        await localSaveTranscript(
          activeMediaKey,
          dataToSave as unknown as Record<string, unknown>,
          typeof caseId === 'string' && caseId ? caseId : undefined,
        )

        lastSnapshotRef.current = now
        setSnapshotError(null)

      } catch (err: any) {
        setSnapshotError(err.message || 'Auto-save failed')
      }
    }, 60000)  // 60 seconds

    return () => clearInterval(interval)
  }, [activeMediaKey])  // Only reset interval when media key changes

  const cloneLines = useCallback((source: EditorLine[]) => source.map((line) => ({ ...line })), [])

  const pushHistory = useCallback(
    (snapshot: EditorLine[]) => {
      setHistory((prev) => [...prev.slice(-49), cloneLines(snapshot)])
      setFuture([])
    },
    [cloneLines],
  )

  const beginEdit = useCallback((line: EditorLine, field: 'speaker' | 'text') => {
    setEditingField({
      lineId: line.id,
      field,
      value: field === 'speaker' ? line.speaker : line.text,
    })
  }, [])

  const commitEdit = useCallback(() => {
    if (!editingField) return
    pushHistory(lines)
    handleLineFieldChange(editingField.lineId, editingField.field, editingField.value)
    setEditingField(null)
  }, [editingField, handleLineFieldChange, lines, pushHistory])

  const cancelEdit = useCallback(() => {
    setEditingField(null)
  }, [])

  // Search functionality
  const performSearch = useCallback((query: string) => {
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
      scrollTranscriptToLine(matches[0])
    } else {
      setSearchCurrentIndex(-1)
    }
  }, [lines, scrollTranscriptToLine])

  const goToSearchResult = useCallback((direction: 'next' | 'prev') => {
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
    scrollTranscriptToLine(lineId)
  }, [searchMatches, searchCurrentIndex, scrollTranscriptToLine])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchMatches([])
    setSearchCurrentIndex(-1)
  }, [])

  const handleTranscriptScroll = useCallback(() => {
    if (!autoScroll || programmaticScrollRef.current || !activeLineId) return
    const activeVisible = isLineVisibleInTranscript(activeLineId)
    setManualScrollOverride((prev) => {
      if (!prev && !activeVisible) return true
      if (prev && activeVisible) return false
      return prev
    })
  }, [activeLineId, autoScroll, isLineVisibleInTranscript])

  const handleReturnToCurrentLine = useCallback(() => {
    if (!activeLineId) return
    setManualScrollOverride(false)
    scrollTranscriptToLine(activeLineId)
  }, [activeLineId, scrollTranscriptToLine])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(AUTO_SHIFT_STORAGE_KEY)
      if (stored === 'true') {
        setAutoShiftNextLine(true)
      } else if (stored === 'false') {
        setAutoShiftNextLine(false)
      }
    } catch (err) {
      console.error('Failed to load auto-shift preference:', err)
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_SHIFT_STORAGE_KEY, autoShiftNextLine ? 'true' : 'false')
    } catch (err) {
      console.error('Failed to save auto-shift preference:', err)
    }
  }, [autoShiftNextLine])

  useEffect(() => {
    if (!autoScroll) {
      setManualScrollOverride(false)
    }
  }, [autoScroll])

  const handleAddUtterance = useCallback(() => {
    setAddError(null)
    setDeleteError(null)
    if (!lines.length) {
      setAddError('No lines available to insert after.')
      return
    }

    pushHistory(lines)

    const minDuration = 0.2
    const targetId = selectedLineId ?? activeLineId ?? lines[lines.length - 1]?.id
    const targetIndex = lines.findIndex((line) => line.id === targetId)
    if (targetIndex < 0) {
      setAddError('Select a line to insert after.')
      return
    }

    const currentLine = lines[targetIndex]
    const nextLine = lines[targetIndex + 1]
    const nextStart = nextLine ? Number(nextLine.start) : null
    const currentStart = Number(currentLine.start) || 0
    const currentEnd = Number(currentLine.end) || currentStart

    let newStart = currentEnd
    let newEnd: number
    let updatedCurrentEnd = currentEnd

    if (nextLine && nextStart !== null && !Number.isNaN(nextStart)) {
      const gap = nextStart - currentEnd
      if (gap >= 2) {
        newStart = currentEnd
        newEnd = nextStart
        if (newEnd - newStart < minDuration) {
          newEnd = newStart + minDuration
        }
      } else {
        const duration = Math.max(currentEnd - currentStart, minDuration * 2)
        updatedCurrentEnd = currentStart + duration / 2
        newStart = updatedCurrentEnd
        newEnd = Math.min(currentStart + duration, nextStart)
        if (newEnd - newStart < minDuration) {
          newEnd = newStart + minDuration
        }
      }
    } else {
      const fallbackDuration = Math.max((sessionMeta?.audio_duration ?? 0) - currentEnd, minDuration)
      newStart = currentEnd
      newEnd = newStart + fallbackDuration
    }

    const newLineId = `new-${Date.now()}`
    const updatedLines = [...lines]
    updatedLines[targetIndex] = {
      ...currentLine,
      end: updatedCurrentEnd,
    }
    updatedLines.splice(targetIndex + 1, 0, {
      id: newLineId,
      speaker: currentLine.speaker,
      text: '',
      start: newStart,
      end: newEnd,
      is_continuation: false,
    })

    setLines(updatedLines)
    setSelectedLineId(newLineId)
    setEditingField({ lineId: newLineId, field: 'text', value: '' })
    setIsDirty(true)
  }, [lines, selectedLineId, activeLineId, sessionMeta, pushHistory])

  const handleDeleteUtterance = useCallback(() => {
    setDeleteError(null)
    setAddError(null)
    if (!lines.length) {
      setDeleteError('No lines to delete.')
      return
    }
    const targetId = selectedLineId ?? activeLineId
    if (!targetId) {
      setDeleteError('Select a line to delete.')
      return
    }
    const targetIndex = lines.findIndex((line) => line.id === targetId)
    if (targetIndex < 0) {
      setDeleteError('Select a line to delete.')
      return
    }
    if (lines.length === 1) {
      setDeleteError('At least one utterance must remain.')
      return
    }

    pushHistory(lines)

    const nextSelection = lines[targetIndex + 1]?.id || lines[targetIndex - 1]?.id || null
    const updated = lines.filter((line) => line.id !== targetId)
    setLines(updated)
    setSelectedLineId(nextSelection)
    setIsDirty(true)
  }, [lines, selectedLineId, activeLineId, pushHistory])

  const handleRenameSpeaker = useCallback(
    (event?: React.FormEvent) => {
      if (event) {
        event.preventDefault()
      }
      const source = renameFrom.trim()
      const target = renameTo.trim()
      if (!source || !target) {
        setRenameFeedback('Enter both the current and new speaker names.')
        return
      }
      pushHistory(lines)
      const normalizedSource = source.toUpperCase()
      const normalizedTarget = target.toUpperCase()
      let changes = 0
      setLines((prev) =>
        prev.map((line) => {
          if (line.speaker.trim().toUpperCase() === normalizedSource) {
            changes += 1
            return { ...line, speaker: normalizedTarget, rendered_text: undefined }
          }
          return line
        }),
      )
      if (changes === 0) {
        setRenameFeedback('No matching speaker labels were found.')
        return
      }
      setIsDirty(true)
      setRenameFeedback(`Renamed ${changes} line${changes === 1 ? '' : 's'}. Save to update exports.`)
    },
    [renameFrom, renameTo, lines, pushHistory],
  )

  const handleUndo = useCallback(() => {
    if (!history.length) return
    const previous = history[history.length - 1]
    setHistory((prev) => prev.slice(0, prev.length - 1))
    setFuture((prev) => [cloneLines(lines), ...prev])
    setLines(previous)
    setSelectedLineId(null)
    setIsDirty(true)
  }, [history, cloneLines, lines])

  const handleRedo = useCallback(() => {
    if (!future.length) return
    const [next, ...rest] = future
    setFuture(rest)
    setHistory((prev) => [...prev.slice(-49), cloneLines(lines)])
    setLines(next)
    setSelectedLineId(null)
    setIsDirty(true)
  }, [future, cloneLines, lines])

  const getViewerTemplate = useCallback(async () => {
    if (viewerTemplateCacheRef.current) return viewerTemplateCacheRef.current
    const response = await authenticatedFetch('/api/viewer-template')
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail?.detail || 'Failed to fetch viewer template')
    }
    const template = await response.text()
    viewerTemplateCacheRef.current = template
    return template
  }, [])

  const buildLocalArtifacts = useCallback(
    async (
      sourceLines: EditorLine[],
      sourceSessionMeta: EditorSessionResponse,
      mediaKeyForSave: string,
    ): Promise<{ lineEntries: EditorLine[]; pdfBase64: string; viewerHtmlBase64: string; oncueXmlBase64: string }> => {
      const linesPerPage = sourceSessionMeta.lines_per_page ?? 25
      const titleData = sourceSessionMeta.title_data ?? {}
      const lineEntries = normalizeLineEntriesForArtifacts(sourceLines, linesPerPage)

      const pdfResponse = await authenticatedFetch('/api/format-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title_data: titleData,
          line_entries: lineEntries,
          lines_per_page: linesPerPage,
        }),
      })
      if (!pdfResponse.ok) {
        const detail = await pdfResponse.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to regenerate PDF')
      }
      const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer())
      const pdfBase64 = bytesToBase64(pdfBytes)

      const template = await getViewerTemplate()
      const mediaContentType = sourceSessionMeta.media_content_type || effectiveMediaType || 'video/mp4'
      const mediaFilename =
        sourceSessionMeta.media_filename ||
        sourceSessionMeta.media_blob_name ||
        sourceSessionMeta.title_data?.FILE_NAME ||
        `${mediaKeyForSave}.${mediaContentType.startsWith('audio/') ? 'wav' : 'mp4'}`
      const viewerPayload = buildViewerPayloadFromLines(
        lineEntries,
        titleData,
        sourceSessionMeta.audio_duration ?? 0,
        linesPerPage,
        mediaFilename,
        mediaContentType,
      )
      const transcriptJson = escapeScriptBoundary(JSON.stringify(viewerPayload))
      const viewerHtml = template.replace('__TRANSCRIPT_JSON__', transcriptJson)
      if (viewerHtml === template) {
        throw new Error('Standalone viewer template missing transcript placeholder')
      }
      const viewerHtmlBase64 = utf8ToBase64(viewerHtml)
      const oncueXml = buildOncueXmlFromLineEntries(
        lineEntries,
        titleData,
        sourceSessionMeta.audio_duration ?? 0,
        linesPerPage,
      )
      const oncueXmlBase64 = utf8ToBase64(oncueXml)
      return { lineEntries, pdfBase64, viewerHtmlBase64, oncueXmlBase64 }
    },
    [effectiveMediaType, getViewerTemplate],
  )

  const refreshArtifacts = useCallback(async (): Promise<EditorSaveResponse | null> => {
    if (!activeMediaKey || !sessionMeta) return null
    setSaving(true)
    setError(null)
    try {
      const artifacts = await buildLocalArtifacts(lines, sessionMeta, activeMediaKey)
      const caseId = (sessionMeta as unknown as Record<string, unknown>).case_id
      const refreshedData: EditorSaveResponse = {
        ...sessionMeta,
        lines: artifacts.lineEntries,
        pdf_base64: artifacts.pdfBase64,
        viewer_html_base64: artifacts.viewerHtmlBase64,
        oncue_xml_base64: artifacts.oncueXmlBase64,
        updated_at: new Date().toISOString(),
      }
      await localSaveTranscript(
        activeMediaKey,
        refreshedData as unknown as Record<string, unknown>,
        typeof caseId === 'string' && caseId ? caseId : undefined,
      )
      setSessionMeta(refreshedData)
      setLines(refreshedData.lines || [])
      setIsDirty(false)
      onSessionChange(refreshedData)
      onSaveComplete(refreshedData)
      return refreshedData
    } catch (err: any) {
      setError(err.message || 'Failed to refresh exports')
      return null
    } finally {
      setSaving(false)
    }
  }, [activeMediaKey, buildLocalArtifacts, lines, onSaveComplete, onSessionChange, sessionMeta])

  const handleSave = useCallback(async (): Promise<EditorSaveResponse | null> => {
    if (!activeMediaKey) {
      setError('No media key available to save.')
      return null
    }
    if (!sessionMeta) {
      setError('No transcript available to save.')
      return null
    }

    setSaving(true)
    setError(null)

    try {
      const linesToSave = materializeLinesForSave()
      const artifacts = await buildLocalArtifacts(linesToSave, sessionMeta, activeMediaKey)
      const caseId = (sessionMeta as unknown as Record<string, unknown>).case_id
      const data: EditorSaveResponse = {
        ...sessionMeta,
        lines: artifacts.lineEntries,
        pdf_base64: artifacts.pdfBase64,
        viewer_html_base64: artifacts.viewerHtmlBase64,
        oncue_xml_base64: artifacts.oncueXmlBase64,
        title_data: sessionMeta?.title_data ?? {},
        audio_duration: sessionMeta?.audio_duration ?? 0,
        lines_per_page: sessionMeta?.lines_per_page ?? 25,
        updated_at: new Date().toISOString(),
      }
      await localSaveTranscript(
        activeMediaKey,
        data as unknown as Record<string, unknown>,
        typeof caseId === 'string' && caseId ? caseId : undefined,
      )

      setSessionMeta(data)
      setLines(data.lines || artifacts.lineEntries)
      setActiveMediaKey(data.media_key ?? activeMediaKey)
      setIsDirty(false)
      setActiveLineId(null)
      setSelectedLineId(null)
      setEditingField(null)
      activeLineMarker.current = null
      setHistory([])
      setFuture([])

      onSaveComplete(data)
      onSessionChange(data)

      return data

    } catch (err: any) {
      setError(err.message || 'Failed to save')
      return null
    } finally {
      setSaving(false)
    }
  }, [
    activeMediaKey,
    buildLocalArtifacts,
    materializeLinesForSave,
    onSaveComplete,
    onSessionChange,
    sessionMeta,
  ])

  const handleDownloadViewer = useCallback(async () => {
    const saved = hasPendingInlineEdit || isDirty ? await handleSave() : await refreshArtifacts()
    const htmlData = saved?.viewer_html_base64 ?? viewerHtmlBase64 ?? sessionMeta?.viewer_html_base64 ?? ''
    if (!htmlData) {
      setError('HTML viewer export is not available for this transcript.')
      return
    }
    const mediaBaseName = (sessionMeta?.title_data?.FILE_NAME || activeMediaKey || 'transcript')?.replace(/\.[^.]+$/, '')
    onDownload(htmlData, buildFilename(mediaBaseName + ' transcript', '.html'), 'text/html')
  }, [
    activeMediaKey,
    buildFilename,
    handleSave,
    hasPendingInlineEdit,
    isDirty,
    onDownload,
    refreshArtifacts,
    sessionMeta,
    viewerHtmlBase64,
  ])

  const handleDownloadXml = useCallback(async () => {
    const saved = hasPendingInlineEdit || isDirty ? await handleSave() : await refreshArtifacts()
    const xmlToDownload = saved?.oncue_xml_base64 ?? xmlBase64 ?? sessionMeta?.oncue_xml_base64 ?? ''
    if (!xmlToDownload) {
      setError('XML export is not available for this transcript.')
      return
    }
    const mediaNameRaw = sessionMeta?.title_data?.FILE_NAME || sessionMeta?.media_filename || activeMediaKey || 'transcript'
    const mediaBaseName = sanitizeDownloadStem(String(mediaNameRaw).replace(/\.[^.]+$/, ''))
    onDownload(xmlToDownload, `${mediaBaseName} transcript.xml`, 'application/xml')
  }, [
    activeMediaKey,
    handleSave,
    hasPendingInlineEdit,
    isDirty,
    onDownload,
    refreshArtifacts,
    sessionMeta,
    xmlBase64,
  ])

  const handleResync = useCallback(async () => {
    if (!activeMediaKey) {
      setResyncError('No active transcript to re-sync.')
      return
    }

    if (!confirm('This will update timestamps to match the media. Text stays the same. Continue?')) {
      return
    }

    setIsResyncing(true)
    setResyncError(null)

    try {
      const mediaSourceId = sessionMeta?.media_handle_id || activeMediaKey
      const mediaFile = await getMediaFile(mediaSourceId)
      if (!mediaFile) {
        throw new Error('Media file not available. Please relink the media file first.')
      }
      const transcriptPayload = {
        media_key: activeMediaKey,
        lines,
        audio_duration: sessionMeta?.audio_duration ?? 0,
        title_data: sessionMeta?.title_data ?? {},
        lines_per_page: sessionMeta?.lines_per_page ?? 25,
        source_turns: sessionMeta?.source_turns,
      }
      const formData = new FormData()
      formData.append('media_file', mediaFile)
      formData.append('transcript_data', JSON.stringify(transcriptPayload))
      const response = await authenticatedFetch('/api/resync', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Re-sync failed')
      }
      const data = await response.json() as Record<string, unknown>

      // Use the response data directly instead of refetching
      // (GCS write propagation can cause fetchTranscript to get stale data)
      if (data.lines) {
        // Save current state to history so user can undo the resync
        pushHistory(lines)
        setLines(data.lines as EditorLine[])
        setIsDirty(true)
      }

      // Update session meta with new artifacts
      setSessionMeta((prev) => prev ? {
        ...prev,
        lines: (data.lines as EditorLine[] | undefined) ?? prev.lines,
        pdf_base64: (data.pdf_base64 as string | undefined) ?? prev.pdf_base64,
        oncue_xml_base64: (data.oncue_xml_base64 as string | undefined) ?? prev.oncue_xml_base64,
        viewer_html_base64: (data.viewer_html_base64 as string | undefined) ?? prev.viewer_html_base64,
      } : prev)

      // Notify parent of the update (skip SYNC EFFECT reset since we already set isDirty/history)
      if (sessionMeta) {
        skipSyncEffectReset.current = true
        onSessionChange({
          ...sessionMeta,
          lines: (data.lines as EditorLine[] | undefined) ?? sessionMeta.lines,
          pdf_base64: (data.pdf_base64 as string | undefined) ?? sessionMeta.pdf_base64,
          oncue_xml_base64: (data.oncue_xml_base64 as string | undefined) ?? sessionMeta.oncue_xml_base64,
          viewer_html_base64: (data.viewer_html_base64 as string | undefined) ?? sessionMeta.viewer_html_base64,
        })
      }

    } catch (err: any) {
      setResyncError(err.message || 'Re-sync failed')
    } finally {
      setIsResyncing(false)
    }
  }, [activeMediaKey, sessionMeta, onSessionChange, pushHistory, lines])

  const pdfData = pdfBase64 ?? sessionMeta?.pdf_base64 ?? docxBase64 ?? sessionMeta?.docx_base64 ?? ''
  const canSave = isDirty || hasPendingInlineEdit
  const updatedLabel = sessionMeta?.updated_at ? new Date(sessionMeta.updated_at).toLocaleString() : '—'

  const handleDownloadPdf = useCallback(async () => {
    const saved = canSave ? await handleSave() : await refreshArtifacts()
    const pdfToDownload = saved?.pdf_base64 ?? pdfData

    if (!pdfToDownload) {
      setError('PDF export is not available for this transcript.')
      return
    }

    const mediaNameRaw = sessionMeta?.title_data?.FILE_NAME || sessionMeta?.media_filename || activeMediaKey || 'transcript'
    const mediaBaseName = sanitizeDownloadStem(String(mediaNameRaw).replace(/\.[^.]+$/, ''))
    onDownload(pdfToDownload, `${mediaBaseName} transcript.pdf`, 'application/pdf')
  }, [activeMediaKey, canSave, handleSave, onDownload, pdfData, refreshArtifacts, sessionMeta])

  const isTypingInField = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  }, [])

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const wantsSave = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's'
      if (wantsSave) {
        event.preventDefault()
        if (!saving && sessionMeta && canSave) {
          void handleSave()
        }
        return
      }

      if (isTypingInField(event.target)) return

      const player = isVideo ? videoRef.current : audioRef.current
      if (!player) return

      if (event.code === 'Space') {
        event.preventDefault()
        if (player.paused) {
          player.play().catch(() => {})
        } else {
          player.pause()
        }
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        player.currentTime = Math.max(0, player.currentTime - 5)
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const nextTime = player.currentTime + 5
        if (Number.isFinite(player.duration)) {
          player.currentTime = Math.min(player.duration, nextTime)
        } else {
          player.currentTime = nextTime
        }
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [canSave, handleSave, isTypingInField, isVideo, saving, sessionMeta])

  return (
    <div className="space-y-6 relative">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        {/* Clean Header Toolbar */}
        <div className="flex items-center justify-between gap-4 p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <button
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-600 disabled:opacity-40"
              onClick={handleUndo}
              disabled={!history.length}
              title="Undo (Ctrl+Z)"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M3 10h10a5 5 0 015 5v2M3 10l6-6M3 10l6 6" />
              </svg>
            </button>
            <button
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-600 disabled:opacity-40"
              onClick={handleRedo}
              disabled={!future.length}
              title="Redo (Ctrl+Y)"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M21 10h-10a5 5 0 00-5 5v2M21 10l-6-6M21 10l-6 6" />
              </svg>
            </button>
            <div className="w-px h-6 bg-gray-200" />
            <button
              className="px-3 py-1.5 rounded-lg bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium"
              onClick={handleAddUtterance}
              title="Add new line after selection"
            >
              + Add Line
            </button>
            <button
              className="px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-sm font-medium"
              onClick={handleDeleteUtterance}
              title="Delete selected line"
            >
              Delete Line
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {onOpenViewer && (
              <button
                className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium inline-flex items-center gap-1.5"
                onClick={onOpenViewer}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                View in Viewer
              </button>
            )}
            <button
              className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
              onClick={handleDownloadPdf}
              disabled={saving || !sessionMeta || !activeMediaKey}
            >
              Export PDF
            </button>
            {appVariant === 'oncue' ? (
              <button
                className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
                onClick={handleDownloadXml}
                disabled={!activeMediaKey}
              >
                Export XML
              </button>
            ) : (
              <button
                className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
                onClick={handleDownloadViewer}
                disabled={!activeMediaKey}
              >
                Export Player
              </button>
            )}
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
              <button
                className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium"
                onClick={onOpenHistory}
              >
                Edit History
              </button>
            )}
            <button
              className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium"
              onClick={() => setShowRenameModal(true)}
            >
              Rename Speakers
            </button>
            <button
              className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-sm font-medium disabled:opacity-50"
              onClick={handleResync}
              disabled={isResyncing || !resolvedMediaUrl}
              title="Re-align timestamps to audio"
            >
              {isResyncing ? 'Fixing...' : 'Fix Timing to Audio'}
            </button>
            {onGeminiRefine && (
              <button
                className="px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 text-sm font-medium disabled:opacity-50"
                onClick={onGeminiRefine}
                disabled={isGeminiBusy}
              >
                {isGeminiBusy ? 'Running...' : 'Clean Wording (AI)'}
              </button>
            )}
            <button
              className="px-4 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium disabled:opacity-50"
              onClick={handleSave}
              disabled={saving || !sessionMeta || !canSave}
            >
              {saving ? 'Saving...' : canSave ? 'Save Changes' : 'Saved'}
            </button>
          </div>
        </div>

        {/* Collapsible Settings Panel */}
        {showSettings && (
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                className="rounded border-gray-300"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
              />
              Auto-scroll to current line
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer" title="When changing end time, adjust next line's start">
              <input
                type="checkbox"
                className="rounded border-gray-300"
                checked={autoShiftNextLine}
                onChange={(event) => setAutoShiftNextLine(event.target.checked)}
              />
              Auto-shift next line timing
            </label>
          </div>
        )}
        <div className="card-body space-y-4">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {geminiError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Gemini Error: {geminiError}
            </div>
          )}
          {snapshotError && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {snapshotError}
            </div>
          )}
          {(addError || deleteError) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {addError || deleteError}
            </div>
          )}
          {resyncError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Re-sync Error: {resyncError}
            </div>
          )}

          {/* Media Player */}
          {resolvedMediaUrl ? (
            <div className="rounded-xl bg-gray-900 p-3">
              {isVideo ? (
                <video
                  key={resolvedMediaUrl}
                  ref={videoRef}
                  controls
                  preload="metadata"
                  className="w-full max-h-[32vh] rounded-lg bg-black object-contain"
                  src={resolvedMediaUrl}
                  onError={() => { void handleMediaError() }}
                />
              ) : (
                <audio
                  key={resolvedMediaUrl}
                  ref={audioRef}
                  controls
                  preload="metadata"
                  className="w-full"
                  src={resolvedMediaUrl}
                  onError={() => { void handleMediaError() }}
                />
              )}
            </div>
          ) : (
            <div className="rounded-xl border-2 border-dashed border-gray-300 p-6 text-center">
              <svg className="w-8 h-8 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <p className="text-sm text-gray-500">Import source audio/video to enable playback, clip creation, and timing correction.</p>
              {onRequestMediaImport && (
                <button
                  type="button"
                  onClick={onRequestMediaImport}
                  className="mt-4 inline-flex items-center justify-center rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-700"
                >
                  Import Media File
                </button>
              )}
            </div>
          )}

          <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-5 text-gray-600">
              <span>Lines <span className="font-medium text-gray-900">{lines.length}</span></span>
              <span>Duration <span className="font-medium text-gray-900">{secondsToLabel(sessionMeta?.audio_duration ?? 0)}</span></span>
              <span>Updated <span className="font-medium text-gray-900 text-xs">{updatedLabel}</span></span>
            </div>
            <span
              className="text-xs text-primary-700 underline decoration-dotted cursor-help"
              title={'Shortcuts:\nSpace - Play/Pause\nLeft/Right - Skip 5s\nDouble-click line - Play from line'}
            >
              Shortcuts
            </span>
          </div>

          {manualScrollOverride && autoScroll && activeLineId && (
            <div className="flex justify-end">
              <button
                type="button"
                className="rounded-lg border border-primary-300 bg-white px-3 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-50"
                onClick={handleReturnToCurrentLine}
              >
                Return to current line
              </button>
            </div>
          )}

          <div className="rounded-lg border border-primary-200 bg-white shadow-inner">
            <div className="border-b border-primary-200 px-5 py-3">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search transcript... (Ctrl+F)"
                  className="input w-full pr-20"
                  value={searchQuery}
                  onChange={(e) => performSearch(e.target.value)}
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
                    <span className="text-xs text-primary-500">
                      {searchMatches.length > 0 ? `${searchCurrentIndex + 1}/${searchMatches.length}` : '0/0'}
                    </span>
                    <button
                      type="button"
                      className="p-1 text-primary-400 hover:text-primary-600"
                      onClick={() => goToSearchResult('prev')}
                      title="Previous (Shift+Enter)"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="p-1 text-primary-400 hover:text-primary-600"
                      onClick={() => goToSearchResult('next')}
                      title="Next (Enter)"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="p-1 text-primary-400 hover:text-primary-600"
                      onClick={clearSearch}
                      title="Clear"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-[70px_170px_minmax(0,1fr)_140px] border-b border-primary-200 bg-primary-100 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-primary-600">
              <div>Pg:Ln</div>
              <div>Speaker</div>
              <div>Utterance</div>
              <div className="text-right">Timing</div>
            </div>

            <div
              ref={transcriptScrollRef}
              className="h-[62vh] overflow-y-auto"
              onScroll={handleTranscriptScroll}
            >
              {loading ? (
                <div className="p-6 text-center text-primary-500">Loading editor…</div>
              ) : lines.length === 0 ? (
                <div className="p-6 text-center text-primary-500">No lines available.</div>
              ) : (
                lines.map((line) => {
                  const isActive = activeLineId === line.id
                  const isSelected = selectedLineId === line.id
                  const isSearchMatch = searchMatches.includes(line.id)
                  const isCurrentSearchMatch = searchMatches[searchCurrentIndex] === line.id
                  const rowBackgroundClass = isSelected
                    ? 'bg-primary-100 hover:bg-primary-100'
                    : isCurrentSearchMatch
                      ? 'bg-amber-300'
                      : isSearchMatch
                        ? 'bg-amber-100'
                        : isActive
                          ? 'bg-yellow-200'
                          : 'bg-white hover:bg-primary-200'
                  const rowClasses = [
                    'grid grid-cols-[70px_170px_minmax(0,1fr)_140px] items-start gap-3 border-b border-primary-100 px-5 py-3 text-sm transition-colors',
                    rowBackgroundClass,
                    isSelected ? 'ring-2 ring-inset ring-primary-500 border-l-4 border-l-primary-600' : '',
                  ]
                  const timingInputClass = line.timestamp_error
                    ? 'w-28 rounded border border-red-400 bg-red-50 px-2 py-1.5 text-sm text-red-700 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-400 text-right font-mono tabular-nums'
                    : 'w-28 rounded border border-primary-200 px-2 py-1.5 text-sm text-primary-800 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-400 text-right font-mono tabular-nums'
                  return (
                    <div
                      key={line.id}
                      ref={(el) => {
                        lineRefs.current[line.id] = el
                      }}
                      onClick={() => setSelectedLineId(line.id)}
                      onDoubleClick={() => playLine(line)}
                      className={rowClasses.join(' ')}
                    >
                      <div className="text-sm font-mono text-primary-500">
                        {line.page ?? '—'}:{line.line ?? '—'}
                      </div>
                      <div
                        className="min-w-0 cursor-pointer truncate text-primary-900 pr-4"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (!isSelected) {
                            setSelectedLineId(line.id)
                            return
                          }
                          beginEdit(line, 'speaker')
                        }}
                      >
                        {editingField && editingField.lineId === line.id && editingField.field === 'speaker' ? (
                          <input
                            ref={editInputRef as React.MutableRefObject<HTMLInputElement | null>}
                            className="input text-sm uppercase"
                            value={editingField.value}
                            onChange={(event) =>
                              setEditingField((prev) =>
                                prev ? { ...prev, value: event.target.value.toUpperCase() } : prev,
                              )
                            }
                            onBlur={commitEdit}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                commitEdit()
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                cancelEdit()
                              }
                            }}
                          />
                        ) : (
                          <span className="uppercase">{line.speaker || '—'}</span>
                        )}
                      </div>
                      <div
                        className="min-w-0 cursor-text whitespace-pre-wrap break-words font-mono text-primary-800"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (!isSelected) {
                            setSelectedLineId(line.id)
                            return
                          }
                          beginEdit(line, 'text')
                        }}
                      >
                        {editingField && editingField.lineId === line.id && editingField.field === 'text' ? (
                          <textarea
                            ref={editInputRef as React.MutableRefObject<HTMLTextAreaElement | null>}
                            className="textarea text-sm"
                            rows={3}
                            value={editingField.value}
                            onChange={(event) =>
                              setEditingField((prev) => (prev ? { ...prev, value: event.target.value } : prev))
                            }
                            onBlur={commitEdit}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault()
                                commitEdit()
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                cancelEdit()
                              }
                            }}
                          />
                        ) : (
                          <span>{line.text || '—'}</span>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 text-sm text-primary-600">
                        {isSelected ? (
                          <>
                            <div className="flex items-center gap-2 text-xs text-primary-500">
                              <span className="uppercase tracking-wide text-xs text-primary-400">Start</span>
                              <input
                                type="number"
                                step="0.01"
                                min={0}
                                value={line.start}
                                onChange={(event) =>
                                  handleLineFieldChange(line.id, 'start', parseFloat(event.target.value))
                                }
                                className={timingInputClass}
                                title={line.timestamp_error ? 'Missing timestamp — adjust start/end to fix.' : undefined}
                              />
                            </div>
                            <div className="flex items-center gap-2 text-xs text-primary-500">
                              <span className="uppercase tracking-wide text-xs text-primary-400">End</span>
                              <input
                                type="number"
                                step="0.01"
                                min={0}
                                value={line.end}
                                onChange={(event) =>
                                  handleLineFieldChange(line.id, 'end', parseFloat(event.target.value))
                                }
                                className={timingInputClass}
                                title={line.timestamp_error ? 'Missing timestamp — adjust start/end to fix.' : undefined}
                              />
                            </div>
                            {line.timestamp_error && (
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-red-600">
                                Fix timing
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="font-mono tabular-nums text-xs text-primary-600">
                            {secondsToLabel(line.start)}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {showRenameModal && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Rename Speakers</h3>
              <button
                type="button"
                className="rounded border border-gray-200 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => setShowRenameModal(false)}
              >
                Close
              </button>
            </div>
            <form
              className="p-4 space-y-3"
              onSubmit={(event) => {
                handleRenameSpeaker(event)
              }}
            >
              {renameFeedback && (
                <div className="rounded bg-primary-50 px-3 py-2 text-sm text-primary-700">{renameFeedback}</div>
              )}
              <input
                type="text"
                value={renameFrom}
                onChange={(e) => { setRenameFrom(e.target.value.toUpperCase()); if (renameFeedback) setRenameFeedback(null) }}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm uppercase"
                placeholder="Current name"
              />
              <input
                type="text"
                value={renameTo}
                onChange={(e) => { setRenameTo(e.target.value.toUpperCase()); if (renameFeedback) setRenameFeedback(null) }}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm uppercase"
                placeholder="New name"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setShowRenameModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="rounded bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700" disabled={!lines.length}>
                  Rename All
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Re-sync Loading Overlay - uses z-[9999] to ensure it's above everything */}
      {isResyncing && (
        <div className="fixed top-0 left-0 right-0 bottom-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-2xl text-center">
            <div className="mb-4 flex justify-center">
              {/* Simple Spinner */}
              <svg className="h-10 w-10 animate-spin text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900">Re-syncing Transcript</h3>
            <p className="mt-2 text-sm text-gray-600">
              Automatically re-syncing the transcript to the media file. <br />
              This could take a few minutes for longer files.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
