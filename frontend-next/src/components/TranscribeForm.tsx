'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import TranscriptEditor, { EditorSaveResponse, EditorSessionResponse } from '@/components/TranscriptEditor'
import ClipCreator from '@/components/ClipCreator'

interface FormData {
  case_name: string
  case_number: string
  firm_name: string
  input_date: string
  input_time: string
  location: string
  speaker_names: string
}

type TranscriptData = EditorSessionResponse & {
  transcript?: string | null
  transcript_text?: string | null
}

interface TranscriptListItem {
  media_key: string
  title_label: string
  updated_at?: string | null
  line_count?: number
}

type AppTab = 'transcribe' | 'editor' | 'clip' | 'history'

export default function TranscribeForm() {
  const [formData, setFormData] = useState<FormData>({
    case_name: '',
    case_number: '',
    firm_name: '',
    input_date: '',
    input_time: '',
    location: '',
    speaker_names: '',
  })

  const [activeTab, setActiveTab] = useState<AppTab>('transcribe')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [mediaKey, setMediaKey] = useState<string | null>(null)
  const [transcriptData, setTranscriptData] = useState<TranscriptData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string>('')
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>('')
  const [mediaContentType, setMediaContentType] = useState<string | undefined>(undefined)
  const [mediaIsLocal, setMediaIsLocal] = useState(false)
  const [showHistoryList, setShowHistoryList] = useState(false)
  const [historyItems, setHistoryItems] = useState<TranscriptListItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [geminiBusy, setGeminiBusy] = useState(false)
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const [useGeminiPolish, setUseGeminiPolish] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const updateMediaPreview = useCallback(
    (blobName?: string | null, contentType?: string | null) => {
      if (!blobName) return
      if (mediaPreviewUrl && mediaIsLocal) {
        URL.revokeObjectURL(mediaPreviewUrl)
      }
      setMediaPreviewUrl(`/api/media/${blobName}`)
      setMediaContentType(contentType ?? undefined)
      setMediaIsLocal(false)
    },
    [mediaIsLocal, mediaPreviewUrl],
  )

  const hydrateTranscript = useCallback(
    (data: TranscriptData) => {
      setTranscriptData((previous) => {
        const merged: TranscriptData = {
          ...(previous ?? {}),
          ...data,
          docx_base64: data.docx_base64 ?? previous?.docx_base64,
          oncue_xml_base64: data.oncue_xml_base64 ?? previous?.oncue_xml_base64,
          media_blob_name: data.media_blob_name ?? previous?.media_blob_name,
          media_content_type: data.media_content_type ?? previous?.media_content_type,
          audio_duration: data.audio_duration ?? previous?.audio_duration ?? 0,
          lines_per_page: data.lines_per_page ?? previous?.lines_per_page ?? 25,
          title_data: data.title_data ?? previous?.title_data ?? {},
          lines: data.lines ?? previous?.lines ?? [],
          clips: data.clips ?? previous?.clips ?? [],
          transcript: data.transcript ?? data.transcript_text ?? previous?.transcript ?? previous?.transcript_text ?? null,
          transcript_text: data.transcript_text ?? data.transcript ?? previous?.transcript_text ?? previous?.transcript ?? null,
        }
        return merged
      })

      const resolvedKey = data.media_key ?? data.title_data?.MEDIA_ID ?? null
      setMediaKey(resolvedKey ?? null)
      setError('')

      if (data.media_blob_name) {
        updateMediaPreview(data.media_blob_name, data.media_content_type ?? undefined)
      }
    },
    [updateMediaPreview],
  )

  useEffect(() => {
    return () => {
      if (mediaPreviewUrl && mediaIsLocal) {
        URL.revokeObjectURL(mediaPreviewUrl)
      }
    }
  }, [mediaPreviewUrl, mediaIsLocal])

  const handleSessionChange = useCallback(
    (session: EditorSessionResponse) => {
      hydrateTranscript(session as TranscriptData)
    },
    [hydrateTranscript],
  )

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = event.target
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? (event.target as HTMLInputElement).checked : value,
    }))
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (mediaPreviewUrl && mediaIsLocal) {
      URL.revokeObjectURL(mediaPreviewUrl)
    }

    setSelectedFile(file)
    setError('')
    setTranscriptData(null)
    setMediaKey(null)
    setActiveTab('transcribe')

    const previewUrl = URL.createObjectURL(file)
    setMediaPreviewUrl(previewUrl)
    setMediaContentType(file.type)
    setMediaIsLocal(true)
  }

  const fetchTranscriptByKey = useCallback(
    async (key: string) => {
      try {
        const response = await fetch(`/api/transcripts/by-key/${encodeURIComponent(key)}`)
        if (!response.ok) {
          if (response.status === 404) {
            try {
              localStorage.removeItem('active_media_key')
            } catch {
              /* ignore */
            }
          }
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to load transcript')
        }
        const data: TranscriptData = await response.json()
        hydrateTranscript(data)
        return data
      } catch (err: any) {
        throw new Error(err?.message || 'Failed to load transcript')
      }
    },
    [hydrateTranscript],
  )

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const response = await fetch('/api/transcripts')
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to load sessions')
      }
      const payload = await response.json()
      setHistoryItems(payload.transcripts || [])
    } catch (err: any) {
      setHistoryError(err?.message || 'Failed to load sessions')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const handleSelectHistoryItem = useCallback(
    async (key: string) => {
      setHistoryError(null)
      try {
        await fetchTranscriptByKey(key)
        setActiveTab('editor')
        setShowHistoryList(false)
      } catch (err: any) {
        setHistoryError(err?.message || 'Failed to restore session')
      }
    },
    [fetchTranscriptByKey],
  )

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!selectedFile) {
      setError('Please select a file to transcribe')
      return
    }

    setIsLoading(true)
    setProgress(0)
    setError('')
    setTranscriptData(null)
    setMediaKey(null)

    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 90) return prev
        return prev + Math.random() * 15
      })
    }, 500)

    try {
      const submitFormData = new FormData()
      submitFormData.append('file', selectedFile)
      Object.entries(formData).forEach(([key, value]) => {
        submitFormData.append(key, value.toString())
      })

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: submitFormData,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown error occurred' }))
        throw new Error(errorData.detail || 'Transcription failed')
      }

      const data: TranscriptData = await response.json()
      hydrateTranscript(data)
      setProgress(100)

      if (useGeminiPolish && (data.media_key ?? mediaKey)) {
        await handleGeminiRefine()
      }
    } catch (err: any) {
      console.error('Transcription error:', err)
      setError(err.message || 'Transcription failed')
    } finally {
      clearInterval(progressInterval)
      setIsLoading(false)
    }
  }

  const downloadFile = (base64Data: string, filename: string, mimeType: string) => {
    const byteCharacters = atob(base64Data)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    const byteArray = new Uint8Array(byteNumbers)
    const blob = new Blob([byteArray], { type: mimeType })

    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
  }

  const generateFilename = (baseName: string, extension: string) => {
    let filename = ''

    if (formData.case_name.trim()) {
      const sanitizedCase = formData.case_name
        .trim()
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')

      if (sanitizedCase) {
        filename += sanitizedCase + '-'
      }
    }

    filename += baseName

    if (formData.input_date) {
      filename += '-' + formData.input_date
    }

    return filename + extension
  }

  const handleEditorSave = (data: EditorSaveResponse) => {
    hydrateTranscript(data as TranscriptData)
  }

  const handleGeminiRefine = useCallback(async () => {
    if (!mediaKey) {
      setGeminiError('No transcript available for Gemini.')
      return
    }
    setGeminiBusy(true)
    setGeminiError(null)
    try {
      const response = await fetch(`/api/transcripts/by-key/${encodeURIComponent(mediaKey)}/gemini-refine`, {
        method: 'POST',
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Gemini refinement failed')
      }
      const data: TranscriptData = await response.json()
      hydrateTranscript(data)
      setActiveTab('editor')
    } catch (err: any) {
      setGeminiError(err.message || 'Gemini refinement failed')
    } finally {
      setGeminiBusy(false)
    }
  }, [mediaKey, hydrateTranscript])

  const tabClasses = (tab: AppTab) =>
    `px-4 py-2 rounded-lg font-medium transition ${activeTab === tab
      ? 'bg-primary-900 text-white shadow-lg'
      : 'bg-primary-100 text-primary-600 hover:bg-primary-200'
    }`

  const resolvedTranscriptText = transcriptData?.transcript ?? transcriptData?.transcript_text ?? ''
  const transcriptSegments = resolvedTranscriptText.split('\n\n').filter((segment) => segment.trim()).length ?? 0

  const previewContentType = mediaContentType ?? selectedFile?.type ?? ''
  const isVideoPreview = previewContentType.startsWith('video/')
  const clipMediaUrl =
    (mediaIsLocal && mediaPreviewUrl) ||
    (transcriptData?.media_blob_name ? `/api/media/${transcriptData.media_blob_name}` : mediaPreviewUrl || undefined)
  const clipMediaType =
    (mediaIsLocal ? mediaContentType ?? selectedFile?.type : undefined) ??
    transcriptData?.media_content_type ??
    mediaContentType ??
    selectedFile?.type

  useEffect(() => {
    const storedKey = typeof window !== 'undefined' ? localStorage.getItem('active_media_key') : null
    if (storedKey) {
      fetchTranscriptByKey(storedKey)
        .then(() => setActiveTab('editor'))
        .catch(() => {
          try {
            localStorage.removeItem('active_media_key')
          } catch {
            /* ignore */
          }
        })
    }
  }, [fetchTranscriptByKey])

  useEffect(() => {
    const key = transcriptData?.media_key ?? mediaKey
    try {
      if (key) {
        localStorage.setItem('active_media_key', key)
      } else {
        localStorage.removeItem('active_media_key')
      }
    } catch {
      /* ignore */
    }
  }, [transcriptData?.media_key, mediaKey])

  useEffect(() => {
    if (activeTab === 'history' && showHistoryList) {
      fetchHistory()
    }
  }, [activeTab, showHistoryList, fetchHistory])

  return (
    <div className="min-h-screen bg-primary-50">
      <div className="max-w-screen-2xl mx-auto px-6 py-12">
        <div className="text-center mb-12">
          <div className="bg-gradient-to-r from-primary-900 to-primary-700 text-white rounded-2xl p-8 shadow-2xl">
            <h1 className="text-4xl font-light mb-4">TranscribeAlpha</h1>
            <p className="text-lg text-primary-100">Professional Legal Transcript Generator</p>
          </div>
        </div>

        <div className="flex justify-center mb-10 gap-4">
          <button className={tabClasses('transcribe')} onClick={() => setActiveTab('transcribe')}>
            Transcription
          </button>
          <button className={tabClasses('history')} onClick={() => { setActiveTab('history'); setShowHistoryList(true) }}>
            Sessions
          </button>
          <button className={tabClasses('editor')} onClick={() => setActiveTab('editor')}>
            Editor
          </button>
          <button className={tabClasses('clip')} onClick={() => setActiveTab('clip')}>
            Clip Creator
          </button>
        </div>

        {activeTab === 'transcribe' && (
          <div className="space-y-8">
            {mediaKey && (
              <div className="card border border-amber-300 bg-amber-50/50">
                <div className="card-body flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-amber-900">Experimental: Gemini Polish</p>
                    <p className="text-xs text-amber-800">
                      Refine the current transcript using Gemini 3.0 Pro Preview to correct words, punctuation, speakers, and timing.
                    </p>
                    {geminiError && <p className="text-xs text-red-700 mt-1">{geminiError}</p>}
                  </div>
                  <button
                    className="rounded-lg border-2 border-amber-400 bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-900 shadow-sm hover:bg-amber-200 disabled:opacity-60"
                    onClick={handleGeminiRefine}
                    disabled={geminiBusy}
                  >
                    {geminiBusy ? 'Running Gemini...' : 'Run Gemini Polish'}
                  </button>
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-8">
              <div className="card">
                <div className="card-header">
                  <h2 className="text-xl font-medium">Media Upload</h2>
                </div>
                <div className="card-body">
                  <div
                    className="border-2 border-dashed border-primary-300 rounded-lg p-8 text-center hover:border-primary-500 hover:bg-primary-100 transition-all duration-200 cursor-pointer bg-primary-50"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      accept="audio/*,video/*,.mp4,.avi,.mov,.mkv,.wav,.mp3,.m4a,.flac,.ogg"
                      className="hidden"
                    />
                    {selectedFile ? (
                      <div className="space-y-2">
                        <div className="text-2xl text-green-500">✅</div>
                        <div className="font-medium text-primary-900">{selectedFile.name}</div>
                        <div className="text-sm text-primary-600">
                          {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                        </div>
                        <div className="text-sm text-green-600">File selected successfully</div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="text-4xl text-primary-400">📁</div>
                        <div className="font-medium text-primary-900">Click to select audio or video file</div>
                        <div className="text-sm text-primary-600">
                          Supports MP4, AVI, MOV, WAV, MP3, FLAC and more
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <h2 className="text-xl font-medium">Case Information</h2>
                </div>
                <div className="card-body">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-2">
                        Case Name
                      </label>
                      <input
                        type="text"
                        name="case_name"
                        value={formData.case_name}
                        onChange={handleInputChange}
                        className="input-field"
                        placeholder="e.g., Smith vs. Johnson"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-2">
                        Case Number
                      </label>
                      <input
                        type="text"
                        name="case_number"
                        value={formData.case_number}
                        onChange={handleInputChange}
                        className="input-field"
                        placeholder="e.g., CV-2023-001234"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-primary-700 mb-2">
                        Firm/Organization Name
                      </label>
                      <input
                        type="text"
                        name="firm_name"
                        value={formData.firm_name}
                        onChange={handleInputChange}
                        className="input-field"
                        placeholder="e.g., Legal Associates LLC"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-2">Date</label>
                      <input
                        type="date"
                        name="input_date"
                        value={formData.input_date}
                        onChange={handleInputChange}
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-primary-700 mb-2">Time</label>
                      <input
                        type="time"
                        name="input_time"
                        value={formData.input_time}
                        onChange={handleInputChange}
                        className="input-field"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-primary-700 mb-2">Location</label>
                      <input
                        type="text"
                        name="location"
                        value={formData.location}
                        onChange={handleInputChange}
                        className="input-field"
                        placeholder="e.g., Conference Room A, 123 Main St, City, State"
                      />
                    </div>
                    <div className="md:col-span-2 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                      <input
                        id="useGeminiPolish"
                        type="checkbox"
                        checked={useGeminiPolish}
                        onChange={(event) => setUseGeminiPolish(event.target.checked)}
                        className="h-4 w-4 accent-amber-500"
                      />
                      <label htmlFor="useGeminiPolish" className="text-sm text-amber-900">
                        Experimental: Run Gemini 3.0 Pro Preview after transcription to polish wording, speakers, and timing.
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <h2 className="text-xl font-medium">Transcription Settings</h2>
                </div>
                <div className="card-body space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-primary-700 mb-2">
                      Speaker Names (optional)
                    </label>
                    <input
                      type="text"
                      name="speaker_names"
                      value={formData.speaker_names}
                      onChange={handleInputChange}
                      className="input-field"
                      placeholder="e.g., John Smith, Jane Doe, Attorney Williams"
                    />
                    <p className="text-xs text-primary-600 mt-1">
                      Separate multiple speakers with commas. Leave blank for automatic detection.
                    </p>
                  </div>
                  <div className="bg-primary-50 border border-primary-200 rounded-lg p-4">
                    <div className="text-sm text-primary-700">
                      Transcriptions are processed with <span className="font-medium">AssemblyAI</span> to provide
                      millisecond-accurate word-level timestamps for OnCue synchronization.
                    </div>
                  </div>
                </div>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-300 rounded-lg p-4 shadow-sm text-red-800 font-medium">
                  {error}
                </div>
              )}

              <div className="flex justify-center">
                <button
                  type="submit"
                  disabled={!selectedFile || isLoading}
                  className="btn-primary text-lg px-12 py-4"
                >
                  {isLoading ? `Processing... ${progress.toFixed(0)}%` : 'Generate Transcript'}
                </button>
              </div>

              {isLoading && (
                <div className="w-full bg-primary-200 rounded-full h-3 shadow-inner">
                  <div
                    className="bg-gradient-to-r from-primary-600 to-primary-500 h-3 rounded-full transition-all duration-300 shadow-sm"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </form>

            {transcriptData && (
              <div className="space-y-6">
                {mediaPreviewUrl && (
                  <div className="card">
                    <div className="card-header">
                      <h2 className="text-xl font-medium">Media Preview</h2>
                    </div>
                    <div className="card-body">
                      <div className="bg-primary-900 rounded-lg p-4">
                        {isVideoPreview ? (
                          <video src={mediaPreviewUrl} controls className="w-full max-w-2xl mx-auto rounded">
                            Your browser does not support video playback.
                          </video>
                        ) : (
                          <audio src={mediaPreviewUrl} controls className="w-full max-w-2xl mx-auto">
                            Your browser does not support audio playback.
                          </audio>
                        )}
                      </div>
                      <div className="mt-4 text-center text-sm text-primary-600">
                        {selectedFile ? (
                          <>
                            <span className="font-medium">{selectedFile.name}</span> •{' '}
                            {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                          </>
                        ) : (
                          <>
                            <span className="font-medium">Session media</span>{' '}
                            {previewContentType && <>• {previewContentType}</>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="card">
                  <div className="card-header">
                    <h2 className="text-xl font-medium">Generated Files</h2>
                  </div>
                  <div className="card-body space-y-4">
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="text-green-800 font-medium mb-2">✅ Transcription Complete!</div>
                      <div className="text-sm text-green-700">Generated {transcriptSegments} transcript segments</div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <button
                        onClick={() => {
                          if (transcriptData.docx_base64) {
                            downloadFile(
                              transcriptData.docx_base64,
                              generateFilename('transcript', '.docx'),
                              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                            )
                          }
                        }}
                        className="btn-primary text-center py-3"
                        disabled={!transcriptData.docx_base64}
                      >
                        📄 Download DOCX
                      </button>
                      <button
                        onClick={() => {
                          if (transcriptData.oncue_xml_base64) {
                            downloadFile(transcriptData.oncue_xml_base64, generateFilename('transcript', '.xml'), 'application/xml')
                          }
                        }}
                        className="btn-primary text-center py-3"
                        disabled={!transcriptData.oncue_xml_base64}
                      >
                        📋 Download OnCue XML
                      </button>
                    </div>
                    <div className="flex justify-between items-center">
                      <p className="text-sm text-primary-600">
                        Want to tweak speaker timing or wording? Open the editor to re-sync manually.
                      </p>
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => mediaKey && setActiveTab('editor')}
                        disabled={!mediaKey}
                      >
                        Open Editor
                      </button>
                    </div>
                      <div>
                        <h3 className="font-medium text-primary-900 mb-3">Transcript Preview:</h3>
                        <div className="bg-primary-50 rounded-lg p-4 max-h-64 overflow-y-auto">
                          <pre className="whitespace-pre-wrap text-sm text-primary-800 font-mono">
                          {resolvedTranscriptText.substring(0, 1000)}
                          {resolvedTranscriptText.length > 1000 && '...'}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="space-y-6">
            <div className="card">
              <div className="card-header flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-medium">Session History</h2>
                  <p className="text-sm text-primary-100">Resume a saved transcript session by clicking below.</p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    className="btn-outline text-sm"
                    onClick={() => {
                      const next = !showHistoryList
                      setShowHistoryList(next)
                      if (next) fetchHistory()
                    }}
                  >
                    {showHistoryList ? 'Hide Sessions' : 'Show Sessions'}
                  </button>
                  <button className="btn-primary text-sm" onClick={fetchHistory} disabled={historyLoading}>
                    {historyLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
              </div>
              <div className="card-body space-y-4">
                {historyError && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{historyError}</div>}
                {showHistoryList && (
                  <>
                    {historyLoading ? (
                      <div className="text-sm text-primary-700">Loading sessions…</div>
                    ) : historyItems.length === 0 ? (
                      <div className="text-sm text-primary-700">No sessions found yet. Upload media to create one.</div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {historyItems.map((item) => (
                          <button
                            key={item.media_key}
                            className="w-full rounded-lg border border-primary-200 bg-white px-4 py-3 text-left shadow-sm hover:border-primary-400 hover:bg-primary-50"
                            onClick={() => handleSelectHistoryItem(item.media_key)}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-semibold text-primary-900">
                                {item.title_label || 'Untitled transcript'}
                              </div>
                              <div className="text-[11px] text-primary-500">
                                {item.updated_at ? new Date(item.updated_at).toLocaleString() : '—'}
                              </div>
                            </div>
                            <div className="text-xs text-primary-500 mt-1">Key: {item.media_key}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'editor' && (
          <TranscriptEditor
            mediaKey={mediaKey}
            initialData={transcriptData}
            mediaUrl={mediaPreviewUrl || undefined}
            mediaType={mediaContentType ?? selectedFile?.type}
            docxBase64={transcriptData?.docx_base64 ?? undefined}
            xmlBase64={transcriptData?.oncue_xml_base64 ?? undefined}
            onDownload={downloadFile}
            buildFilename={generateFilename}
            onSessionChange={handleSessionChange}
            onSaveComplete={handleEditorSave}
          />
        )}

        {activeTab === 'clip' && (
          <ClipCreator
            session={transcriptData}
            mediaKey={mediaKey}
            mediaUrl={clipMediaUrl}
            mediaType={clipMediaType}
            onSessionRefresh={handleSessionChange}
            onDownload={downloadFile}
            buildFilename={generateFilename}
          />
        )}
      </div>
    </div>
  )
}
