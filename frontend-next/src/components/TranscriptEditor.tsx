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

export interface EditorSessionResponse {
  session_id?: string | null
  title_data: Record<string, string>
  audio_duration: number
  lines_per_page: number
  include_timestamps: boolean
  lines: EditorLine[]
  created_at?: string
  updated_at?: string
  expires_at?: string
  docx_base64?: string | null
  oncue_xml_base64?: string | null
  transcript?: string | null
  media_blob_name?: string | null
  media_content_type?: string | null
}

export type EditorSaveResponse = EditorSessionResponse

interface TranscriptEditorProps {
  sessionId?: string | null
  mediaUrl?: string
  mediaType?: string
  includeTimestamps: boolean
  docxBase64?: string | null
  xmlBase64?: string | null
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
  onSessionChange: (session: EditorSessionResponse) => void
  onSaveComplete: (result: EditorSaveResponse) => void
  onIncludeTimestampsChange: (value: boolean) => void
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

export default function TranscriptEditor({
  sessionId,
  mediaUrl,
  mediaType,
  includeTimestamps,
  docxBase64,
  xmlBase64,
  onDownload,
  buildFilename,
  onSessionChange,
  onSaveComplete,
  onIncludeTimestampsChange,
}: TranscriptEditorProps) {
  const [lines, setLines] = useState<EditorLine[]>([])
  const [sessionMeta, setSessionMeta] = useState<EditorSessionResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [localIncludeTimestamps, setLocalIncludeTimestamps] = useState(includeTimestamps)
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
  const [importIncludeTimestamps, setImportIncludeTimestamps] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const effectiveMediaUrl = useMemo(() => {
    if (mediaUrl) return mediaUrl
    if (sessionMeta?.media_blob_name) {
      return `/api/media/${sessionMeta.media_blob_name}`
    }
    return undefined
  }, [mediaUrl, sessionMeta])

  const effectiveMediaType = useMemo(
    () => mediaType ?? sessionMeta?.media_content_type ?? undefined,
    [mediaType, sessionMeta],
  )

  const isVideo = useMemo(
    () => (effectiveMediaType ?? '').startsWith('video/'),
    [effectiveMediaType],
  )

  useEffect(() => {
    setLocalIncludeTimestamps(includeTimestamps)
  }, [includeTimestamps])

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
          if (!id && response.status === 404) {
            setSessionMeta(null)
            setLines([])
            return
          }
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to load transcript session')
        }
        const data: EditorSessionResponse = await response.json()
        setSessionMeta(data)
        setLines(data.lines || [])
        setLocalIncludeTimestamps(data.include_timestamps ?? includeTimestamps)
        setIsDirty(false)
        setActiveLineId(null)
        setSelectedLineId(null)
        setEditingField(null)
        activeLineMarker.current = null
        onIncludeTimestampsChange(data.include_timestamps ?? includeTimestamps)
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
    [includeTimestamps, onIncludeTimestampsChange, onSessionChange],
  )

  useEffect(() => {
    if (sessionId && sessionId !== activeSessionId) {
      setActiveSessionId(sessionId)
    }
  }, [sessionId, activeSessionId])

  useEffect(() => {
    const idToFetch = activeSessionId ?? undefined
    if (lastFetchedId.current === idToFetch) {
      return
    }
    lastFetchedId.current = idToFetch
    fetchSession(idToFetch)
  }, [activeSessionId, fetchSession])

  useEffect(() => {
    if (!editingField) return
    if (editInputRef.current) {
      editInputRef.current.focus()
      if (editingField.field === 'speaker' && 'select' in editInputRef.current) {
        ;(editInputRef.current as HTMLInputElement).select()
      }
    }
  }, [editingField])

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

  const handleIncludeToggle = useCallback(
    (checked: boolean) => {
      setLocalIncludeTimestamps(checked)
      onIncludeTimestampsChange(checked)
      setIsDirty(true)
    },
    [onIncludeTimestampsChange],
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

  const beginEdit = useCallback((line: EditorLine, field: 'speaker' | 'text') => {
    setEditingField({
      lineId: line.id,
      field,
      value: field === 'speaker' ? line.speaker : line.text,
    })
  }, [])

  const commitEdit = useCallback(() => {
    if (!editingField) return
    handleLineFieldChange(editingField.lineId, editingField.field, editingField.value)
    setEditingField(null)
  }, [editingField, handleLineFieldChange])

  const cancelEdit = useCallback(() => {
    setEditingField(null)
  }, [])

  const handleSave = useCallback(async () => {
    const targetSessionId = sessionMeta?.session_id ?? activeSessionId
    if (!targetSessionId) {
      setError('No transcript session available to save.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/transcripts/${targetSessionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lines,
          include_timestamps: localIncludeTimestamps,
          title_data: sessionMeta?.title_data ?? {},
          media_blob_name: sessionMeta?.media_blob_name ?? null,
          media_content_type: sessionMeta?.media_content_type ?? null,
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to save editor session')
      }
      const data: EditorSaveResponse = await response.json()
      setSessionMeta(data)
      setLines(data.lines || [])
      setLocalIncludeTimestamps(data.include_timestamps ?? localIncludeTimestamps)
      setIsDirty(false)
      setActiveLineId(null)
      setSelectedLineId(null)
      setEditingField(null)
      activeLineMarker.current = null

      onIncludeTimestampsChange(data.include_timestamps ?? localIncludeTimestamps)
      onSaveComplete(data)
      onSessionChange(data)
    } catch (err: any) {
      setError(err.message || 'Failed to save editor session')
    } finally {
      setSaving(false)
    }
  }, [sessionMeta, activeSessionId, lines, localIncludeTimestamps, onIncludeTimestampsChange, onSaveComplete, onSessionChange])

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
        formData.append('include_timestamps', importIncludeTimestamps ? 'on' : '')

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
        setLocalIncludeTimestamps(data.include_timestamps ?? true)
        setIsDirty(false)
        setActiveLineId(null)
        setSelectedLineId(null)
        setEditingField(null)
        activeLineMarker.current = null
        if (data.session_id) {
          setActiveSessionId(data.session_id)
        }
        onIncludeTimestampsChange(data.include_timestamps ?? true)
        onSessionChange(data)
        setImportXmlFile(null)
        setImportMediaFile(null)
      } catch (err: any) {
        setImportError(err.message || 'Failed to import transcript')
      } finally {
        setImporting(false)
      }
    },
    [importXmlFile, importMediaFile, importIncludeTimestamps, onIncludeTimestampsChange, onSessionChange],
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
                checked={localIncludeTimestamps}
                onChange={(event) => handleIncludeToggle(event.target.checked)}
              />
              Include timestamps in DOCX
            </label>
            <label className="flex items-center gap-2 text-sm text-white">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
              />
              Auto-scroll
            </label>
            <button className="btn-primary px-4 py-2" onClick={handleSave} disabled={saving || !sessionMeta || !isDirty}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
        <div className="card-body space-y-6">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="space-y-4">
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

              {mediaUrl ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-primary-900">Media Preview</p>
                  {isVideo ? (
                    <video ref={videoRef} controls className="w-full rounded-lg border border-primary-200 shadow" src={mediaUrl} />
                  ) : (
                    <audio ref={audioRef} controls className="w-full" src={mediaUrl} />
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-primary-300 p-4 text-sm text-primary-500">
                  Upload media to enable playback controls.
                </div>
              )}

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
                      onChange={(event) => setImportMediaFile(event.target.files?.[0] ?? null)}
                      className="mt-1 w-full text-xs text-primary-700 file:mr-3 file:rounded file:border-0 file:bg-primary-100 file:px-3 file:py-1 file:text-primary-800"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-primary-700">
                    <input
                      type="checkbox"
                      checked={importIncludeTimestamps}
                      onChange={(event) => setImportIncludeTimestamps(event.target.checked)}
                    />
                    Include timestamps on import
                  </label>
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
                <div className="grid grid-cols-[90px_170px_minmax(0,1fr)_220px] border-b border-primary-200 bg-primary-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-primary-600">
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
                        'grid grid-cols-[90px_170px_minmax(0,1fr)_220px] items-center gap-3 border-b border-primary-100 px-4 py-2 text-sm',
                        isActive ? 'bg-yellow-100' : 'bg-white hover:bg-primary-50',
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
                            className="min-w-0 cursor-pointer truncate text-primary-900"
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
                            className="min-w-0 cursor-text whitespace-pre-wrap text-primary-800"
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
                          <div className="flex items-center justify-end gap-4 text-xs text-primary-600">
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
