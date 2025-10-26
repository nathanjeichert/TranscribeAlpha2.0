'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface EditorLine {
  id: string
  speaker: string
  text: string
  start: number
  end: number
  page?: number
  line?: number
  pgln?: number
  is_continuation?: boolean
}

interface EditorSessionResponse {
  session_id: string
  title_data: Record<string, string>
  audio_duration: number
  lines_per_page: number
  include_timestamps: boolean
  lines: EditorLine[]
  created_at?: string
  expires_at?: string
}

interface EditorSaveResponse {
  session_id: string
  lines: EditorLine[]
  docx_base64: string
  oncue_xml_base64: string
  transcript: string
  title_data: Record<string, string>
  include_timestamps: boolean
  audio_duration: number
  updated_at?: string
  expires_at?: string
}

interface TranscriptEditorProps {
  sessionId: string
  mediaUrl?: string
  mediaType?: string
  includeTimestamps: boolean
  docxBase64?: string
  xmlBase64?: string
  onDownload: (base64Data: string, filename: string, mimeType: string) => void
  buildFilename: (baseName: string, extension: string) => string
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
  onSaveComplete,
  onIncludeTimestampsChange,
}: TranscriptEditorProps) {
  const [lines, setLines] = useState<EditorLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<EditorSessionResponse | null>(null)
  const [localIncludeTimestamps, setLocalIncludeTimestamps] = useState(includeTimestamps)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const isVideo = useMemo(() => mediaType?.startsWith('video/'), [mediaType])

  useEffect(() => {
    setLocalIncludeTimestamps(includeTimestamps)
  }, [includeTimestamps])

  useEffect(() => {
    const controller = new AbortController()
    const fetchSession = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(`/api/transcripts/${sessionId}`, {
          signal: controller.signal,
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Unable to load transcript session')
        }
        const data: EditorSessionResponse = await response.json()
        setSessionMeta(data)
        setLines(data.lines || [])
        setLocalIncludeTimestamps(data.include_timestamps)
        setIsDirty(false)
      } catch (err: any) {
        if (err.name === 'AbortError') return
        setError(err.message || 'Failed to load editor session')
      } finally {
        setLoading(false)
      }
    }

    fetchSession()

    return () => controller.abort()
  }, [sessionId])

  const duration = sessionMeta?.audio_duration || 0

  const handleLineFieldChange = useCallback(
    (lineId: string, field: keyof EditorLine, value: string | number) => {
      setLines((prev) =>
        prev.map((line) =>
          line.id === lineId
            ? {
                ...line,
                [field]:
                  field === 'speaker' || field === 'text'
                    ? (value as string)
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

  const nudgeLineTime = useCallback(
    (lineId: string, field: 'start' | 'end', delta: number) => {
      setLines((prev) =>
        prev.map((line) =>
          line.id === lineId
            ? {
                ...line,
                [field]: Math.max(0, +(line[field] + delta).toFixed(3)),
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
      setSelectedLineId(line.id)
      const player = isVideo ? videoRef.current : audioRef.current
      if (!player) return
      player.currentTime = line.start
      player.play().catch(() => {
        /* Autoplay prevented */
      })
    },
    [isVideo],
  )

  const handleSave = useCallback(async () => {
    if (!sessionMeta) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/transcripts/${sessionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lines,
          include_timestamps: localIncludeTimestamps,
          title_data: sessionMeta.title_data || {},
        }),
      })

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to save editor session')
      }

      const data: EditorSaveResponse = await response.json()
      setLines(data.lines || [])
      setSessionMeta((prev) =>
        prev
          ? {
              ...prev,
              lines: data.lines || [],
              include_timestamps: data.include_timestamps,
              audio_duration: data.audio_duration,
              title_data: data.title_data,
            }
          : null,
      )
      setLocalIncludeTimestamps(data.include_timestamps)
      onIncludeTimestampsChange(data.include_timestamps)
      onSaveComplete(data)
      setIsDirty(false)
    } catch (err: any) {
      setError(err.message || 'Failed to save changes')
    } finally {
      setSaving(false)
    }
  }, [sessionId, lines, localIncludeTimestamps, sessionMeta, onIncludeTimestampsChange, onSaveComplete])

  if (loading) {
    return (
      <div className="card animate-pulse">
        <div className="card-body text-primary-700">Loading editor...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card border border-red-200 bg-red-50">
        <div className="card-body text-red-700">
          <p className="font-medium mb-2">Unable to load editor</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    )
  }

  if (!sessionMeta) {
    return (
      <div className="card">
        <div className="card-body">Editor session unavailable.</div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="card">
        <div className="card-header flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <h2 className="text-xl font-medium">Manual Sync Editor</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={localIncludeTimestamps}
                onChange={(event) => handleIncludeToggle(event.target.checked)}
                className="h-4 w-4"
              />
              Include timestamps in DOCX transcript
            </label>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving || !isDirty}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
        <div className="card-body space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-primary-100 rounded-lg p-4 shadow-inner">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-primary-700">
                  <div>
                    <dt className="font-medium text-primary-900">Session ID</dt>
                    <dd className="truncate">{sessionMeta.session_id}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-primary-900">Lines</dt>
                    <dd>{lines.length}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-primary-900">Duration</dt>
                    <dd>{secondsToLabel(duration)}</dd>
                  </div>
                  {sessionMeta.expires_at && (
                    <div>
                      <dt className="font-medium text-primary-900">Expires</dt>
                      <dd>{new Date(sessionMeta.expires_at).toLocaleString()}</dd>
                    </div>
                  )}
                </dl>
              </div>
              {mediaUrl && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-primary-900">Preview</p>
                  {isVideo ? (
                    <video ref={videoRef} controls className="w-full rounded-lg shadow" src={mediaUrl} />
                  ) : (
                    <audio ref={audioRef} controls className="w-full" src={mediaUrl} />
                  )}
                </div>
              )}
              <div className="bg-primary-50 border border-primary-200 rounded-lg p-4 text-sm text-primary-700">
                Adjust start/end times to re-sync individual lines. Use the quick nudge buttons for
                fine-grained tweaks or jump the media preview directly to a line with the play
                controls.
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-primary-900">Downloads</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn-outline"
                    onClick={() => docxBase64 && onDownload(docxBase64, buildFilename('Transcript-Edited', '.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}
                    disabled={!docxBase64}
                  >
                    Download DOCX
                  </button>
                  <button
                    className="btn-outline"
                    onClick={() => xmlBase64 && onDownload(xmlBase64, buildFilename('Transcript-Edited', '.xml'), 'application/xml')}
                    disabled={!xmlBase64}
                  >
                    Download OnCue XML
                  </button>
                </div>
                <p className="text-xs text-primary-500">
                  Downloads reflect the most recent saved changes.
                </p>
              </div>
            </div>

            <div className="lg:col-span-3 space-y-4">
              {lines.length === 0 ? (
                <div className="border border-dashed border-primary-200 rounded-lg p-6 text-center text-primary-500">
                  No lines available for editing.
                </div>
              ) : (
                <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
                  {lines.map((line) => {
                    const startPercent = duration ? Math.min(100, Math.max(0, (line.start / duration) * 100)) : 0
                    const endPercent = duration ? Math.min(100, Math.max(startPercent, (line.end / duration) * 100)) : 0
                    const isSelected = selectedLineId === line.id
                    return (
                      <div
                        key={line.id}
                        className={`border rounded-lg p-4 shadow-sm bg-white space-y-3 ${
                          isSelected ? 'border-primary-400 ring-2 ring-primary-200' : 'border-primary-100'
                        }`}
                      >
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <input
                              value={line.speaker}
                              onChange={(e) => handleLineFieldChange(line.id, 'speaker', e.target.value)}
                              className="input w-44"
                              placeholder="Speaker"
                            />
                            <span className="text-xs text-primary-400 uppercase tracking-wide">
                              Pg {line.page ?? '–'} · Ln {line.line ?? '–'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              className="btn-outline text-xs"
                              onClick={() => nudgeLineTime(line.id, 'start', -0.1)}
                            >
                              Start -0.1s
                            </button>
                            <button
                              className="btn-outline text-xs"
                              onClick={() => nudgeLineTime(line.id, 'start', 0.1)}
                            >
                              Start +0.1s
                            </button>
                            <button
                              className="btn-outline text-xs"
                              onClick={() => nudgeLineTime(line.id, 'end', -0.1)}
                            >
                              End -0.1s
                            </button>
                            <button
                              className="btn-outline text-xs"
                              onClick={() => nudgeLineTime(line.id, 'end', 0.1)}
                            >
                              End +0.1s
                            </button>
                            <button className="btn-primary text-xs" onClick={() => playLine(line)}>
                              Play
                            </button>
                          </div>
                        </div>

                        <textarea
                          value={line.text}
                          onChange={(e) => handleLineFieldChange(line.id, 'text', e.target.value)}
                          className="textarea w-full"
                          rows={3}
                        />

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
                          <label className="flex flex-col text-sm text-primary-700">
                            <span className="font-medium text-primary-900">Start (seconds)</span>
                            <input
                              type="number"
                              step="0.01"
                              value={line.start}
                              onChange={(e) => handleLineFieldChange(line.id, 'start', parseFloat(e.target.value))}
                              className="input"
                              min={0}
                            />
                          </label>
                          <label className="flex flex-col text-sm text-primary-700">
                            <span className="font-medium text-primary-900">End (seconds)</span>
                            <input
                              type="number"
                              step="0.01"
                              value={line.end}
                              onChange={(e) => handleLineFieldChange(line.id, 'end', parseFloat(e.target.value))}
                              className="input"
                              min={0}
                            />
                          </label>
                          <div className="col-span-1 md:col-span-2">
                            <div className="flex justify-between text-xs text-primary-500 mb-1">
                              <span>{secondsToLabel(line.start)}</span>
                              <span>{secondsToLabel(line.end)}</span>
                            </div>
                            <div className="relative h-2 bg-primary-100 rounded-full">
                              <div
                                className="absolute h-2 bg-primary-500 rounded-full"
                                style={{
                                  left: `${startPercent}%`,
                                  width: `${Math.max(endPercent - startPercent, 1)}%`,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


export type { EditorSaveResponse }
