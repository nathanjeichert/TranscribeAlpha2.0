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

interface TranscriptResponse {
  transcript: string
  docx_base64: string
  oncue_xml_base64: string
  editor_session_id?: string
  media_blob_name?: string | null
  media_content_type?: string | null
}

type AppTab = 'transcribe' | 'editor' | 'clip'

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
  const [editorSessionId, setEditorSessionId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<TranscriptResponse | null>(null)
  const [error, setError] = useState<string>('')
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>('')
  const [mediaContentType, setMediaContentType] = useState<string | undefined>(undefined)
  const [mediaIsLocal, setMediaIsLocal] = useState(false)
  const [sessionDetails, setSessionDetails] = useState<EditorSessionResponse | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const syncEditorSession = useCallback(
    (raw: {
      session_id?: string | null
      editor_session_id?: string | null
      docx_base64?: string | null
      oncue_xml_base64?: string | null
      transcript?: string | null
      media_blob_name?: string | null
      media_content_type?: string | null
      full_session?: EditorSessionResponse
    }) => {
      const sessionIdValue = raw.session_id ?? raw.editor_session_id ?? null

      setEditorSessionId(sessionIdValue)
      setResult((prev) => ({
        transcript: raw.transcript ?? prev?.transcript ?? '',
        docx_base64: raw.docx_base64 ?? prev?.docx_base64 ?? '',
        oncue_xml_base64: raw.oncue_xml_base64 ?? prev?.oncue_xml_base64 ?? '',
        editor_session_id: sessionIdValue ?? undefined,
        media_blob_name: raw.media_blob_name ?? prev?.media_blob_name,
        media_content_type: raw.media_content_type ?? prev?.media_content_type,
      }))

      if (raw.full_session) {
        setSessionDetails(raw.full_session)
      }

      if (raw.media_blob_name) {
        if (mediaPreviewUrl && mediaIsLocal) {
          URL.revokeObjectURL(mediaPreviewUrl)
        }
        setMediaPreviewUrl(`/api/media/${raw.media_blob_name}`)
        setMediaContentType(raw.media_content_type ?? undefined)
        setMediaIsLocal(false)
      }
    },
    [mediaIsLocal, mediaPreviewUrl],
  )

  useEffect(() => {
    return () => {
      if (mediaPreviewUrl && mediaIsLocal) {
        URL.revokeObjectURL(mediaPreviewUrl)
      }
    }
  }, [mediaPreviewUrl, mediaIsLocal])

  useEffect(() => {
    let cancelled = false

    const loadLatestSession = async () => {
      try {
        const response = await fetch('/api/transcripts/latest')
        if (!response.ok) {
          return
        }
        const data: EditorSessionResponse = await response.json()
        if (cancelled) return
        if (data.session_id) {
          syncEditorSession({
            session_id: data.session_id,
            docx_base64: data.docx_base64 ?? undefined,
            oncue_xml_base64: data.oncue_xml_base64 ?? undefined,
            transcript: data.transcript ?? undefined,
            media_blob_name: data.media_blob_name ?? undefined,
            media_content_type: data.media_content_type ?? undefined,
            full_session: data,
          })
        }
      } catch (err) {
        console.warn('Failed to load latest transcript session', err)
      }
    }

    loadLatestSession()

    return () => {
      cancelled = true
    }
  }, [syncEditorSession])

  useEffect(() => {
    if (!editorSessionId) {
      setSessionDetails(null)
      return
    }
    if (sessionDetails?.session_id === editorSessionId) {
      return
    }

    let cancelled = false

    const loadSession = async () => {
      try {
        const response = await fetch(`/api/transcripts/${editorSessionId}`)
        if (!response.ok) {
          return
        }
        const data: EditorSessionResponse = await response.json()
        if (cancelled) return
        syncEditorSession({
          session_id: data.session_id,
          docx_base64: data.docx_base64 ?? undefined,
          oncue_xml_base64: data.oncue_xml_base64 ?? undefined,
          transcript: data.transcript ?? undefined,
          media_blob_name: data.media_blob_name ?? undefined,
          media_content_type: data.media_content_type ?? undefined,
          full_session: data,
        })
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to load session details', err)
        }
      }
    }

    loadSession()

    return () => {
      cancelled = true
    }
  }, [editorSessionId, sessionDetails?.session_id, syncEditorSession])

  const handleSessionChange = useCallback(
    (session: EditorSessionResponse) => {
      setSessionDetails(session)
      syncEditorSession({
        session_id: session.session_id,
        docx_base64: session.docx_base64 ?? undefined,
        oncue_xml_base64: session.oncue_xml_base64 ?? undefined,
        transcript: session.transcript ?? undefined,
        media_blob_name: session.media_blob_name ?? undefined,
        media_content_type: session.media_content_type ?? undefined,
        full_session: session,
      })
    },
    [syncEditorSession],
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
    setResult(null)
    setEditorSessionId(null)
    setSessionDetails(null)
    setActiveTab('transcribe')

    const previewUrl = URL.createObjectURL(file)
    setMediaPreviewUrl(previewUrl)
    setMediaContentType(file.type)
    setMediaIsLocal(true)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!selectedFile) {
      setError('Please select a file to transcribe')
      return
    }

    setIsLoading(true)
    setProgress(0)
    setError('')
    setResult(null)
    setEditorSessionId(null)
    setSessionDetails(null)

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

      const data: TranscriptResponse = await response.json()
      syncEditorSession({
        session_id: data.editor_session_id ?? null,
        docx_base64: data.docx_base64,
        oncue_xml_base64: data.oncue_xml_base64,
        transcript: data.transcript,
        media_blob_name: data.media_blob_name ?? undefined,
        media_content_type: data.media_content_type ?? undefined,
      })
      if (data.media_blob_name) {
        setMediaIsLocal(false)
        setMediaContentType(data.media_content_type ?? undefined)
      }
      setProgress(100)
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
    setSessionDetails(data)
    syncEditorSession({
      session_id: data.session_id,
      docx_base64: data.docx_base64 ?? undefined,
      oncue_xml_base64: data.oncue_xml_base64 ?? undefined,
      transcript: data.transcript ?? undefined,
      media_blob_name: data.media_blob_name ?? undefined,
      media_content_type: data.media_content_type ?? undefined,
      full_session: data,
    })
  }

  const tabClasses = (tab: AppTab) =>
    `px-4 py-2 rounded-lg font-medium transition ${
      activeTab === tab
        ? 'bg-primary-900 text-white shadow-lg'
        : 'bg-primary-100 text-primary-600 hover:bg-primary-200'
    }`

  const transcriptSegments =
    result?.transcript.split('\n\n').filter((segment) => segment.trim()).length ?? 0

  const previewContentType = mediaContentType ?? selectedFile?.type ?? ''
  const isVideoPreview = previewContentType.startsWith('video/')
  const clipMediaUrl = sessionDetails?.media_blob_name
    ? `/api/media/${sessionDetails.media_blob_name}`
    : mediaPreviewUrl || undefined
  const clipMediaType = sessionDetails?.media_content_type ?? mediaContentType ?? selectedFile?.type

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
          <button className={tabClasses('editor')} onClick={() => setActiveTab('editor')}>
            Editor
          </button>
          <button className={tabClasses('clip')} onClick={() => setActiveTab('clip')}>
            Clip Creator
          </button>
        </div>

        {activeTab === 'transcribe' && (
          <div className="space-y-8">
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

            {result && (
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
                        onClick={() =>
                          downloadFile(
                            result.docx_base64,
                            generateFilename('transcript', '.docx'),
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                          )
                        }
                        className="btn-primary text-center py-3"
                      >
                        📄 Download DOCX
                      </button>
                      <button
                        onClick={() =>
                          downloadFile(result.oncue_xml_base64, generateFilename('transcript', '.xml'), 'application/xml')
                        }
                        className="btn-primary text-center py-3"
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
                        onClick={() => editorSessionId && setActiveTab('editor')}
                        disabled={!editorSessionId}
                      >
                        Open Editor
                      </button>
                    </div>
                    <div>
                      <h3 className="font-medium text-primary-900 mb-3">Transcript Preview:</h3>
                      <div className="bg-primary-50 rounded-lg p-4 max-h-64 overflow-y-auto">
                        <pre className="whitespace-pre-wrap text-sm text-primary-800 font-mono">
                          {result.transcript.substring(0, 1000)}
                          {result.transcript.length > 1000 && '...'}
                        </pre>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'editor' && (
          <TranscriptEditor
            sessionId={editorSessionId}
            mediaUrl={mediaPreviewUrl || undefined}
            mediaType={mediaContentType ?? selectedFile?.type}
            docxBase64={result?.docx_base64}
            xmlBase64={result?.oncue_xml_base64}
            onDownload={downloadFile}
            buildFilename={generateFilename}
            onSessionChange={handleSessionChange}
            onSaveComplete={handleEditorSave}
          />
        )}

        {activeTab === 'clip' && (
          <ClipCreator
            session={sessionDetails}
            sessionId={editorSessionId}
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
