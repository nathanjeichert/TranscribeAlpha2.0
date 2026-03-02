import { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedFetch } from '@/utils/auth'
import { logger } from '@/utils/logger'
import { resolveMediaFileForRecord } from '@/lib/mediaPlayback'
import type { ClipRecord } from '@/lib/storage'
import {
  escapeScriptBoundary,
  sanitizeFilename,
  sanitizeDownloadStem,
  buildViewerPayload,
  SEARCH_TOLERANCE,
  type ViewerTranscript,
} from '@/utils/transcriptFormat'
import { downloadBlob, fileToBase64 } from '@/utils/helpers'

interface UseExportParams {
  transcript: ViewerTranscript | null
  currentMediaKey: string | null
  transcriptCacheRef: React.MutableRefObject<Record<string, ViewerTranscript>>
  getTranscriptForExport: (mediaKey: string) => Promise<ViewerTranscript | null>
}

export function useExport({
  transcript,
  currentMediaKey,
  transcriptCacheRef,
  getTranscriptForExport,
}: UseExportParams) {
  const [exporting, setExporting] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const templateCacheRef = useRef<string | null>(null)

  // Close export menu on outside click
  useEffect(() => {
    if (!exportMenuOpen) return

    const onDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (exportMenuRef.current && !exportMenuRef.current.contains(target)) {
        setExportMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', onDocumentPointerDown)
    return () => document.removeEventListener('mousedown', onDocumentPointerDown)
  }, [exportMenuOpen])

  const getViewerTemplate = useCallback(async (): Promise<string> => {
    if (templateCacheRef.current) return templateCacheRef.current

    const response = await authenticatedFetch('/api/viewer-template')
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail?.detail || 'Failed to fetch viewer template')
    }

    const template = await response.text()
    templateCacheRef.current = template
    return template
  }, [])

  const excerptLinesForClip = useCallback((record: ViewerTranscript, clip: ClipRecord) => {
    return record.lines.filter(
      (line) => line.end >= clip.start_time - SEARCH_TOLERANCE && line.start <= clip.end_time + SEARCH_TOLERANCE,
    )
  }, [])

  const requestClipPdfBlob = useCallback(async (record: ViewerTranscript, clip: ClipRecord): Promise<Blob> => {
    const lineEntries = excerptLinesForClip(record, clip)
    if (!lineEntries.length) {
      throw new Error('No transcript lines overlap this clip range.')
    }

    const response = await authenticatedFetch('/api/format-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title_data: record.title_data,
        lines_per_page: record.lines_per_page,
        line_entries: lineEntries,
      }),
    })

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail?.detail || 'Failed to export clip PDF')
    }

    return response.blob()
  }, [excerptLinesForClip])

  const exportClipPdf = useCallback(async (clip: ClipRecord, setClipError: (msg: string) => void) => {
    if (!transcript) return
    setClipError('')
    setExporting(true)
    try {
      const record = clip.source_media_key === transcript.media_key
        ? transcript
        : (transcriptCacheRef.current[clip.source_media_key] || await getTranscriptForExport(clip.source_media_key))

      if (!record) {
        throw new Error('Unable to load transcript for clip export.')
      }

      const blob = await requestClipPdfBlob(record, clip)
      const filename = sanitizeFilename(`${clip.name || 'clip'}-${clip.clip_id}`)
      downloadBlob(blob, `${filename}.pdf`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export clip PDF'
      setClipError(message)
    } finally {
      setExporting(false)
    }
  }, [getTranscriptForExport, requestClipPdfBlob, transcript, transcriptCacheRef])

  const exportTranscriptPdf = useCallback(() => {
    if (!transcript?.pdf_base64) return
    const bytes = atob(transcript.pdf_base64)
    const array = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i += 1) {
      array[i] = bytes.charCodeAt(i)
    }
    const mediaNameRaw = transcript.title_data?.FILE_NAME || transcript.media_filename || transcript.media_key || 'transcript'
    const mediaBaseName = sanitizeDownloadStem(String(mediaNameRaw).replace(/\.[^.]+$/, ''))
    downloadBlob(new Blob([array], { type: 'application/pdf' }), `${mediaBaseName} transcript.pdf`)
  }, [transcript])

  const exportStandaloneViewer = useCallback(async (setError: (msg: string) => void) => {
    if (!transcript) return
    setExporting(true)

    try {
      const template = await getViewerTemplate()
      const payload = buildViewerPayload({
        lines: transcript.lines,
        title_data: transcript.title_data,
        audio_duration: transcript.audio_duration,
        lines_per_page: transcript.lines_per_page,
        media_filename: transcript.media_filename || transcript.title_data?.FILE_NAME,
        media_content_type: transcript.media_content_type,
      })
      const transcriptJson = escapeScriptBoundary(JSON.stringify(payload))

      const resolvedMedia = await resolveMediaFileForRecord(transcript, { requestPermission: true, skipCache: true })
      const mediaFile = resolvedMedia.file
      if (!mediaFile) {
        throw new Error(
          resolvedMedia.message || 'Media file not available. Relink media before exporting standalone viewer.',
        )
      }

      const fileSizeMb = mediaFile.size / (1024 * 1024)
      const proceed = window.confirm(
        `This export embeds the entire media file (${fileSizeMb.toFixed(1)} MB). Continue?`,
      )
      if (!proceed) return

      const mediaBase64 = await fileToBase64(mediaFile)

      let html = template.replace('__TRANSCRIPT_JSON__', transcriptJson)
      const mediaTag = `<script id="media-data" type="application/octet-stream">${mediaBase64}</script>`
      const mediaPlaceholder = '<script id="media-data" type="application/octet-stream"></script>'
      const htmlWithMedia = html.replace(mediaPlaceholder, mediaTag)
      if (htmlWithMedia === html) {
        logger.warn('Standalone viewer template is missing media placeholder script tag.')
        throw new Error('Standalone viewer template missing media placeholder; embedded media export failed.')
      }
      html = htmlWithMedia

      const blob = new Blob([html], { type: 'text/html' })
      const baseName = sanitizeFilename(transcript.title_data?.FILE_NAME || transcript.media_filename || transcript.media_key)
      downloadBlob(blob, `${baseName}-viewer.html`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export standalone viewer'
      setError(message)
    } finally {
      setExporting(false)
    }
  }, [getViewerTemplate, transcript])

  return {
    exporting,
    setExporting,
    exportMenuOpen,
    setExportMenuOpen,
    exportMenuRef,
    exportTranscriptPdf,
    exportStandaloneViewer,
    exportClipPdf,
    requestClipPdfBlob,
    excerptLinesForClip,
  }
}
