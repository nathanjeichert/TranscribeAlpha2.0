'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import TranscriptEditor, { EditorSaveResponse, EditorSessionResponse } from '@/components/TranscriptEditor'
import ClipCreator from '@/components/ClipCreator'
import { appendAccessTokenToMediaUrl, authenticatedFetch, getAuthHeaders } from '@/utils/auth'

interface FormData {
  case_name: string
  case_number: string
  firm_name: string
  input_date: string
  input_time: string
  location: string
  speaker_names: string
  transcription_model: 'assemblyai' | 'gemini'
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

interface SnapshotListItem {
  snapshot_id: string
  created_at?: string
  is_manual_save?: boolean
  line_count?: number
  title_label?: string
}

interface HistoryGroup extends TranscriptListItem {
  snapshots: SnapshotListItem[]
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
    transcription_model: 'assemblyai',
  })

  const [activeTab, setActiveTab] = useState<AppTab>('transcribe')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [mediaKey, setMediaKey] = useState<string | null>(null)
  const [transcriptData, setTranscriptData] = useState<TranscriptData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingStage, setLoadingStage] = useState<string | null>(null)
  const [error, setError] = useState<string>('')
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>('')
  const [mediaContentType, setMediaContentType] = useState<string | undefined>(undefined)
  const [mediaIsLocal, setMediaIsLocal] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyGroups, setHistoryGroups] = useState<HistoryGroup[]>([])
  const [historyModalLoading, setHistoryModalLoading] = useState(false)
  const [historyModalError, setHistoryModalError] = useState<string | null>(null)
  const [selectedHistoryKey, setSelectedHistoryKey] = useState<string | null>(null)
  const [restoringSnapshotId, setRestoringSnapshotId] = useState<string | null>(null)
  const [geminiBusy, setGeminiBusy] = useState(false)
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const [appVariant, setAppVariant] = useState<'oncue' | 'criminal'>('oncue')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const stageTimerRef = useRef<number | null>(null)

  const updateMediaPreview = useCallback(
    (blobName?: string | null, contentType?: string | null) => {
      if (!blobName) return
      if (mediaPreviewUrl && mediaIsLocal) {
        URL.revokeObjectURL(mediaPreviewUrl)
      }
      setMediaPreviewUrl(appendAccessTokenToMediaUrl(`/api/media/${blobName}`))
      setMediaContentType(contentType ?? undefined)
      setMediaIsLocal(false)
    },
    [mediaIsLocal, mediaPreviewUrl],
  )

  const hydrateTranscript = useCallback(
    (data: TranscriptData) => {
      setTranscriptData((previous) => {
        const prevKey = previous?.media_key ?? previous?.title_data?.MEDIA_ID ?? null
        const nextKey = data.media_key ?? data.title_data?.MEDIA_ID ?? null
        const sameKey = Boolean(prevKey && nextKey && prevKey === nextKey)
        const merged: TranscriptData = {
          ...(sameKey ? previous : {}),
          ...data,
          docx_base64: data.docx_base64 ?? (sameKey ? previous?.docx_base64 : undefined),
          oncue_xml_base64: data.oncue_xml_base64 ?? (sameKey ? previous?.oncue_xml_base64 : undefined),
          viewer_html_base64: data.viewer_html_base64 ?? (sameKey ? previous?.viewer_html_base64 : undefined),
          media_blob_name: data.media_blob_name ?? (sameKey ? previous?.media_blob_name : undefined),
          media_content_type: data.media_content_type ?? (sameKey ? previous?.media_content_type : undefined),
          audio_duration: data.audio_duration ?? (sameKey ? previous?.audio_duration : undefined) ?? 0,
          lines_per_page: data.lines_per_page ?? (sameKey ? previous?.lines_per_page : undefined) ?? 25,
          title_data: data.title_data ?? (sameKey ? previous?.title_data : undefined) ?? {},
          lines: data.lines ?? (sameKey ? previous?.lines : undefined) ?? [],
          clips: data.clips ?? (sameKey ? previous?.clips : undefined) ?? [],
          transcript: data.transcript
            ?? data.transcript_text
            ?? (sameKey ? previous?.transcript ?? previous?.transcript_text : null)
            ?? null,
          transcript_text: data.transcript_text
            ?? data.transcript
            ?? (sameKey ? previous?.transcript_text ?? previous?.transcript : null)
            ?? null,
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

  // Fetch app config to determine variant (oncue vs criminal)
  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.variant === 'criminal' || data.variant === 'oncue') {
          setAppVariant(data.variant)
        }
      })
      .catch(() => {
        // Default to oncue if config fetch fails
        setAppVariant('oncue')
      })
  }, [])

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
        const response = await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(key)}`)
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

  const trimSnapshotsToLimit = useCallback((snapshots: SnapshotListItem[]) => {
    const sorted = [...snapshots].sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
      return bTime - aTime
    })
    const manual = sorted.find((snap) => snap.is_manual_save)
    let limited = sorted.slice(0, 10)
    if (manual && !limited.some((snap) => snap.snapshot_id === manual.snapshot_id)) {
      if (limited.length >= 10) {
        limited[limited.length - 1] = manual
      } else {
        limited.push(manual)
      }
      limited = [...limited].sort((a, b) => {
        const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
        const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
        return bTime - aTime
      })
    }
    return limited
  }, [])

  const loadHistoryModal = useCallback(async () => {
    setShowHistoryModal(true)
    setHistoryModalLoading(true)
    setHistoryModalError(null)
    try {
      const response = await authenticatedFetch('/api/transcripts')
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to load history')
      }
      const payload = await response.json()
      const transcripts: TranscriptListItem[] = payload.transcripts || []

      const groups: HistoryGroup[] = await Promise.all(
        transcripts.map(async (item) => {
          try {
            const historyResponse = await authenticatedFetch(
              `/api/transcripts/by-key/${encodeURIComponent(item.media_key)}/history`,
            )
            let snapshots: SnapshotListItem[] = []
            if (historyResponse.ok) {
              const historyData = await historyResponse.json()
              snapshots = trimSnapshotsToLimit(
                (historyData.snapshots || []).map((snap: any) => ({
                  ...snap,
                  media_key: item.media_key,
                })),
              )
            }
            return {
              ...item,
              snapshots,
            }
          } catch {
            return {
              ...item,
              snapshots: [],
            }
          }
        }),
      )

      let finalGroups = groups

      // Fallback: if no transcripts listed but we have an active key, still attempt to load its history
      if (!finalGroups.length && (transcriptData?.media_key || mediaKey)) {
        const fallbackKey = transcriptData?.media_key ?? mediaKey!
        try {
          const historyResponse = await authenticatedFetch(
            `/api/transcripts/by-key/${encodeURIComponent(fallbackKey)}/history`,
          )
          const historyData = historyResponse.ok ? await historyResponse.json() : { snapshots: [] }
          finalGroups = [
            {
              media_key: fallbackKey,
              title_label: fallbackKey,
              updated_at: null,
              line_count: 0,
              snapshots: trimSnapshotsToLimit(
                (historyData.snapshots || []).map((snap: any) => ({
                  ...snap,
                  media_key: fallbackKey,
                })),
              ),
            },
          ]
        } catch {
          finalGroups = []
        }
      }

      const preferredKey = transcriptData?.media_key ?? mediaKey
      const initialKey =
        preferredKey && finalGroups.some((group) => group.media_key === preferredKey)
          ? preferredKey
          : finalGroups[0]?.media_key ?? null

      setHistoryGroups(finalGroups)
      setSelectedHistoryKey(initialKey)
    } catch (err: any) {
      setHistoryModalError(err?.message || 'Failed to load history')
    } finally {
      setHistoryModalLoading(false)
    }
  }, [mediaKey, transcriptData?.media_key, trimSnapshotsToLimit])

  const handleRestoreSnapshot = useCallback(
    async (key: string, snapshotId: string) => {
      setRestoringSnapshotId(`${key}:${snapshotId}`)
      setHistoryModalError(null)
      try {
        const response = await authenticatedFetch(
          `/api/transcripts/by-key/${encodeURIComponent(key)}/restore/${snapshotId}`,
          {
            method: 'POST',
          },
        )
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to restore snapshot')
        }
        const data: TranscriptData = await response.json()
        hydrateTranscript(data)
        setActiveTab('editor')
        setShowHistoryModal(false)
      } catch (err: any) {
        setHistoryModalError(err?.message || 'Failed to restore snapshot')
      } finally {
        setRestoringSnapshotId(null)
      }
    },
    [hydrateTranscript],
  )

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!selectedFile) {
      setError('Please select a file to transcribe')
      return
    }

    setIsLoading(true)
    setLoadingStage('Uploading media...')
    setError('')
    setTranscriptData(null)
    setMediaKey(null)

    const clearStageTimer = () => {
      if (stageTimerRef.current) {
        window.clearTimeout(stageTimerRef.current)
        stageTimerRef.current = null
      }
    }

    try {
      const submitFormData = new FormData()
      submitFormData.append('file', selectedFile)
      Object.entries(formData).forEach(([key, value]) => {
        submitFormData.append(key, value.toString())
      })

      const isVideoFile =
        (selectedFile.type || '').startsWith('video/') ||
        /\.(mp4|mov|avi|mkv)$/i.test(selectedFile.name)

      const data: TranscriptData = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open('POST', '/api/transcribe', true)
        const authHeaders = getAuthHeaders()
        Object.entries(authHeaders).forEach(([key, value]) => {
          request.setRequestHeader(key, String(value))
        })
        request.responseType = 'json'

        request.upload.onprogress = () => {
          setLoadingStage('Uploading media...')
        }

        request.upload.onload = () => {
          clearStageTimer()
          if (isVideoFile) {
            setLoadingStage('Converting to audio...')
            stageTimerRef.current = window.setTimeout(() => {
              setLoadingStage('Transcribing (this could take a few minutes)...')
              stageTimerRef.current = null
            }, 1200)
          } else {
            setLoadingStage('Transcribing (this could take a few minutes)...')
          }
        }

        request.onload = () => {
          clearStageTimer()
          const responseData =
            request.response ??
            (() => {
              try {
                return JSON.parse(request.responseText)
              } catch {
                return null
              }
            })()

          if (request.status >= 200 && request.status < 300) {
            setLoadingStage('Producing transcript...')
            resolve(responseData as TranscriptData)
            return
          }

          const detail = responseData?.detail || 'Transcription failed'
          reject(new Error(detail))
        }

        request.onerror = () => {
          clearStageTimer()
          reject(new Error('Upload failed. Please try again.'))
        }

        request.send(submitFormData)
      })

      hydrateTranscript(data)
    } catch (err: any) {
      console.error('Transcription error:', err)
      setError(err.message || 'Transcription failed')
    } finally {
      clearStageTimer()
      setIsLoading(false)
      setLoadingStage(null)
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
      const response = await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(mediaKey)}/gemini-refine`, {
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
  const remoteMediaUrl = transcriptData?.media_blob_name
    ? appendAccessTokenToMediaUrl(`/api/media/${transcriptData.media_blob_name}`)
    : mediaPreviewUrl || undefined
  const clipMediaUrl = (mediaIsLocal && mediaPreviewUrl) || remoteMediaUrl
  const clipMediaType =
    (mediaIsLocal ? mediaContentType ?? selectedFile?.type : undefined) ??
    transcriptData?.media_content_type ??
    mediaContentType ??
    selectedFile?.type
  const selectedHistoryGroup = historyGroups.find((group) => group.media_key === selectedHistoryKey)

  // Track if we've already loaded from localStorage to prevent re-fetching after import
  const hasLoadedFromStorage = useRef(false)

  useEffect(() => {
    // Only load from localStorage once on initial mount
    if (hasLoadedFromStorage.current) return
    hasLoadedFromStorage.current = true

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  return (
    <>
      <div className="min-h-screen bg-primary-50">
        <div className="max-w-screen-2xl mx-auto px-6 py-12">
          <div className="text-center mb-12">
            <div className="bg-gradient-to-r from-primary-900 to-primary-700 text-white rounded-2xl p-8 shadow-2xl">
              <h1 className="text-4xl font-light mb-4">TranscribeAlpha</h1>
              <p className="text-lg text-primary-100">Professional Legal Transcript Generator</p>
            </div>
          </div>

          <div className="flex justify-center mb-10 gap-4 flex-wrap items-center">
            <button className={tabClasses('transcribe')} onClick={() => setActiveTab('transcribe')}>
              Transcription
            </button>
            <button className={tabClasses('editor')} onClick={() => setActiveTab('editor')}>
              Editor
            </button>
            <button className={tabClasses('clip')} onClick={() => setActiveTab('clip')}>
              Clip Creator
            </button>
            <button
              className="btn-outline text-sm"
              onClick={() => {
                loadHistoryModal()
              }}
            >
              History
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
                        Transcription Model
                      </label>
                      <select
                        name="transcription_model"
                        value={formData.transcription_model}
                        onChange={handleInputChange}
                        className="input-field"
                      >
                        <option value="assemblyai">AssemblyAI</option>
                        <option value="gemini">Gemini 3.0 Pro</option>
                      </select>
                    </div>
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
                    {isLoading ? 'Processing...' : 'Generate Transcript'}
                  </button>
                </div>

                {isLoading && (
                  <div className="flex items-center justify-center gap-3 rounded-lg border border-primary-200 bg-white px-4 py-3 text-sm text-primary-700 shadow-sm">
                    <svg
                      className="h-5 w-5 animate-spin text-primary-600"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <span className="font-medium">{loadingStage || 'Processing transcript...'}</span>
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
                        {appVariant === 'oncue' ? (
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
                        ) : (
                          <button
                            onClick={() => {
                              if (transcriptData.viewer_html_base64) {
                                downloadFile(transcriptData.viewer_html_base64, generateFilename('viewer', '.html'), 'text/html')
                              }
                            }}
                            className="btn-primary text-center py-3"
                            disabled={!transcriptData.viewer_html_base64}
                          >
                            🎬 Download HTML Viewer
                          </button>
                        )}
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

          {activeTab === 'editor' && (
            <TranscriptEditor
              mediaKey={mediaKey}
              initialData={transcriptData}
              mediaUrl={mediaPreviewUrl || undefined}
              mediaType={mediaContentType ?? selectedFile?.type}
              docxBase64={transcriptData?.docx_base64 ?? undefined}
              xmlBase64={transcriptData?.oncue_xml_base64 ?? undefined}
              viewerHtmlBase64={transcriptData?.viewer_html_base64 ?? undefined}
              appVariant={appVariant}
              onDownload={downloadFile}
              buildFilename={generateFilename}
              onSessionChange={handleSessionChange}
              onSaveComplete={handleEditorSave}
              onOpenHistory={loadHistoryModal}
              onGeminiRefine={handleGeminiRefine}
              isGeminiBusy={geminiBusy}
              geminiError={geminiError}
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
              onOpenHistory={loadHistoryModal}
              appVariant={appVariant}
            />
          )}
        </div>
      </div>
      {showHistoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-6xl rounded-lg bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xl font-semibold text-primary-900">Transcript History</h3>
                <p className="text-sm text-primary-600">
                  Snapshots grouped by media ID. Autosave runs every minute and keeps the latest ten per transcript.
                </p>
              </div>
              <button
                className="rounded border border-primary-300 px-3 py-1 text-sm text-primary-700 hover:bg-primary-100"
                onClick={() => setShowHistoryModal(false)}
              >
                Close
              </button>
            </div>

            {historyModalError && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {historyModalError}
              </div>
            )}

            <div className="mt-4 grid grid-cols-[260px_1fr] gap-4 max-h-[70vh]">
              <div className="rounded border border-primary-100 overflow-y-auto">
                {historyModalLoading ? (
                  <div className="p-4 text-sm text-primary-600">Loading transcripts...</div>
                ) : historyGroups.length === 0 ? (
                  <div className="p-4 text-sm text-primary-700">No saved transcripts yet.</div>
                ) : (
                  <ul>
                    {historyGroups.map((group) => (
                      <li key={group.media_key}>
                        <button
                          className={`w-full px-4 py-3 text-left transition ${selectedHistoryKey === group.media_key
                            ? 'bg-primary-100 font-semibold text-primary-900'
                            : 'hover:bg-primary-50 text-primary-800'
                            }`}
                          onClick={() => setSelectedHistoryKey(group.media_key)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-primary-900">{group.title_label || 'Untitled transcript'}</div>
                            <div className="text-[11px] text-primary-500">
                              {group.updated_at ? new Date(group.updated_at).toLocaleString() : '—'}
                            </div>
                          </div>
                          <div className="text-[11px] text-primary-500 mt-1">Key: {group.media_key}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded border border-primary-100 overflow-y-auto">
                {historyModalLoading ? (
                  <div className="p-4 text-sm text-primary-600">Loading snapshots...</div>
                ) : !selectedHistoryGroup ? (
                  <div className="p-4 text-sm text-primary-700">Select a transcript to view its snapshots.</div>
                ) : selectedHistoryGroup.snapshots.length === 0 ? (
                  <div className="p-4 text-sm text-primary-700">
                    No autosaves or manual saves yet for this media ID. Make an edit to start autosaving.
                  </div>
                ) : (
                  <ul>
                    {selectedHistoryGroup.snapshots.map((snap) => {
                      const restoreKey = `${selectedHistoryGroup.media_key}:${snap.snapshot_id}`
                      const restoring = restoringSnapshotId === restoreKey
                      return (
                        <li
                          key={`${selectedHistoryGroup.media_key}-${snap.snapshot_id}`}
                          className="flex items-center justify-between border-b border-primary-100 px-4 py-3 text-sm"
                        >
                          <div>
                            <div className="font-semibold text-primary-900">
                              {snap.title_label || selectedHistoryGroup.title_label || selectedHistoryGroup.media_key}
                            </div>
                            <div className="text-xs text-primary-600">
                              {snap.created_at ? new Date(snap.created_at).toLocaleString() : 'Unknown time'}
                            </div>
                            <div className="text-xs text-primary-500">
                              {snap.is_manual_save ? 'Manual save' : 'Autosave'} - {snap.line_count ?? 0} lines
                            </div>
                          </div>
                          <button
                            className="rounded border border-primary-300 px-3 py-1 text-xs font-semibold text-primary-800 hover:bg-primary-100 disabled:opacity-60"
                            onClick={() => handleRestoreSnapshot(selectedHistoryGroup.media_key, snap.snapshot_id)}
                            disabled={restoring}
                          >
                            {restoring ? 'Restoring...' : 'Restore'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
