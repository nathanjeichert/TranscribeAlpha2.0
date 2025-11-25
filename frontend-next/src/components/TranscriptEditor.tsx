'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  clips?: ClipSummary[]
}

export type EditorSaveResponse = EditorSessionResponse

interface TranscriptEditorProps {
  sessionId?: string | null
  initialMediaId?: string | null
  mediaUrl?: string
  mediaType?: string
  docxBase64?: string | null
  xmlBase64?: string | null
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
  onSessionChange: (session: EditorSessionResponse) => void
  onSaveComplete: (result: EditorSaveResponse) => void
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
  sessionId,
  initialMediaId,
  mediaUrl,
  mediaType,
  docxBase64,
  xmlBase64,
  onDownload,
  buildFilename,
  onSessionChange,
  onSaveComplete,
}: TranscriptEditorProps) {
  const [lines, setLines] = useState<EditorLine[]>([])
  const [sessionMeta, setSessionMeta] = useState<EditorSessionResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId ?? null)
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [editingField, setEditingField] = useState<{ lineId: string; field: 'speaker' | 'text'; value: string } | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const lastFetchedId = useRef<string | undefined>(undefined)
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
  const [showSnapshots, setShowSnapshots] = useState(false)
  const [snapshots, setSnapshots] = useState<
    { snapshot_id: string; created_at: string; media_key?: string | null; display_media_key?: string | null; saved?: boolean; session_id?: string | null; title_label?: string }[]
  >([])
  const [loadingSnapshots, setLoadingSnapshots] = useState(false)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const lastSnapshotRef = useRef<number>(0)
  const [selectedMediaKey, setSelectedMediaKey] = useState<string | null>(null)

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

  const fetchSession = useCallback(
    async (id?: string | null) => {
      setLoading(true)
      setError(null)
      try {
        const endpoint = id ? `/api/transcripts/${id}` : '/api/transcripts/latest'
        const response = await fetch(endpoint)
        if (!response.ok) {
          // Session expired or not found - attempt recovery if we have a media ID
          if (response.status === 404) {
            // PRIORITIZE initialMediaId passed from parent, fallback to localStorage
            const recoveryMediaId = initialMediaId || localStorage.getItem('last_active_media_id')

            if (recoveryMediaId) {
              console.log('Session expired, attempting recovery for media:', recoveryMediaId)
              try {
                // 1. List snapshots for this media
                const snapResponse = await fetch(`/api/snapshots/${encodeURIComponent(recoveryMediaId)}`)
                if (snapResponse.ok) {
                  const snapData = await snapResponse.json()
                  const snapshots = snapData.snapshots || []
                  if (snapshots.length > 0) {
                    // 2. Get the latest snapshot
                    const latestSnap = snapshots[0]
                    const restoreResponse = await fetch(`/api/snapshots/${encodeURIComponent(recoveryMediaId)}/${latestSnap.snapshot_id}`)
                    if (restoreResponse.ok) {
                      const restoreData = await restoreResponse.json()

                      // 3. Create new session from snapshot data
                      const createResponse = await fetch('/api/transcripts/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          lines: restoreData.lines,
                          title_data: restoreData.title_data,
                          media_blob_name: restoreData.media_blob_name, // Might be null in snapshot, but that's ok
                          media_content_type: restoreData.media_content_type,
                          audio_duration: restoreData.audio_duration,
                          lines_per_page: restoreData.lines_per_page
                        })
                      })

                      if (createResponse.ok) {
                        const newSession = await createResponse.json()
                        setSessionMeta(newSession)
                        setLines(newSession.lines || [])
                        setHistory([])
                        setFuture([])
                        setIsDirty(false)
                        setActiveSessionId(newSession.session_id)
                        lastFetchedId.current = newSession.session_id
                        onSessionChange(newSession)
                        // Silent recovery - user doesn't need to know session ID changed
                        // setError('Session expired. Restored from latest autosave.') 
                        return
                      }
                    }
                  }
                }
              } catch (recErr) {
                console.error('Recovery failed', recErr)
              }
            }
            // If no mediaId or recovery failed, and it was a 404 for a non-specific ID,
            // then treat it as no session found.
            if (!id) {
              setSessionMeta(null)
              setLines([])
              return
            }
          }

          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to load transcript session')
        }
        const data: EditorSessionResponse = await response.json()
        setSessionMeta(data)
        setLines(data.lines || [])

        // Persist MEDIA_ID for recovery
        const mediaId = data.title_data?.MEDIA_ID
        if (mediaId) {
          localStorage.setItem('last_active_media_id', mediaId)
        }

        setHistory([])
        setFuture([])
        setIsDirty(false)
        setActiveLineId(null)
        setSelectedLineId(null)
        setEditingField(null)
        activeLineMarker.current = null
        onSessionChange(data)

        if (!id && data.session_id) {
          lastFetchedId.current = data.session_id
          setActiveSessionId(data.session_id)
        } else {
          lastFetchedId.current = id ?? undefined
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load transcript session')
      } finally {
        setLoading(false)
      }
    },
    [onSessionChange],
  )

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
  }, [editingLineId, editingFieldName]) // Only run when lineId or field changes, not when value changes

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
      setLines((prev) =>
        prev.map((line) =>
          line.id === lineId
            ? {
              ...line,
              [field]:
                field === 'speaker' || field === 'text'
                  ? typeof value === 'string'
                    ? value
                    : value.toString()
                  : typeof value === 'number'
                    ? value
                    : parseFloat(value as string) || 0,
            }
            : line,
        ),
      )
      setIsDirty(true)
    },
    [],
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

  useEffect(() => {
    if (!sessionMeta?.session_id) return
    const interval = setInterval(async () => {
      if (!isDirty) return
      try {
        const now = Date.now()
        if (now - lastSnapshotRef.current < 5000) return
        await fetch(`/api/transcripts/${sessionMeta.session_id}/snapshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lines,
            title_data: sessionMeta.title_data ?? {},
            saved: false,
          }),
        })
        lastSnapshotRef.current = now
        setSnapshotError(null)
      } catch (err: any) {
        setSnapshotError(err.message || 'Snapshot save failed')
      }
    }, 30000)
    return () => clearInterval(interval)
  }, [sessionMeta?.session_id, isDirty, lines, sessionMeta])

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

  const loadSnapshots = useCallback(async () => {
    setLoadingSnapshots(true)
    setSnapshotError(null)
    try {
      const response = await fetch('/api/transcripts/snapshots')
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to load snapshots')
      }
      const data = await response.json()
      const snaps = (data?.snapshots as any[]) || []
      setSnapshots(snaps)
      if (snaps.length && !selectedMediaKey) {
        setSelectedMediaKey(snaps[0].display_media_key || snaps[0].media_key || 'unknown')
      }
    } catch (err: any) {
      setSnapshotError(err.message || 'Failed to load snapshots')
    } finally {
      setLoadingSnapshots(false)
    }
  }, [selectedMediaKey])

  const handleRestoreSnapshot = useCallback(
    async (snapshotId: string, mediaKey?: string | null) => {
      const path = mediaKey ? `/api/snapshots/${mediaKey}/${snapshotId}` : !selectedMediaKey ? null : `/api/snapshots/${selectedMediaKey}/${snapshotId}`
      if (!path) return
      setSnapshotError(null)
      try {
        const response = await fetch(path)
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to load snapshot')
        }
        const data = await response.json()
        const restoredLines: EditorLine[] = data.lines || []
        const nextMeta: EditorSessionResponse = {
          ...(sessionMeta || {}),
          session_id: data.session_id ?? sessionMeta?.session_id ?? null,
          title_data: data.title_data ?? sessionMeta?.title_data ?? {},
          audio_duration: data.audio_duration ?? sessionMeta?.audio_duration ?? 0,
          lines_per_page: data.lines_per_page ?? sessionMeta?.lines_per_page ?? 25,
          oncue_xml_base64: data.oncue_xml_base64 ?? sessionMeta?.oncue_xml_base64 ?? null,
          media_blob_name: sessionMeta?.media_blob_name ?? null,
          media_content_type: sessionMeta?.media_content_type ?? null,
          lines: restoredLines,
        }
        setLines(restoredLines)
        setSessionMeta(nextMeta)
        setHistory([])
        setFuture([])
        setIsDirty(true)
        setSelectedLineId(null)
        setShowSnapshots(false)
      } catch (err: any) {
        setSnapshotError(err.message || 'Failed to restore snapshot')
      }
    },
    [sessionMeta, setSessionMeta],
  )

  const handleSave = useCallback(async () => {
    const targetSessionId = sessionMeta?.session_id ?? activeSessionId
    if (!targetSessionId) {
      setError('No transcript session available to save.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      let response = await fetch(`/api/transcripts/${targetSessionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lines,
          title_data: sessionMeta?.title_data ?? {},
          media_blob_name: sessionMeta?.media_blob_name ?? null,
          media_content_type: sessionMeta?.media_content_type ?? null,
        }),
      })

      // Recovery: If session not found (404), create a new one with current state
      if (response.status === 404) {
        console.log('Session expired during save. Creating new session...')
        response = await fetch('/api/transcripts/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lines,
            title_data: sessionMeta?.title_data ?? {},
            media_blob_name: sessionMeta?.media_blob_name ?? null,
            media_content_type: sessionMeta?.media_content_type ?? null,
            audio_duration: sessionMeta?.audio_duration ?? 0,
            lines_per_page: sessionMeta?.lines_per_page ?? 25
          })
        })
      }

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to save editor session')
      }

      const data: EditorSaveResponse = await response.json()
      setSessionMeta(data)
      setLines(data.lines || [])
      setIsDirty(false)
      setActiveLineId(null)
      setSelectedLineId(null)
      setEditingField(null)
      activeLineMarker.current = null
      setHistory([])
      setFuture([])

      // If we recovered (ID changed), update state and URL
      if (data.session_id && data.session_id !== targetSessionId) {
        setActiveSessionId(data.session_id)
        lastFetchedId.current = data.session_id
        // Update URL without reload
        window.history.replaceState(null, '', `/editor?session=${data.session_id}`)
        setError('Session expired. Saved as new session.')
      }

      onSaveComplete(data)
      onSessionChange(data)

      try {
        await fetch(`/api/transcripts/${data.session_id}/snapshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lines,
            title_data: sessionMeta?.title_data ?? {},
            saved: true,
          }),
        })
      } catch (err) {
        /* non-blocking */
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save editor session')
    } finally {
      setSaving(false)
    }
  }, [sessionMeta, activeSessionId, lines, onSaveComplete, onSessionChange])

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
          body: formData,
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to import transcript')
        }
        const data: EditorSessionResponse = await response.json()
        setSessionMeta(data)
        setLines(data.lines || [])
        setHistory([])
        setFuture([])
        setIsDirty(false)
        setActiveLineId(null)
        setSelectedLineId(null)
        setEditingField(null)
        activeLineMarker.current = null
        if (data.session_id) {
          setActiveSessionId(data.session_id)
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

  const docxData = docxBase64 ?? sessionMeta?.docx_base64 ?? ''
  const xmlData = xmlBase64 ?? sessionMeta?.oncue_xml_base64 ?? ''
  const transcriptText = sessionMeta?.transcript ?? ''

  const sessionInfo = sessionMeta?.title_data ?? {}
  const expiresLabel = sessionMeta?.expires_at ? new Date(sessionMeta.expires_at).toLocaleString() : '—'
  const updatedLabel = sessionMeta?.updated_at ? new Date(sessionMeta.updated_at).toLocaleString() : '—'

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="card-header flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-medium">Manual Sync Editor</h2>
            {sessionMeta?.session_id && (
              <p className="text-sm text-primary-100">Session: {sessionMeta.session_id}</p>
            )}
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
            <div className="flex items-center gap-2">
              <button
                className="rounded-lg border-2 border-primary-200 bg-white px-3 py-2 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-400 hover:bg-primary-50"
                onClick={() => {
                  setShowSnapshots(true)
                  loadSnapshots()
                }}
                title="View autosaved snapshots from the last two weeks"
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

          {showSnapshots && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <div className="w-full max-w-5xl rounded-lg bg-white p-5 shadow-2xl">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-primary-900">Autosave History</h3>
                    <p className="text-xs text-primary-600">Grouped by transcript (media). Snapshots from the past 14 days.</p>
                  </div>
                  <button
                    className="rounded border border-primary-300 px-2 py-1 text-sm text-primary-700 hover:bg-primary-100"
                    onClick={() => setShowSnapshots(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-[220px_1fr] gap-4">
                  <div className="max-h-80 overflow-y-auto rounded border border-primary-100">
                    {loadingSnapshots ? (
                      <div className="p-4 text-sm text-primary-600">Loading transcripts…</div>
                    ) : (
                      <ul>
                        {Object.entries(
                          snapshots.reduce((acc: Record<string, string>, snap) => {
                            const key = snap.display_media_key || snap.media_key || 'unknown'
                            if (!acc[key]) {
                              const label = snap.title_label || key
                              acc[key] = label
                            }
                            return acc
                          }, {} as Record<string, string>),
                        ).map(([key, label]) => (
                          <li
                            key={key}
                            className={`cursor-pointer px-4 py-2 text-sm ${selectedMediaKey === key ? 'bg-primary-100 font-semibold' : ''}`}
                            onClick={() => setSelectedMediaKey(key)}
                          >
                            <div className="text-primary-900">{label || key}</div>
                            <div className="text-[11px] text-primary-500">{key}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto rounded border border-primary-100">
                    {loadingSnapshots ? (
                      <div className="p-4 text-sm text-primary-600">Loading snapshots…</div>
                    ) : (
                      <ul>
                        {snapshots
                          .filter((snap) =>
                            selectedMediaKey
                              ? (snap.display_media_key || snap.media_key || 'unknown') === selectedMediaKey
                              : true,
                          )
                          .map((snap) => (
                            <li
                              key={`${snap.media_key || 'current'}-${snap.snapshot_id}`}
                              className="flex items-center justify-between border-b border-primary-100 px-4 py-2 text-sm"
                            >
                              <div>
                                <div className="font-semibold text-primary-900">
                                  {new Date(snap.created_at).toLocaleString()}
                                </div>
                                <div className="text-xs text-primary-600">
                                  {(snap.title_label || snap.display_media_key || snap.media_key || 'Transcript')} • {snap.saved ? 'Saved' : 'Autosave'}
                                </div>
                              </div>
                              <button
                                className="rounded border border-primary-300 px-3 py-1 text-xs font-semibold text-primary-800 hover:bg-primary-100"
                                onClick={() => handleRestoreSnapshot(snap.snapshot_id, snap.media_key || selectedMediaKey)}
                              >
                                Restore
                              </button>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
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
    </div>
  )
}
