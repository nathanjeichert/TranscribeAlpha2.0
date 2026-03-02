import React, { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedFetch } from '@/utils/auth'
import { saveTranscript as localSaveTranscript } from '@/lib/storage'
import { getMediaFile } from '@/lib/mediaHandles'
import { escapeScriptBoundary, sanitizeDownloadStem, buildViewerPayload } from '@/utils/transcriptFormat'
import { bytesToBase64, utf8ToBase64 } from '@/utils/helpers'
import { EditorLine, EditorSaveResponse, EditorSessionResponse } from '../editorTypes'
import { normalizeLineEntriesForArtifacts, buildOncueXmlFromLineEntries } from '../editorUtils'

interface UseEditorSaveParams {
  activeMediaKey: string | null
  setActiveMediaKey: (key: string | null) => void
  sessionMetaRef: React.MutableRefObject<EditorSessionResponse | null>
  linesRef: React.MutableRefObject<EditorLine[]>
  isDirtyRef: React.MutableRefObject<boolean>
  effectiveMediaType: string | undefined
  setLines: React.Dispatch<React.SetStateAction<EditorLine[]>>
  setSessionMeta: React.Dispatch<React.SetStateAction<EditorSessionResponse | null>>
  setIsDirty: (v: boolean) => void
  setEditingField: (v: null) => void
  resetHistory: () => void
  skipSyncEffectResetRef: React.MutableRefObject<boolean>
  materializeLinesForSave: () => EditorLine[]
  pushHistory: (snapshot: EditorLine[]) => void
  oncueXmlEnabled: boolean
  buildFilename: (base: string, ext: string) => string
  onDownload: (base64: string, filename: string, mime: string) => void
  onSessionChange: (session: EditorSessionResponse) => void
  onSaveComplete: (result: EditorSaveResponse) => void
  hasPendingInlineEdit: boolean
  isDirty: boolean
  pdfData: string
  xmlBase64: string | null | undefined
  viewerHtmlBase64: string | null | undefined
}

