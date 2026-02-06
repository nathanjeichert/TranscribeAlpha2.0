'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useDashboard } from '@/context/DashboardContext'
import { authenticatedFetch } from '@/utils/auth'
import TranscriptEditor, { EditorSessionResponse, EditorSaveResponse } from '@/components/TranscriptEditor'
import MediaMissingBanner from '@/components/MediaMissingBanner'
import { routes } from '@/utils/routes'
import { getTranscript as localGetTranscript } from '@/lib/storage'
import { getMediaHandle, getMediaObjectURL, promptRelinkMedia, storeMediaHandle } from '@/lib/mediaHandles'

type TranscriptData = EditorSessionResponse & {
  transcript?: string | null
  transcript_text?: string | null
}

interface SnapshotListItem {
  snapshot_id: string
  created_at?: string
  is_manual_save?: boolean
  line_count?: number
  title_label?: string
}

export default function EditorPage() {
  const searchParams = useSearchParams()
  const { activeMediaKey, setActiveMediaKey, refreshRecentTranscripts, appVariant } = useDashboard()

  const [mediaKey, setMediaKey] = useState<string | null>(null)
  const [transcriptData, setTranscriptData] = useState<TranscriptData | null>(null)
  const [mediaUrl, setMediaUrl] = useState<string>('')
  const [mediaContentType, setMediaContentType] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string>('')
  const [mediaAvailable, setMediaAvailable] = useState(true)
  const [showReimportModal, setShowReimportModal] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historySnapshots, setHistorySnapshots] = useState<SnapshotListItem[]>([])
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null)
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [mediaFilename, setMediaFilename] = useState<string>('')
  const blobUrlRef = useRef<string | null>(null)

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [])

  // Get media_key from URL or context
  useEffect(() => {
    const urlKey = searchParams.get('key')
    if (urlKey) {
      setMediaKey(urlKey)
      setActiveMediaKey(urlKey)
    } else if (activeMediaKey) {
      setMediaKey(activeMediaKey)
    }
  }, [searchParams, activeMediaKey, setActiveMediaKey])

  // Load transcript data
  const loadTranscript = useCallback(async (key: string) => {
    setIsLoading(true)
    setError('')
    try {
      if (appVariant === 'criminal') {
        const data = await localGetTranscript(key)
        if (!data) throw new Error('Transcript not found')
        setTranscriptData(data as unknown as TranscriptData)
        setMediaFilename((data as Record<string, unknown>).media_filename as string || '')

        // Try to get media from IndexedDB handle
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current)
          blobUrlRef.current = null
        }
        const url = await getMediaObjectURL(key)
        if (url) {
          blobUrlRef.current = url
          setMediaUrl(url)
          setMediaContentType((data as Record<string, unknown>).media_content_type as string || undefined)
          setMediaAvailable(true)
        } else {
          setMediaUrl('')
          setMediaAvailable(false)
        }
      } else {
        const response = await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(key)}`)
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}))
          throw new Error(detail?.detail || 'Failed to load transcript')
        }
        const data: TranscriptData = await response.json()
        setTranscriptData(data)

        if (data.media_blob_name) {
          setMediaUrl(`/api/media/${data.media_blob_name}`)
          setMediaContentType(data.media_content_type ?? undefined)
        } else {
          setMediaUrl('')
          setMediaContentType(undefined)
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load transcript')
    } finally {
      setIsLoading(false)
    }
  }, [appVariant])

  // Check media availability
  const checkMediaStatus = useCallback(async (key: string) => {
    if (appVariant === 'criminal') {
      // Already checked in loadTranscript for criminal
      return
    }
    try {
      const response = await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(key)}/media-status`)
      if (!response.ok) {
        if (response.status === 404) {
          setMediaAvailable(false)
        }
        return
      }
      const data = await response.json()
      setMediaAvailable(data.media_available ?? data.available ?? true)
    } catch {
      // Assume available if check fails
      setMediaAvailable(true)
    }
  }, [appVariant])

  useEffect(() => {
    if (mediaKey) {
      loadTranscript(mediaKey)
      checkMediaStatus(mediaKey)
    }
  }, [mediaKey, loadTranscript, checkMediaStatus])

  const handleSessionChange = useCallback((session: EditorSessionResponse) => {
    setTranscriptData(prev => ({
      ...prev,
      ...session,
    }))
    if (appVariant !== 'criminal' && session.media_blob_name) {
      setMediaUrl(`/api/media/${session.media_blob_name}`)
      setMediaContentType(session.media_content_type ?? undefined)
    }
  }, [appVariant])

  const handleSaveComplete = useCallback((data: EditorSaveResponse) => {
    setTranscriptData(prev => ({
      ...prev,
      ...data,
    }))
    refreshRecentTranscripts()
  }, [refreshRecentTranscripts])

  const handleMediaReimported = useCallback(() => {
    if (mediaKey) {
      loadTranscript(mediaKey)
      setMediaAvailable(true)
    }
    setShowReimportModal(false)
  }, [mediaKey, loadTranscript])

  const handleRelinkMedia = useCallback(async () => {
    if (!mediaKey) return
    const result = await promptRelinkMedia(mediaFilename || 'media file')
    if (result) {
      await storeMediaHandle(mediaKey, result.handle)
      // Refresh media URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      const url = await getMediaObjectURL(mediaKey)
      if (url) {
        blobUrlRef.current = url
        setMediaUrl(url)
        setMediaAvailable(true)
      }
    }
  }, [mediaKey, mediaFilename])

  const openHistoryModal = useCallback(async () => {
    if (!mediaKey) return

    setShowHistoryModal(true)
    setHistoryLoading(true)
    setHistoryError('')
    setSelectedSnapshotId(null)

    try {
      const response = await authenticatedFetch(
        `/api/transcripts/by-key/${encodeURIComponent(mediaKey)}/history`,
      )
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to load edit history')
      }

      const data = await response.json()
      const snapshots: SnapshotListItem[] = (data.snapshots || [])
        .sort((a: SnapshotListItem, b: SnapshotListItem) => {
          const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
          const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
          return bTime - aTime
        })
        .slice(0, 10)
      setHistorySnapshots(snapshots)
    } catch (err: any) {
      setHistoryError(err?.message || 'Failed to load edit history')
      setHistorySnapshots([])
    } finally {
      setHistoryLoading(false)
    }
  }, [mediaKey])

  const handleLoadSnapshot = useCallback(async () => {
    if (!mediaKey || !selectedSnapshotId) return

    setIsLoadingSnapshot(true)
    setHistoryError('')

    try {
      const response = await authenticatedFetch(
        `/api/transcripts/by-key/${encodeURIComponent(mediaKey)}/restore/${selectedSnapshotId}`,
        { method: 'POST' },
      )
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to load snapshot')
      }

      const data: TranscriptData = await response.json()
      handleSessionChange(data)
      refreshRecentTranscripts()
      setShowHistoryModal(false)
      setSelectedSnapshotId(null)
    } catch (err: any) {
      setHistoryError(err?.message || 'Failed to load snapshot')
    } finally {
      setIsLoadingSnapshot(false)
    }
  }, [handleSessionChange, mediaKey, refreshRecentTranscripts, selectedSnapshotId])

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
    const caseName = transcriptData?.title_data?.CASE_NAME || ''
    const date = transcriptData?.title_data?.DATE || ''
    let filename = ''
    if (caseName) {
      const sanitized = caseName.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-')
      filename += sanitized + '-'
    }
    filename += baseName
    if (date) filename += '-' + date
    return filename + extension
  }

  if (!mediaKey) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">No Transcript Selected</h2>
          <p className="text-gray-500 mb-6">Select a transcript from the sidebar or create a new one.</p>
          <Link href={routes.transcribe()} className="btn-primary px-6 py-3 inline-block">
            Create New Transcript
          </Link>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 relative">
            <div className="absolute inset-0 border-4 border-primary-200 rounded-full"></div>
            <div className="absolute inset-0 border-4 border-primary-600 rounded-full border-t-transparent animate-spin"></div>
          </div>
          <p className="text-gray-500">Loading transcript...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-xl p-8 text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Error Loading Transcript</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button onClick={() => loadTranscript(mediaKey)} className="btn-primary px-6 py-3">
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {mediaKey && (
        <div className="px-6 pt-4">
          <Link
            href={routes.viewer(mediaKey)}
            className="inline-flex items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-3 py-1.5 text-sm font-medium text-primary-700 hover:bg-primary-100"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            View in Viewer
          </Link>
        </div>
      )}

      {!mediaAvailable && (
        <MediaMissingBanner
          mediaKey={mediaKey}
          appVariant={appVariant}
          mediaFilename={mediaFilename}
          onReimport={appVariant === 'criminal' ? handleRelinkMedia : () => setShowReimportModal(true)}
        />
      )}

      <TranscriptEditor
        mediaKey={mediaKey}
        initialData={transcriptData}
        mediaUrl={mediaAvailable ? mediaUrl : undefined}
        mediaType={mediaContentType}
        pdfBase64={transcriptData?.pdf_base64 ?? transcriptData?.docx_base64}
        docxBase64={transcriptData?.docx_base64}
        xmlBase64={transcriptData?.oncue_xml_base64}
        viewerHtmlBase64={transcriptData?.viewer_html_base64}
        appVariant={appVariant}
        onDownload={downloadFile}
        buildFilename={generateFilename}
        onSessionChange={handleSessionChange}
        onSaveComplete={handleSaveComplete}
        onRequestMediaImport={appVariant === 'criminal' ? handleRelinkMedia : () => setShowReimportModal(true)}
        onOpenHistory={appVariant === 'criminal' ? undefined : openHistoryModal}
      />

      {/* Reimport Modal */}
      {showReimportModal && (
        <ReimportMediaModal
          mediaKey={mediaKey}
          onClose={() => setShowReimportModal(false)}
          onSuccess={handleMediaReimported}
        />
      )}

      {showHistoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-3xl rounded-lg bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xl font-semibold text-primary-900">Edit History</h3>
                <p className="text-sm text-primary-600">
                  Showing the ten most recent snapshots for this transcript.
                </p>
              </div>
              <button
                className="rounded border border-primary-300 px-3 py-1 text-sm text-primary-700 hover:bg-primary-100"
                onClick={() => setShowHistoryModal(false)}
              >
                Close
              </button>
            </div>

            {historyError && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {historyError}
              </div>
            )}

            <div className="mt-4 max-h-[60vh] overflow-y-auto rounded border border-primary-100">
              {historyLoading ? (
                <div className="p-4 text-sm text-primary-600">Loading snapshots...</div>
              ) : historySnapshots.length === 0 ? (
                <div className="p-4 text-sm text-primary-700">
                  No saved snapshots yet for this transcript.
                </div>
              ) : (
                <ul>
                  {historySnapshots.map((snapshot) => {
                    const isSelected = selectedSnapshotId === snapshot.snapshot_id
                    const itemClasses = [
                      'w-full border-b border-primary-100 px-4 py-3 text-left transition-colors',
                      isSelected ? 'bg-primary-100 hover:bg-primary-100 ring-2 ring-inset ring-primary-500 border-l-4 border-l-primary-600' : 'hover:bg-primary-50',
                    ]
                    return (
                      <li key={snapshot.snapshot_id}>
                        <button
                          type="button"
                          className={itemClasses.join(' ')}
                          onClick={() => setSelectedSnapshotId(snapshot.snapshot_id)}
                        >
                          <div className="font-semibold text-primary-900">
                            {snapshot.title_label || transcriptData?.title_data?.CASE_NAME || mediaKey}
                          </div>
                          <div className="text-xs text-primary-600">
                            {snapshot.created_at ? new Date(snapshot.created_at).toLocaleString() : 'Unknown time'}
                          </div>
                          <div className="text-xs text-primary-500">
                            {snapshot.is_manual_save ? 'Manual save' : 'Autosave'} - {snapshot.line_count ?? 0} lines
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-3">
              <button
                className="rounded border border-primary-300 px-4 py-2 text-sm text-primary-700 hover:bg-primary-100"
                onClick={() => setShowHistoryModal(false)}
              >
                Cancel
              </button>
              <button
                className="rounded px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 bg-primary-600 hover:bg-primary-700"
                onClick={handleLoadSnapshot}
                disabled={!selectedSnapshotId || historyLoading || isLoadingSnapshot}
              >
                {isLoadingSnapshot ? 'Loading...' : 'Load Snapshot'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ReimportMediaModal({
  mediaKey,
  onClose,
  onSuccess,
}: {
  mediaKey: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const handleUpload = async () => {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await authenticatedFetch(
        `/api/transcripts/by-key/${encodeURIComponent(mediaKey)}/reattach-media`,
        { method: 'POST', body: formData }
      )
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to upload media')
      }
      onSuccess()
    } catch (err: any) {
      setError(err?.message || 'Failed to upload media')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Re-import Media File</h3>
        <p className="text-sm text-gray-500 mb-4">
          The original media file has expired. Upload the same or updated file to enable playback and clip creation.
        </p>

        <label className={`block border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          file ? 'border-green-300 bg-green-50' : 'border-gray-300 hover:border-primary-400'
        }`}>
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            accept="audio/*,video/*"
            className="sr-only"
          />
          {file ? (
            <div>
              <p className="font-medium text-gray-900">{file.name}</p>
              <p className="text-sm text-gray-500">{(file.size / (1024 * 1024)).toFixed(1)} MB</p>
            </div>
          ) : (
            <div>
              <p className="font-medium text-gray-700">Click to select file</p>
              <p className="text-sm text-gray-500">Audio or video file</p>
            </div>
          )}
        </label>

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="btn-outline px-4 py-2">
            Cancel
          </button>
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="btn-primary px-4 py-2"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  )
}
