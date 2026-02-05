'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useDashboard } from '@/context/DashboardContext'
import { authenticatedFetch } from '@/utils/auth'
import TranscriptEditor, { EditorSessionResponse, EditorSaveResponse } from '@/components/TranscriptEditor'
import MediaMissingBanner from '@/components/MediaMissingBanner'
import { routes } from '@/utils/routes'

type TranscriptData = EditorSessionResponse & {
  transcript?: string | null
  transcript_text?: string | null
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
  const [checkingMedia, setCheckingMedia] = useState(false)
  const [showReimportModal, setShowReimportModal] = useState(false)

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
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load transcript')
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Check media availability
  const checkMediaStatus = useCallback(async (key: string) => {
    setCheckingMedia(true)
    try {
      const response = await authenticatedFetch(`/api/transcripts/by-key/${encodeURIComponent(key)}/media-status`)
      if (response.ok) {
        const data = await response.json()
        setMediaAvailable(data.media_available ?? data.available ?? true)
      }
    } catch {
      // Assume available if check fails
      setMediaAvailable(true)
    } finally {
      setCheckingMedia(false)
    }
  }, [])

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
    if (session.media_blob_name) {
      setMediaUrl(`/api/media/${session.media_blob_name}`)
      setMediaContentType(session.media_content_type ?? undefined)
    }
  }, [])

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
      {!mediaAvailable && (
        <MediaMissingBanner
          mediaKey={mediaKey}
          onReimport={() => setShowReimportModal(true)}
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
      />

      {/* Reimport Modal */}
      {showReimportModal && (
        <ReimportMediaModal
          mediaKey={mediaKey}
          onClose={() => setShowReimportModal(false)}
          onSuccess={handleMediaReimported}
        />
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
