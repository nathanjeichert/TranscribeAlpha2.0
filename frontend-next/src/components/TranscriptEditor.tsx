'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildMediaUrl, authenticatedFetch, getAuthHeaders } from '@/utils/auth'
import { saveTranscript as localSaveTranscript } from '@/lib/storage'
import { getMediaFile } from '@/lib/mediaHandles'

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

// localStorage helpers for cross-page state persistence
interface LocalStorageTranscriptState {
  mediaKey: string
  lines: EditorLine[]
  titleData: Record<string, string>
  mediaBlobName?: string | null
  mediaContentType?: string | null
  audioDuration: number
  linesPerPage: number
  lastSaved: string
}

const STORAGE_KEY_PREFIX = 'transcript_state_'
const AUTO_SHIFT_STORAGE_KEY = 'editor_auto_shift_next'
const AUTO_SHIFT_PADDING_SECONDS = 0.01

function saveToLocalStorage(mediaKey: string, state: LocalStorageTranscriptState) {
  try {
    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${mediaKey}`,
      JSON.stringify(state)
    )
  } catch (err) {
    console.error('Failed to save to localStorage:', err)
  }
}

function loadFromLocalStorage(mediaKey: string): LocalStorageTranscriptState | null {
  try {
    const data = localStorage.getItem(`${STORAGE_KEY_PREFIX}${mediaKey}`)
    if (!data) return null
    return JSON.parse(data)
  } catch (err) {
    console.error('Failed to load from localStorage:', err)
    return null
  }
}

function clearLocalStorage(mediaKey: string) {
  try {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mediaKey}`)
  } catch (err) {
    console.error('Failed to clear localStorage:', err)
  }
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
  onOpenHistory,
  onGeminiRefine,
  isGeminiBusy,
  geminiError,
}: TranscriptEditorProps) {
  const isCriminal = appVariant === 'criminal'
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

  // Rev AI Re-sync State
  const [isResyncing, setIsResyncing] = useState(false)
  const [resyncError, setResyncError] = useState<string | null>(null)

  const baseMediaUrl = useMemo(() => {
    if (mediaUrl) return mediaUrl
    if (sessionMeta?.media_blob_name) {
      return `/api/media/${sessionMeta.media_blob_name}`
    }
    return undefined
  }, [mediaUrl, sessionMeta])

  useEffect(() => {
    let isActive = true
    const resolveMedia = async () => {
      if (!baseMediaUrl) {
        if (isActive) setResolvedMediaUrl(undefined)
        return
      }
      if (isCriminal) {
        // Criminal: mediaUrl is already a blob URL or direct path
        if (isActive) setResolvedMediaUrl(baseMediaUrl)
        return
      }
      const resolved = await buildMediaUrl(baseMediaUrl)
      if (isActive) {
        setResolvedMediaUrl(resolved)
      }
    }
    void resolveMedia()
    return () => {
      isActive = false
    }
  }, [baseMediaUrl, isCriminal])

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
    // Criminal: blob URLs don't expire, nothing to refresh
    if (isCriminal) return
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
  }, [baseMediaUrl, isCriminal, isVideo])

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
    if (!target) return
    programmaticScrollRef.current = true
    target.scrollIntoView({ block: 'center', behavior })
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

  const fetchTranscript = useCallback(
    async (key?: string | null) => {
      // Criminal variant always receives initialData from the editor page; never fetch from API
      if (isCriminal) return

      const targetKey = key || activeMediaKey || initialMediaKey
      if (!targetKey) {
        setError('No media key provided')
        return
      }

      setLoading(true)
      setError(null)

      try {
        // Try loading from server first
        const response = await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(targetKey)}`)

        if (!response.ok) {
          if (response.status === 404) {
            // Try localStorage fallback
            const cached = loadFromLocalStorage(targetKey)
            if (cached) {
              setLines(cached.lines)
              setSessionMeta({
                title_data: cached.titleData,
                audio_duration: cached.audioDuration,
                lines_per_page: cached.linesPerPage,
                lines: cached.lines,
                media_blob_name: cached.mediaBlobName,
                media_content_type: cached.mediaContentType,
              } as EditorSessionResponse)
              setActiveMediaKey(targetKey)
              setError('Loaded from local cache. Save to sync with server.')
              setLoading(false)
              return
            }
          }

          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to load transcript')
        }

        const data: EditorSessionResponse = await response.json()
        setSessionMeta(data)
        setLines(data.lines || [])
        setActiveMediaKey(targetKey)
        setHistory([])
        setFuture([])
        setIsDirty(false)
        setActiveLineId(null)
        setSelectedLineId(null)
        setEditingField(null)
        activeLineMarker.current = null
        onSessionChange(data)

        // Save to localStorage for offline access
        saveToLocalStorage(targetKey, {
          mediaKey: targetKey,
          lines: data.lines || [],
          titleData: data.title_data ?? {},
          mediaBlobName: data.media_blob_name,
          mediaContentType: data.media_content_type,
          audioDuration: data.audio_duration,
          linesPerPage: data.lines_per_page,
          lastSaved: new Date().toISOString(),
        })

      } catch (err: any) {
        setError(err.message || 'Failed to load transcript')
      } finally {
        setLoading(false)
      }
    },
    [activeMediaKey, isCriminal, initialMediaKey, onSessionChange],
  )

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

  useEffect(() => {
    if (initialData || sessionMeta) return
    if (initialMediaKey || activeMediaKey) {
      fetchTranscript(initialMediaKey || activeMediaKey)
    }
  }, [initialData, sessionMeta, initialMediaKey, activeMediaKey, fetchTranscript])

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

  // beforeunload handler for cross-page persistence (skip for criminal - data is in workspace)
  useEffect(() => {
    if (isCriminal) return
    const handleBeforeUnload = () => {
      if (activeMediaKey && sessionMeta) {
        saveToLocalStorage(activeMediaKey, {
          mediaKey: activeMediaKey,
          lines,
          titleData: sessionMeta.title_data ?? {},
          mediaBlobName: sessionMeta.media_blob_name,
          mediaContentType: sessionMeta.media_content_type,
          audioDuration: sessionMeta.audio_duration,
          linesPerPage: sessionMeta.lines_per_page,
          lastSaved: new Date().toISOString(),
        })
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [activeMediaKey, isCriminal, lines, sessionMeta])

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

        if (isCriminal) {
          // Criminal: save directly to local workspace
          const dataToSave = {
            ...currentSessionMeta,
            lines: linesRef.current,
            updated_at: new Date().toISOString(),
          }
          await localSaveTranscript(
            activeMediaKey,
            dataToSave as unknown as Record<string, unknown>,
            (currentSessionMeta as unknown as Record<string, unknown>).case_id as string || undefined,
          )
        } else {
          // Oncue: auto-save to API
          await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(activeMediaKey)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lines: linesRef.current,
              title_data: currentSessionMeta.title_data ?? {},
              is_manual_save: false,
              audio_duration: currentSessionMeta.audio_duration,
              lines_per_page: currentSessionMeta.lines_per_page,
              media_blob_name: currentSessionMeta.media_blob_name,
              media_content_type: currentSessionMeta.media_content_type,
            }),
          })

          // Also save to localStorage for oncue
          saveToLocalStorage(activeMediaKey, {
            mediaKey: activeMediaKey,
            lines: linesRef.current,
            titleData: currentSessionMeta.title_data ?? {},
            mediaBlobName: currentSessionMeta.media_blob_name,
            mediaContentType: currentSessionMeta.media_content_type,
            audioDuration: currentSessionMeta.audio_duration,
            linesPerPage: currentSessionMeta.lines_per_page,
            lastSaved: new Date().toISOString(),
          })
        }

        lastSnapshotRef.current = now
        setSnapshotError(null)

      } catch (err: any) {
        setSnapshotError(err.message || 'Auto-save failed')
      }
    }, 60000)  // 60 seconds

    return () => clearInterval(interval)
  }, [activeMediaKey, isCriminal])  // Only reset interval when media key changes

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
            return { ...line, speaker: normalizedTarget }
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
      let data: EditorSaveResponse

      if (isCriminal) {
        // Criminal variant: save to local workspace
        const updatedData = {
          ...sessionMeta,
          lines,
          title_data: sessionMeta?.title_data ?? {},
          audio_duration: sessionMeta?.audio_duration ?? 0,
          lines_per_page: sessionMeta?.lines_per_page ?? 25,
          updated_at: new Date().toISOString(),
        }
        await localSaveTranscript(
          activeMediaKey,
          updatedData as unknown as Record<string, unknown>,
          (sessionMeta as unknown as Record<string, unknown>)?.case_id as string | undefined,
        )
        data = updatedData as EditorSaveResponse
      } else {
        const response = await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(activeMediaKey)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lines,
            title_data: sessionMeta?.title_data ?? {},
            is_manual_save: true,
            audio_duration: sessionMeta?.audio_duration ?? 0,
            lines_per_page: sessionMeta?.lines_per_page ?? 25,
            media_blob_name: sessionMeta?.media_blob_name,
            media_content_type: sessionMeta?.media_content_type,
          }),
        })

        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to save')
        }

        data = await response.json()
      }

      setSessionMeta(data)
      setLines(data.lines || [])
      setActiveMediaKey(data.media_key ?? activeMediaKey)
      setIsDirty(false)
      setActiveLineId(null)
      setSelectedLineId(null)
      setEditingField(null)
      activeLineMarker.current = null
      setHistory([])
      setFuture([])

      // Save to localStorage (skip for criminal - data is in workspace)
      if (!isCriminal) {
        saveToLocalStorage(data.media_key ?? activeMediaKey, {
          mediaKey: data.media_key ?? activeMediaKey!,
          lines: data.lines || [],
          titleData: data.title_data ?? {},
          mediaBlobName: data.media_blob_name,
          mediaContentType: data.media_content_type,
          audioDuration: data.audio_duration,
          linesPerPage: data.lines_per_page,
          lastSaved: new Date().toISOString(),
        })
      }

      onSaveComplete(data)
      onSessionChange(data)

      return data

    } catch (err: any) {
      setError(err.message || 'Failed to save')
      return null
    } finally {
      setSaving(false)
    }
  }, [activeMediaKey, isCriminal, lines, sessionMeta, onSaveComplete, onSessionChange])

  const regenerateViewerHtml = useCallback(async () => {
    if (!activeMediaKey) return null
    if (isCriminal) {
      // Criminal variant: viewer regeneration deferred to local generation (Agent 2)
      return sessionMeta?.viewer_html_base64 ?? null
    }
    try {
      const response = await authenticatedFetch(
        `/api/transcripts/by-key/${encodeURIComponent(activeMediaKey)}/regenerate-viewer`,
        { method: 'POST' },
      )
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to regenerate HTML viewer')
      }
      const data = await response.json()
      if (data?.viewer_html_base64) {
        setSessionMeta((prev) => {
          if (!prev) return prev
          const next = {
            ...prev,
            viewer_html_base64: data.viewer_html_base64,
            updated_at: data.updated_at ?? prev.updated_at,
          }
          onSessionChange(next)
          return next
        })
      }
      return data?.viewer_html_base64 ?? null
    } catch (err: any) {
      setError(err.message || 'Failed to regenerate HTML viewer')
      return null
    }
  }, [activeMediaKey, isCriminal, onSessionChange, sessionMeta?.viewer_html_base64])

  const handleDownloadViewer = useCallback(async () => {
    if (!isCriminal) return
    let htmlData = viewerHtmlBase64 ?? sessionMeta?.viewer_html_base64 ?? ''
    if (isDirty) {
      const saved = await handleSave()
      if (!saved?.viewer_html_base64) {
        return
      }
      htmlData = saved.viewer_html_base64
    } else {
      const refreshed = await regenerateViewerHtml()
      htmlData = refreshed ?? htmlData
    }
    if (!htmlData) {
      setError('HTML viewer export is not available for this transcript.')
      return
    }
    const mediaBaseName = (sessionMeta?.title_data?.FILE_NAME || activeMediaKey || 'transcript')?.replace(/\.[^.]+$/, '')
    onDownload(htmlData, buildFilename(mediaBaseName + ' transcript', '.html'), 'text/html')
  }, [activeMediaKey, buildFilename, handleSave, isCriminal, isDirty, onDownload, regenerateViewerHtml, sessionMeta, viewerHtmlBase64])

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
      let data: Record<string, unknown>

      if (isCriminal) {
        // Criminal: upload media file + transcript as multipart to /api/resync-local
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
        const response = await authenticatedFetch('/api/resync-local', {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Re-sync failed')
        }
        data = await response.json()
      } else {
        // Oncue: JSON body with media_key
        const response = await authenticatedFetch('/api/resync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            media_key: activeMediaKey,
          }),
        })

        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Re-sync failed')
        }

        data = await response.json()
      }

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
  }, [activeMediaKey, sessionMeta, onSessionChange, pushHistory, lines, isCriminal])

  const pdfData = pdfBase64 ?? sessionMeta?.pdf_base64 ?? docxBase64 ?? sessionMeta?.docx_base64 ?? ''
  const xmlData = xmlBase64 ?? sessionMeta?.oncue_xml_base64 ?? ''
  const updatedLabel = sessionMeta?.updated_at ? new Date(sessionMeta.updated_at).toLocaleString() : '—'

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
        if (!saving && sessionMeta && isDirty) {
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
  }, [handleSave, isDirty, isTypingInField, isVideo, saving, sessionMeta])

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
            <button
              className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
              onClick={() => pdfData && onDownload(pdfData, buildFilename('Transcript-Edited', '.pdf'), 'application/pdf')}
              disabled={!pdfData}
            >
              Export PDF
            </button>
            {appVariant === 'oncue' ? (
              <button
                className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
                onClick={() => xmlData && onDownload(xmlData, buildFilename('Transcript-Edited', '.xml'), 'application/xml')}
                disabled={!xmlData}
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
              disabled={saving || !sessionMeta || !isDirty}
            >
              {saving ? 'Saving...' : isDirty ? 'Save Changes' : 'Saved'}
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

            <div className="grid grid-cols-[70px_170px_minmax(0,1fr)_220px] border-b border-primary-200 bg-primary-100 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-primary-600">
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
                    'grid grid-cols-[70px_170px_minmax(0,1fr)_220px] items-start gap-5 border-b border-primary-100 px-5 py-3 text-sm transition-colors',
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
                        className="min-w-0 cursor-text whitespace-pre-wrap font-mono text-primary-800 pr-6"
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
