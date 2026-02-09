'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useDashboard } from '@/context/DashboardContext'
import TranscriptEditor, { EditorSessionResponse, EditorSaveResponse } from '@/components/TranscriptEditor'
import MediaMissingBanner from '@/components/MediaMissingBanner'
import { routes } from '@/utils/routes'
import { getTranscript as localGetTranscript, saveTranscript as localSaveTranscript } from '@/lib/storage'
import { getMediaObjectURL, promptRelinkMedia } from '@/lib/mediaHandles'

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
  const [mediaFilename, setMediaFilename] = useState<string>('')
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const urlKey = searchParams.get('key')
    if (urlKey) {
      setMediaKey(urlKey)
      setActiveMediaKey(urlKey)
    } else if (activeMediaKey) {
      setMediaKey(activeMediaKey)
    }
  }, [searchParams, activeMediaKey, setActiveMediaKey])

  const loadTranscript = useCallback(async (key: string) => {
    setIsLoading(true)
    setError('')
    try {
      const data = await localGetTranscript(key)
      if (!data) throw new Error('Transcript not found')

      const record = data as Record<string, unknown>
      setTranscriptData(data as unknown as TranscriptData)
      setMediaFilename((record.media_filename as string) || '')
      setMediaContentType((record.media_content_type as string) || undefined)

      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }

      const mediaSourceId = (record.media_handle_id as string) || key
      const url = await getMediaObjectURL(mediaSourceId)
      if (url) {
        blobUrlRef.current = url
        setMediaUrl(url)
        setMediaAvailable(true)
      } else {
        setMediaUrl('')
        setMediaAvailable(false)
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load transcript')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (mediaKey) {
      loadTranscript(mediaKey)
    }
  }, [mediaKey, loadTranscript])

  const handleSessionChange = useCallback((session: EditorSessionResponse) => {
    setTranscriptData((prev) => ({
      ...prev,
      ...session,
    }))

    if (session.media_filename) setMediaFilename(session.media_filename)
    if (session.media_content_type) setMediaContentType(session.media_content_type)
  }, [])

  const handleSaveComplete = useCallback((data: EditorSaveResponse) => {
    setTranscriptData((prev) => ({
      ...prev,
      ...data,
    }))
    refreshRecentTranscripts()
  }, [refreshRecentTranscripts])

  const handleRelinkMedia = useCallback(async () => {
    if (!mediaKey) return
    try {
      const result = await promptRelinkMedia(mediaFilename || 'media file')
      if (!result) return

      const relinkedFile = await result.handle.getFile()
      const nextMediaSourceId = result.handleId
      const existing = await localGetTranscript(mediaKey)
      if (existing) {
        const existingRecord = existing as Record<string, unknown>
        const caseId = typeof existingRecord.case_id === 'string' && existingRecord.case_id
          ? existingRecord.case_id
          : undefined

        const updated = {
          ...existingRecord,
          media_handle_id: nextMediaSourceId,
          media_filename: relinkedFile.name || (existingRecord.media_filename as string | undefined),
          media_content_type: relinkedFile.type || (existingRecord.media_content_type as string | undefined),
        } as Record<string, unknown>

        await localSaveTranscript(mediaKey, updated, caseId)
        setTranscriptData(updated as unknown as TranscriptData)
        refreshRecentTranscripts()
      }

      setMediaFilename(relinkedFile.name || mediaFilename)
      setMediaContentType(relinkedFile.type || mediaContentType)

      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }

      const url = await getMediaObjectURL(nextMediaSourceId)
      if (url) {
        blobUrlRef.current = url
        setMediaUrl(url)
        setMediaAvailable(true)
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to relink media')
    }
  }, [mediaContentType, mediaFilename, mediaKey, refreshRecentTranscripts])

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
          mediaFilename={mediaFilename}
          onReimport={handleRelinkMedia}
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
        onRequestMediaImport={handleRelinkMedia}
      />
    </div>
  )
}