export function useEditorSave({
  activeMediaKey,
  setActiveMediaKey,
  sessionMetaRef,
  linesRef,
  isDirtyRef,
  effectiveMediaType,
  setLines,
  setSessionMeta,
  setIsDirty,
  setEditingField,
  resetHistory,
  skipSyncEffectResetRef,
  materializeLinesForSave,
  pushHistory,
  oncueXmlEnabled: _oncueXmlEnabled,
  buildFilename,
  onDownload,
  onSessionChange,
  onSaveComplete,
  hasPendingInlineEdit,
  isDirty,
  pdfData,
  xmlBase64,
  viewerHtmlBase64,
}: UseEditorSaveParams) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [isResyncing, setIsResyncing] = useState(false)
  const [resyncError, setResyncError] = useState<string | null>(null)

  const viewerTemplateCacheRef = useRef<string | null>(null)
  const lastSnapshotRef = useRef<number>(0)

  // Auto-save interval — only resets when activeMediaKey changes
  useEffect(() => {
    if (!activeMediaKey) return

    const interval = setInterval(async () => {
      if (!isDirtyRef.current) return
      const currentSessionMeta = sessionMetaRef.current
      if (!currentSessionMeta) return

      try {
        const now = Date.now()
        if (now - lastSnapshotRef.current < 5000) return

        const caseId = (currentSessionMeta as unknown as Record<string, unknown>).case_id
        const dataToSave = {
          ...currentSessionMeta,
          lines: linesRef.current,
          updated_at: new Date().toISOString(),
        }
        await localSaveTranscript(
          activeMediaKey,
          dataToSave as unknown as Record<string, unknown>,
          typeof caseId === 'string' && caseId ? caseId : undefined,
        )

        lastSnapshotRef.current = now
        setSnapshotError(null)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Auto-save failed'
        setSnapshotError(msg)
      }
    }, 60000)

    return () => clearInterval(interval)
  }, [activeMediaKey, isDirtyRef, linesRef, sessionMetaRef])

  const getViewerTemplate = useCallback(async () => {
    if (viewerTemplateCacheRef.current) return viewerTemplateCacheRef.current
    const response = await authenticatedFetch('/api/viewer-template')
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail?.detail || 'Failed to fetch viewer template')
    }
    const template = await response.text()
    viewerTemplateCacheRef.current = template
    return template
  }, [])

  const buildLocalArtifacts = useCallback(
    async (
      sourceLines: EditorLine[],
      sourceSessionMeta: EditorSessionResponse,
      mediaKeyForSave: string,
    ): Promise<{ lineEntries: EditorLine[]; pdfBase64: string; viewerHtmlBase64: string; oncueXmlBase64: string }> => {
      const linesPerPage = sourceSessionMeta.lines_per_page ?? 25
      const titleData = sourceSessionMeta.title_data ?? {}
      const lineEntries = normalizeLineEntriesForArtifacts(sourceLines, linesPerPage)

      const pdfResponse = await authenticatedFetch('/api/format-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title_data: titleData,
          line_entries: lineEntries,
          lines_per_page: linesPerPage,
        }),
      })
      if (!pdfResponse.ok) {
        const detail = await pdfResponse.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to regenerate PDF')
      }
      const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer())
      const pdfBase64 = bytesToBase64(pdfBytes)

      const template = await getViewerTemplate()
      const mediaContentType = sourceSessionMeta.media_content_type || effectiveMediaType || 'video/mp4'
      const mediaFilename =
        sourceSessionMeta.media_filename ||
        sourceSessionMeta.media_blob_name ||
        sourceSessionMeta.title_data?.FILE_NAME ||
        `${mediaKeyForSave}.${mediaContentType.startsWith('audio/') ? 'wav' : 'mp4'}`
      const viewerPayload = buildViewerPayload({
        lines: lineEntries,
        title_data: titleData,
        audio_duration: sourceSessionMeta.audio_duration ?? 0,
        lines_per_page: linesPerPage,
        media_filename: mediaFilename,
        media_content_type: mediaContentType,
      })
      const transcriptJson = escapeScriptBoundary(JSON.stringify(viewerPayload))
      const viewerHtml = template.replace('__TRANSCRIPT_JSON__', transcriptJson)
      if (viewerHtml === template) {
        throw new Error('Standalone viewer template missing transcript placeholder')
      }
      const viewerHtmlBase64 = utf8ToBase64(viewerHtml)
      const oncueXml = buildOncueXmlFromLineEntries(
        lineEntries,
        titleData,
        sourceSessionMeta.audio_duration ?? 0,
        linesPerPage,
      )
      const oncueXmlBase64 = utf8ToBase64(oncueXml)
      return { lineEntries, pdfBase64, viewerHtmlBase64, oncueXmlBase64 }
    },
    [effectiveMediaType, getViewerTemplate],
  )

  const refreshArtifacts = useCallback(async (): Promise<EditorSaveResponse | null> => {
    const sessionMeta = sessionMetaRef.current
    if (!activeMediaKey || !sessionMeta) return null
    setSaving(true)
    setError(null)
    try {
      const artifacts = await buildLocalArtifacts(linesRef.current, sessionMeta, activeMediaKey)
      const caseId = (sessionMeta as unknown as Record<string, unknown>).case_id
      const refreshedData: EditorSaveResponse = {
        ...sessionMeta,
        lines: artifacts.lineEntries,
        pdf_base64: artifacts.pdfBase64,
        viewer_html_base64: artifacts.viewerHtmlBase64,
        oncue_xml_base64: artifacts.oncueXmlBase64,
        updated_at: new Date().toISOString(),
      }
      await localSaveTranscript(
        activeMediaKey,
        refreshedData as unknown as Record<string, unknown>,
        typeof caseId === 'string' && caseId ? caseId : undefined,
      )
      setSessionMeta(refreshedData)
      setLines(refreshedData.lines || [])
      setIsDirty(false)
      onSessionChange(refreshedData)
      onSaveComplete(refreshedData)
      return refreshedData
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to refresh exports'
      setError(msg)
      return null
    } finally {
      setSaving(false)
    }
  }, [activeMediaKey, buildLocalArtifacts, linesRef, onSaveComplete, onSessionChange, sessionMetaRef, setIsDirty, setLines, setSessionMeta])

  const handleSave = useCallback(async (): Promise<EditorSaveResponse | null> => {
    const sessionMeta = sessionMetaRef.current
    if (!activeMediaKey) {
      setError('No media key available to save.')
      return null
    }
    if (!sessionMeta) {
      setError('No transcript available to save.')
      return null
    }

    setSaving(true)
    setError(null)

    try {
      const linesToSave = materializeLinesForSave()
      const artifacts = await buildLocalArtifacts(linesToSave, sessionMeta, activeMediaKey)
      const caseId = (sessionMeta as unknown as Record<string, unknown>).case_id
      const data: EditorSaveResponse = {
        ...sessionMeta,
        lines: artifacts.lineEntries,
        pdf_base64: artifacts.pdfBase64,
        viewer_html_base64: artifacts.viewerHtmlBase64,
        oncue_xml_base64: artifacts.oncueXmlBase64,
        title_data: sessionMeta?.title_data ?? {},
        audio_duration: sessionMeta?.audio_duration ?? 0,
        lines_per_page: sessionMeta?.lines_per_page ?? 25,
        updated_at: new Date().toISOString(),
      }
      await localSaveTranscript(
        activeMediaKey,
        data as unknown as Record<string, unknown>,
        typeof caseId === 'string' && caseId ? caseId : undefined,
      )

      setSessionMeta(data)
      setLines(data.lines || artifacts.lineEntries)
      setActiveMediaKey(data.media_key ?? activeMediaKey)
      setIsDirty(false)
      setEditingField(null)
      resetHistory()

      onSaveComplete(data)
      onSessionChange(data)

      return data
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save'
      setError(msg)
      return null
    } finally {
      setSaving(false)
    }
  }, [
    activeMediaKey,
    buildLocalArtifacts,
    materializeLinesForSave,
    onSaveComplete,
    onSessionChange,
    resetHistory,
    sessionMetaRef,
    setActiveMediaKey,
    setEditingField,
    setIsDirty,
    setLines,
    setSessionMeta,
  ])

  const handleDownloadPdf = useCallback(async () => {
    const canSave = isDirty || hasPendingInlineEdit
    const saved = canSave ? await handleSave() : await refreshArtifacts()
    const pdfToDownload = saved?.pdf_base64 ?? pdfData

    if (!pdfToDownload) {
      setError('PDF export is not available for this transcript.')
      return
    }

    const sessionMeta = sessionMetaRef.current
    const mediaNameRaw = sessionMeta?.title_data?.FILE_NAME || sessionMeta?.media_filename || activeMediaKey || 'transcript'
    const mediaBaseName = sanitizeDownloadStem(String(mediaNameRaw).replace(/\.[^.]+$/, ''))
    onDownload(pdfToDownload, `${mediaBaseName} transcript.pdf`, 'application/pdf')
  }, [activeMediaKey, handleSave, hasPendingInlineEdit, isDirty, onDownload, pdfData, refreshArtifacts, sessionMetaRef])

  const handleDownloadViewer = useCallback(async () => {
    const canSave = isDirty || hasPendingInlineEdit
    const saved = canSave ? await handleSave() : await refreshArtifacts()
    const sessionMeta = sessionMetaRef.current
    const htmlData = saved?.viewer_html_base64 ?? viewerHtmlBase64 ?? sessionMeta?.viewer_html_base64 ?? ''
    if (!htmlData) {
      setError('HTML viewer export is not available for this transcript.')
      return
    }
    const mediaBaseName = (sessionMeta?.title_data?.FILE_NAME || activeMediaKey || 'transcript')?.replace(/\.[^.]+$/, '')
    onDownload(htmlData, buildFilename(mediaBaseName + ' transcript', '.html'), 'text/html')
  }, [
    activeMediaKey,
    buildFilename,
    handleSave,
    hasPendingInlineEdit,
    isDirty,
    onDownload,
    refreshArtifacts,
    sessionMetaRef,
    viewerHtmlBase64,
  ])

  const handleDownloadXml = useCallback(async () => {
    const canSave = isDirty || hasPendingInlineEdit
    const saved = canSave ? await handleSave() : await refreshArtifacts()
    const sessionMeta = sessionMetaRef.current
    const xmlToDownload = saved?.oncue_xml_base64 ?? xmlBase64 ?? sessionMeta?.oncue_xml_base64 ?? ''
    if (!xmlToDownload) {
      setError('XML export is not available for this transcript.')
      return
    }
    const mediaNameRaw = sessionMeta?.title_data?.FILE_NAME || sessionMeta?.media_filename || activeMediaKey || 'transcript'
    const mediaBaseName = sanitizeDownloadStem(String(mediaNameRaw).replace(/\.[^.]+$/, ''))
    onDownload(xmlToDownload, `${mediaBaseName} transcript.xml`, 'application/xml')
  }, [
    activeMediaKey,
    handleSave,
    hasPendingInlineEdit,
    isDirty,
    onDownload,
    refreshArtifacts,
    sessionMetaRef,
    xmlBase64,
  ])

  const handleResync = useCallback(async (lines: EditorLine[]) => {
    const sessionMeta = sessionMetaRef.current
    if (!activeMediaKey) {
      setResyncError('No active transcript to re-sync.')
      return
    }

    if (!confirm('This will update timestamps to match the media. Text stays the same. Continue?')) {
      return
    }

    setIsResyncing(true)
    setResyncError(null)

    try {
      const mediaSourceId = sessionMeta?.media_handle_id || activeMediaKey
      const mediaFile = await getMediaFile(mediaSourceId)
      if (!mediaFile) {
        throw new Error('Media file not available. Please relink the media file first.')
      }
      const transcriptPayload = {
        media_key: activeMediaKey,
        lines,
        audio_duration: sessionMeta?.audio_duration ?? 0,
        title_data: sessionMeta?.title_data ?? {},
        lines_per_page: sessionMeta?.lines_per_page ?? 25,
        source_turns: sessionMeta?.source_turns,
      }
      const formData = new FormData()
      formData.append('media_file', mediaFile)
      formData.append('transcript_data', JSON.stringify(transcriptPayload))
      const response = await authenticatedFetch('/api/resync', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Re-sync failed')
      }
      const data = await response.json() as Record<string, unknown>

      if (data.lines) {
        pushHistory(lines)
        setLines(data.lines as EditorLine[])
        setIsDirty(true)
      }

      setSessionMeta((prev: EditorSessionResponse | null) => prev ? {
        ...prev,
        lines: (data.lines as EditorLine[] | undefined) ?? prev.lines,
        pdf_base64: (data.pdf_base64 as string | undefined) ?? prev.pdf_base64,
        oncue_xml_base64: (data.oncue_xml_base64 as string | undefined) ?? prev.oncue_xml_base64,
        viewer_html_base64: (data.viewer_html_base64 as string | undefined) ?? prev.viewer_html_base64,
      } : prev)

      if (sessionMeta) {
        skipSyncEffectResetRef.current = true
        onSessionChange({
          ...sessionMeta,
          lines: (data.lines as EditorLine[] | undefined) ?? sessionMeta.lines,
          pdf_base64: (data.pdf_base64 as string | undefined) ?? sessionMeta.pdf_base64,
          oncue_xml_base64: (data.oncue_xml_base64 as string | undefined) ?? sessionMeta.oncue_xml_base64,
          viewer_html_base64: (data.viewer_html_base64 as string | undefined) ?? sessionMeta.viewer_html_base64,
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Re-sync failed'
      setResyncError(msg)
    } finally {
      setIsResyncing(false)
    }
  }, [
    activeMediaKey,
    onSessionChange,
    pushHistory,
    sessionMetaRef,
    setIsDirty,
    setLines,
    setSessionMeta,
    skipSyncEffectResetRef,
  ])

  return {
    saving,
    error,
    setError,
    snapshotError,
    isResyncing,
    resyncError,
    handleSave,
    refreshArtifacts,
    handleDownloadPdf,
    handleDownloadViewer,
    handleDownloadXml,
    handleResync,
  }
}
