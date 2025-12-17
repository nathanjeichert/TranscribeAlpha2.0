'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAuthHeaders } from '@/utils/auth'

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
  media_blob_name?: string | null
  media_content_type?: string | null
  title_data: Record<string, string>
  audio_duration: number
  lines_per_page: number
  lines: EditorLine[]
  created_at?: string
  updated_at?: string
  expires_at?: string
  docx_base64?: string | null
  oncue_xml_base64?: string | null
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
  docxBase64?: string | null
  xmlBase64?: string | null
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
  onSessionChange: (session: EditorSessionResponse) => void
  onSaveComplete: (result: EditorSaveResponse) => void
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
  docxBase64,
  xmlBase64,
  onDownload,
  buildFilename,
  onSessionChange,
  onSaveComplete,
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

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const activeLineMarker = useRef<string | null>(null)

  const [importXmlFile, setImportXmlFile] = useState<File | null>(null)
  const [importMediaFile, setImportMediaFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [localMediaPreviewUrl, setLocalMediaPreviewUrl] = useState<string | null>(null)
  const [localMediaType, setLocalMediaType] = useState<string | undefined>(undefined)
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [renameFeedback, setRenameFeedback] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [history, setHistory] = useState<EditorLine[][]>([])
  const [future, setFuture] = useState<EditorLine[][]>([])
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const lastSnapshotRef = useRef<number>(0)

  // Rev AI Re-sync State
  const [isResyncing, setIsResyncing] = useState(false)
  const [resyncError, setResyncError] = useState<string | null>(null)

  const effectiveMediaUrl = useMemo(() => {
    if (localMediaPreviewUrl) return localMediaPreviewUrl
    if (mediaUrl) return mediaUrl
    if (sessionMeta?.media_blob_name) {
      return `/api/media/${sessionMeta.media_blob_name}`
    }
    return undefined
  }, [localMediaPreviewUrl, mediaUrl, sessionMeta])

  const effectiveMediaType = useMemo(
    () => localMediaType ?? mediaType ?? sessionMeta?.media_content_type ?? undefined,
    [localMediaType, mediaType, sessionMeta],
  )

  const isVideo = useMemo(
    () => (effectiveMediaType ?? '').startsWith('video/'),
    [effectiveMediaType],
  )



  const lineBoundaries = useMemo(
    () =>
      lines.map((line) => ({
        id: line.id,
        start: line.start,
        end: line.end > line.start ? line.end : line.start + 0.05,
      })),
    [lines],
  )

  const fetchTranscript = useCallback(
    async (key?: string | null) => {
      const targetKey = key || activeMediaKey || initialMediaKey
      if (!targetKey) {
        setError('No media key provided')
        return
      }

      setLoading(true)
      setError(null)

      try {
        // Try loading from server first
        const response = await fetch(`/api/transcripts/by-key/${encodeURIComponent(targetKey)}`, {
          headers: getAuthHeaders(),
        })

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
    [activeMediaKey, initialMediaKey, onSessionChange],
  )

  useEffect(() => {
    if (!initialData) return
    console.log('[SYNC EFFECT] initialData.media_key:', initialData.media_key)
    console.log('[SYNC EFFECT] initialMediaKey prop:', initialMediaKey)
    setSessionMeta(initialData)
    setLines(initialData.lines ?? [])
    // Only update activeMediaKey from props, not from internal state (to avoid circular updates)
    const resolvedKey = initialData.media_key ?? initialMediaKey ?? null
    console.log('[SYNC EFFECT] Setting activeMediaKey to resolvedKey:', resolvedKey)
    if (resolvedKey) {
      setActiveMediaKey(resolvedKey)
    }
    setHistory([])
    setFuture([])
    setIsDirty(false)
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
    if (!editingField) return
    if (editInputRef.current) {
      editInputRef.current.focus()
      if (editingField.field === 'speaker' && 'select' in editInputRef.current) {
        ; (editInputRef.current as HTMLInputElement).select()
      }
    }
  }, [editingField]) // Only run when lineId or field changes, not when value changes

  useEffect(() => {
    const player = effectiveMediaUrl ? (isVideo ? videoRef.current : audioRef.current) : null
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
        if (autoScroll) {
          const target = lineRefs.current[currentLineId]
          if (target) {
            target.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
        }
      }
    }

    player.addEventListener('timeupdate', handleTimeUpdate)
    return () => {
      player.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [effectiveMediaUrl, isVideo, lineBoundaries, autoScroll])

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
      if (!effectiveMediaUrl) return
      setSelectedLineId(line.id)
      const player = isVideo ? videoRef.current : audioRef.current
      if (!player) return
      player.currentTime = line.start
      player.play().catch(() => {
        /* ignored */
      })
    },
    [effectiveMediaUrl, isVideo],
  )

  useEffect(() => {
    return () => {
      if (localMediaPreviewUrl) {
        URL.revokeObjectURL(localMediaPreviewUrl)
      }
    }
  }, [localMediaPreviewUrl])

  // beforeunload handler for cross-page persistence
  useEffect(() => {
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
  }, [activeMediaKey, lines, sessionMeta])

  useEffect(() => {
    if (!activeMediaKey || !sessionMeta) return

    const interval = setInterval(async () => {
      if (!isDirty) return

      try {
        const now = Date.now()
        if (now - lastSnapshotRef.current < 5000) return  // Debounce

        // Auto-save creates both current state AND snapshot
        await fetch(`/api/transcripts/by-key/${encodeURIComponent(activeMediaKey)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            lines,
            title_data: sessionMeta.title_data ?? {},
            is_manual_save: false,  // Auto-save flag
            audio_duration: sessionMeta.audio_duration,
            lines_per_page: sessionMeta.lines_per_page,
            media_blob_name: sessionMeta.media_blob_name,
            media_content_type: sessionMeta.media_content_type,
          }),
        })

        lastSnapshotRef.current = now
        setSnapshotError(null)

        // Also save to localStorage
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

      } catch (err: any) {
        setSnapshotError(err.message || 'Auto-save failed')
      }
    }, 60000)  // Changed from 30000 to 60000 (1 minute)

    return () => clearInterval(interval)
  }, [activeMediaKey, sessionMeta, isDirty, lines])

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

  const handleSave = useCallback(async () => {
    if (!activeMediaKey) {
      setError('No media key available to save.')
      return
    }
    if (!sessionMeta) {
      setError('No transcript available to save.')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const response = await fetch(`/api/transcripts/by-key/${encodeURIComponent(activeMediaKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          lines,
          title_data: sessionMeta?.title_data ?? {},
          is_manual_save: true,  // Manual save flag
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

      const data: EditorSaveResponse = await response.json()
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

      // Save to localStorage
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

      onSaveComplete(data)
      onSessionChange(data)

    } catch (err: any) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [activeMediaKey, lines, sessionMeta, onSaveComplete, onSessionChange])

  const handleImport = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!importXmlFile) {
        setImportError('Select an OnCue XML file to import.')
        return
      }
      setImporting(true)
      setImportError(null)
      try {
        const formData = new FormData()
        formData.append('xml_file', importXmlFile)
        if (importMediaFile) {
          formData.append('media_file', importMediaFile)
        }

        const response = await fetch('/api/transcripts/import', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formData,
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to import transcript')
        }
        const data: EditorSessionResponse = await response.json()
        console.log('[IMPORT] Response data.media_key:', data.media_key)
        console.log('[IMPORT] Response data.media_blob_name:', data.media_blob_name)
        setSessionMeta(data)
        setLines(data.lines || [])
        setHistory([])
        setFuture([])
        setIsDirty(false)
        setActiveLineId(null)
        setSelectedLineId(null)
        setEditingField(null)
        activeLineMarker.current = null
        const importedMediaKey = data.media_key ?? data.title_data?.MEDIA_ID ?? data.media_blob_name ?? null
        console.log('[IMPORT] Setting activeMediaKey to:', importedMediaKey)
        if (importedMediaKey) {
          setActiveMediaKey(importedMediaKey)
        }
        onSessionChange(data)
        setImportXmlFile(null)
        setImportMediaFile(null)
      } catch (err: any) {
        setImportError(err.message || 'Failed to import transcript')
      } finally {
        setImporting(false)
      }
    },
    [importXmlFile, importMediaFile, onSessionChange],
  )

  const handleResync = useCallback(async () => {
    console.log('[RESYNC] handleResync called with activeMediaKey:', activeMediaKey)
    if (!activeMediaKey) {
      setResyncError('No active transcript to re-sync.')
      return
    }

    if (!confirm('This will update all timestamps based on audio alignment. Text changes will be preserved. Continue?')) {
      return
    }

    setIsResyncing(true)
    setResyncError(null)

    try {
      console.log('[RESYNC] Sending request with media_key:', activeMediaKey)
      const response = await fetch('/api/resync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          media_key: activeMediaKey,
        }),
      })

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Re-sync failed')
      }

      const data = await response.json()
      // data contains { status, lines, oncue_xml_base64 }

      // We need to update local state fully. 
      // Ideally we reload the full session to be safe, or patch it.
      // Let's reload the session to ensure consistency.
      await fetchTranscript(activeMediaKey)

    } catch (err: any) {
      setResyncError(err.message || 'Re-sync failed')
    } finally {
      setIsResyncing(false)
    }
  }, [activeMediaKey, fetchTranscript])

  const docxData = docxBase64 ?? sessionMeta?.docx_base64 ?? ''
  const xmlData = xmlBase64 ?? sessionMeta?.oncue_xml_base64 ?? ''
  const transcriptText = sessionMeta?.transcript ?? sessionMeta?.transcript_text ?? ''

  const sessionInfo = sessionMeta?.title_data ?? {}
  const expiresLabel = sessionMeta?.expires_at ? new Date(sessionMeta.expires_at).toLocaleString() : '—'
  const updatedLabel = sessionMeta?.updated_at ? new Date(sessionMeta.updated_at).toLocaleString() : '—'

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="card-header flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-medium">Manual Sync Editor</h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-white">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
              />
              Auto-scroll
            </label>
            <label
              className="flex items-center gap-2 text-sm text-white"
              title="When enabled, changing a line's end time snaps the next line's start time so it begins immediately after the edit."
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={autoShiftNextLine}
                onChange={(event) => setAutoShiftNextLine(event.target.checked)}
              />
              Auto-Shift Next Line
            </label>
            <div className="flex items-center gap-2">
              <button
                className="rounded-lg border-2 border-primary-200 bg-white px-3 py-2 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-400 hover:bg-primary-50"
                onClick={onOpenHistory}
                title="View transcript history and snapshots"
              >
                History
              </button>
              <button
                className="rounded-lg border-2 border-primary-200 bg-white px-3 py-2 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-400 hover:bg-primary-50 disabled:opacity-60"
                onClick={handleUndo}
                disabled={!history.length}
                title="Undo last edit"
              >
                Undo
              </button>
              <button
                className="rounded-lg border-2 border-primary-200 bg-white px-3 py-2 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-400 hover:bg-primary-50 disabled:opacity-60"
                onClick={handleRedo}
                disabled={!future.length}
                title="Redo"
              >
                Redo
              </button>
              <button
                className="rounded-lg border-2 border-primary-300 bg-primary-50 px-4 py-2 text-sm font-semibold text-primary-900 shadow-sm hover:border-primary-500 hover:bg-primary-100"
                onClick={handleAddUtterance}
                title="Insert a new utterance after the selected line. If there's a 2s gap before the next line, the new entry fills it; otherwise it takes the second half of the selected line's timing."
              >
                Add Utterance
              </button>
              <span
                className="cursor-help rounded-full border border-primary-300 px-2 py-0.5 text-xs font-bold text-primary-800"
                title="Adds a line after the highlighted row. If a 2+ second gap exists before the next line, it fills the gap. Otherwise, it splits the selected line and gives the second half to the new speaker."
              >
                ?
              </span>
              <button
                className="rounded-lg border-2 border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 shadow-sm hover:border-red-300 hover:bg-red-100"
                onClick={handleDeleteUtterance}
                title="Delete the selected utterance. At least one line must remain."
              >
                Delete Utterance
              </button>
            </div>
            {onGeminiRefine && (
              <button
                className="rounded-lg border-2 border-amber-400 bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-900 shadow-sm hover:bg-amber-200 disabled:opacity-60"
                onClick={onGeminiRefine}
                disabled={isGeminiBusy}
                title="Refine the current transcript using Gemini corrections."
              >
                {isGeminiBusy ? 'Running Gemini...' : 'Polish with Gemini 3.0'}
              </button>
            )}
            <button
              className="rounded-lg border-2 border-indigo-400 bg-indigo-100 px-4 py-2 text-sm font-semibold text-indigo-900 shadow-sm hover:bg-indigo-200 disabled:opacity-60"
              onClick={handleResync}
              disabled={isResyncing || !effectiveMediaUrl}
              title="Automatically re-align timestamps to the media file."
            >
              {isResyncing ? 'Re-syncing...' : 'Auto Re-sync'}
            </button>
            <button className="btn-primary px-4 py-2" onClick={handleSave} disabled={saving || !sessionMeta || !isDirty}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
        <div className="card-body space-y-6">
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

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
            <div className="space-y-4">
              {effectiveMediaUrl ? (
                <div className="rounded-lg border border-primary-200 bg-white p-4 space-y-2">
                  <p className="text-sm font-medium text-primary-900">Media Preview</p>
                  {isVideo ? (
                    <video
                      key={effectiveMediaUrl}
                      ref={videoRef}
                      controls
                      preload="metadata"
                      className="w-full rounded-lg border border-primary-200 shadow"
                      src={effectiveMediaUrl}
                    />
                  ) : (
                    <audio
                      key={effectiveMediaUrl}
                      ref={audioRef}
                      controls
                      preload="metadata"
                      className="w-full"
                      src={effectiveMediaUrl}
                    />
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-primary-300 p-4 text-sm text-primary-500">
                  Upload media to enable playback controls.
                </div>
              )}

              <div className="rounded-lg border border-primary-200 bg-primary-50 p-4 text-sm text-primary-700 space-y-2">
                <div className="flex justify-between">
                  <span className="font-medium text-primary-900">Updated</span>
                  <span>{updatedLabel}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-medium text-primary-900">Expires</span>
                  <span>{expiresLabel}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-medium text-primary-900">Lines</span>
                  <span>{lines.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-medium text-primary-900">Duration</span>
                  <span>{secondsToLabel(sessionMeta?.audio_duration ?? 0)}</span>
                </div>
              </div>

              <div className="rounded-lg border border-primary-200 bg-white p-4 space-y-3 text-sm text-primary-700">
                <h3 className="font-medium text-primary-900">Case Details</h3>
                <p>
                  <span className="font-semibold">Case:</span> {sessionInfo.CASE_NAME || '—'}
                </p>
                <p>
                  <span className="font-semibold">Number:</span> {sessionInfo.CASE_NUMBER || '—'}
                </p>
                <p>
                  <span className="font-semibold">Firm:</span> {sessionInfo.FIRM_OR_ORGANIZATION_NAME || '—'}
                </p>
                <p>
                  <span className="font-semibold">Date:</span> {sessionInfo.DATE || '—'}
                </p>
              </div>

              <div className="rounded-lg border border-primary-200 bg-white p-4 space-y-3 text-sm text-primary-700">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium text-primary-900">Rename Speaker</h3>
                  <span className="text-[10px] uppercase tracking-wide text-primary-400">Find & Replace</span>
                </div>
                <p className="text-xs text-primary-600">Replace every instance of a speaker label across the transcript.</p>
                {renameFeedback && (
                  <div className="rounded border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-800">
                    {renameFeedback}
                  </div>
                )}
                <form className="space-y-3" onSubmit={handleRenameSpeaker}>
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="text-xs font-medium text-primary-700">Current name</label>
                      <input
                        type="text"
                        value={renameFrom}
                        onChange={(event) => {
                          setRenameFrom(event.target.value.toUpperCase())
                          if (renameFeedback) setRenameFeedback(null)
                        }}
                        className="mt-1 w-full rounded border border-primary-200 px-3 py-2 text-xs uppercase text-primary-800 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-400"
                        placeholder="e.g., SPKR 01"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-primary-700">New name</label>
                      <input
                        type="text"
                        value={renameTo}
                        onChange={(event) => {
                          setRenameTo(event.target.value.toUpperCase())
                          if (renameFeedback) setRenameFeedback(null)
                        }}
                        className="mt-1 w-full rounded border border-primary-200 px-3 py-2 text-xs uppercase text-primary-800 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-400"
                        placeholder="e.g., WITNESS"
                      />
                    </div>
                  </div>
                  <button type="submit" className="btn-primary w-full text-sm" disabled={!lines.length}>
                    Rename Speaker
                  </button>
                </form>
              </div>

              <div className="rounded-lg border border-primary-200 bg-white p-4 space-y-3">
                <h3 className="text-sm font-medium text-primary-900">Import Existing Transcript</h3>
                {importError && (
                  <p className="text-xs text-red-600">{importError}</p>
                )}
                <form className="space-y-3" onSubmit={handleImport}>
                  <div>
                    <label className="text-xs font-medium text-primary-700">OnCue XML *</label>
                    <input
                      type="file"
                      accept=".xml"
                      onChange={(event) => setImportXmlFile(event.target.files?.[0] ?? null)}
                      className="mt-1 w-full text-xs text-primary-700 file:mr-3 file:rounded file:border-0 file:bg-primary-100 file:px-3 file:py-1 file:text-primary-800"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-primary-700">Media (optional)</label>
                    <input
                      type="file"
                      accept="audio/*,video/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null
                        setImportMediaFile(file)
                        if (localMediaPreviewUrl) {
                          URL.revokeObjectURL(localMediaPreviewUrl)
                        }
                        if (file) {
                          const url = URL.createObjectURL(file)
                          setLocalMediaPreviewUrl(url)
                          setLocalMediaType(file.type)
                        } else {
                          setLocalMediaPreviewUrl(null)
                          setLocalMediaType(undefined)
                        }
                      }}
                      className="mt-1 w-full text-xs text-primary-700 file:mr-3 file:rounded file:border-0 file:bg-primary-100 file:px-3 file:py-1 file:text-primary-800"
                    />
                  </div>
                  <button type="submit" className="btn-outline w-full text-sm" disabled={importing}>
                    {importing ? 'Importing…' : 'Import Transcript'}
                  </button>
                </form>
              </div>

              <div className="rounded-lg border border-primary-200 bg-white p-4 space-y-2 text-sm text-primary-700">
                <h3 className="font-medium text-primary-900">Downloads</h3>
                <button
                  className="btn-outline w-full"
                  onClick={() =>
                    docxData &&
                    onDownload(
                      docxData,
                      buildFilename('Transcript-Edited', '.docx'),
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    )
                  }
                  disabled={!docxData}
                >
                  Download DOCX
                </button>
                <button
                  className="btn-outline w-full"
                  onClick={() =>
                    xmlData && onDownload(xmlData, buildFilename('Transcript-Edited', '.xml'), 'application/xml')
                  }
                  disabled={!xmlData}
                >
                  Download OnCue XML
                </button>
                {transcriptText && (
                  <button
                    className="btn-outline w-full"
                    onClick={() =>
                      onDownload(
                        btoa(unescape(encodeURIComponent(transcriptText))),
                        buildFilename('Transcript-Preview', '.txt'),
                        'text/plain',
                      )
                    }
                  >
                    Download Transcript Text
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="rounded-lg border border-primary-200 bg-white shadow-inner">
                <div className="grid grid-cols-[70px_170px_minmax(0,1fr)_220px] border-b border-primary-200 bg-primary-100 px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-primary-600">
                  <div>Pg:Ln</div>
                  <div>Speaker</div>
                  <div>Utterance</div>
                  <div className="text-right">Timing</div>
                </div>
                <div className="max-h-[72vh] overflow-y-auto">
                  {loading ? (
                    <div className="p-6 text-center text-primary-500">Loading editor…</div>
                  ) : lines.length === 0 ? (
                    <div className="p-6 text-center text-primary-500">No lines available. Import or transcribe to begin editing.</div>
                  ) : (
                    lines.map((line) => {
                      const isActive = activeLineId === line.id
                      const isSelected = selectedLineId === line.id
                      const rowClasses = [
                        'grid grid-cols-[70px_170px_minmax(0,1fr)_220px] items-start gap-5 border-b border-primary-100 px-5 py-3 text-sm',
                        isActive ? 'bg-yellow-200' : 'bg-white hover:bg-primary-200',
                        isSelected ? 'ring-2 ring-primary-300' : '',
                      ]
                      return (
                        <div
                          key={line.id}
                          ref={(el) => {
                            lineRefs.current[line.id] = el
                          }}
                          onClick={() => setSelectedLineId(line.id)}
                          className={rowClasses.join(' ')}
                        >
                          <div className="text-xs font-mono text-primary-500">
                            {line.page ?? '—'}:{line.line ?? '—'}
                          </div>
                          <div
                            className="min-w-0 cursor-pointer truncate text-primary-900 pr-4"
                            onDoubleClick={() => beginEdit(line, 'speaker')}
                          >
                            {editingField && editingField.lineId === line.id && editingField.field === 'speaker' ? (
                              <input
                                ref={editInputRef as React.MutableRefObject<HTMLInputElement | null>}
                                className="input text-xs uppercase"
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
                              <span className="uppercase">{line.speaker}</span>
                            )}
                          </div>
                          <div
                            className="min-w-0 cursor-text whitespace-pre-wrap text-primary-800 pr-6"
                            onDoubleClick={() => beginEdit(line, 'text')}
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
                          <div className="flex items-center justify-end gap-5 text-xs text-primary-600">
                            <div className="flex flex-col items-end gap-1 text-[11px] text-primary-500">
                              <span className="uppercase tracking-wide text-[10px] text-primary-400">Start</span>
                              <input
                                type="number"
                                step="0.01"
                                min={0}
                                value={line.start}
                                onChange={(event) =>
                                  handleLineFieldChange(line.id, 'start', parseFloat(event.target.value))
                                }
                                className="w-24 rounded border border-primary-200 px-2 py-1 text-xs text-primary-800 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-400"
                              />
                            </div>
                            <div className="flex flex-col items-end gap-1 text-[11px] text-primary-500">
                              <span className="uppercase tracking-wide text-[10px] text-primary-400">End</span>
                              <input
                                type="number"
                                step="0.01"
                                min={0}
                                value={line.end}
                                onChange={(event) =>
                                  handleLineFieldChange(line.id, 'end', parseFloat(event.target.value))
                                }
                                className="w-24 rounded border border-primary-200 px-2 py-1 text-xs text-primary-800 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-400"
                              />
                            </div>
                            <button
                              type="button"
                              className="rounded border border-primary-300 px-3 py-1 text-xs font-medium text-primary-700 hover:border-primary-500 hover:bg-primary-100"
                              onClick={() => playLine(line)}
                              disabled={!effectiveMediaUrl}
                            >
                              Play
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

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
