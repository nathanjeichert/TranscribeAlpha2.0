import { useCallback, useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/context/DashboardContext'
import {
  getTranscript,
  saveTranscript,
  resolveWorkspaceRelativePathForHandle,
  type TranscriptData,
} from '@/lib/storage'
import { cacheMediaForPlayback, removeMediaCacheEntry } from '@/lib/mediaCache'
import { getMediaFile, getMediaHandle, promptRelinkMedia } from '@/lib/mediaHandles'
import { resolveMediaObjectURLForRecord } from '@/lib/mediaPlayback'
import { normalizeViewerTranscript, type ViewerTranscript } from '@/utils/transcriptFormat'

interface UseViewerLoaderParams {
  queryMediaKey: string | null
}

export function useViewerLoader({ queryMediaKey }: UseViewerLoaderParams) {
  const { activeMediaKey, setActiveMediaKey } = useDashboard()

  const [currentMediaKey, setCurrentMediaKey] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<ViewerTranscript | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [mediaAvailable, setMediaAvailable] = useState(true)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaMissingMessage, setMediaMissingMessage] = useState('Media file not found.')
  const [mediaActionLabel, setMediaActionLabel] = useState('Locate File')

  const blobUrlRef = useRef<string | null>(null)
  const transcriptCacheRef = useRef<Record<string, ViewerTranscript>>({})

  const revokeMediaUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
  }, [])

  const loadMediaForTranscript = useCallback(async (record: ViewerTranscript) => {
    revokeMediaUrl()
    setMediaLoading(true)

    const resolved = await resolveMediaObjectURLForRecord(record)
    if (resolved.objectUrl) {
      blobUrlRef.current = resolved.objectUrl
      setMediaUrl(resolved.objectUrl)
      setMediaAvailable(true)
      setMediaMissingMessage('Media file not found.')
      setMediaActionLabel('Locate File')
    } else {
      setMediaUrl(null)
      setMediaAvailable(false)
      setMediaMissingMessage(
        resolved.message || 'We could not find the media file. Click Locate File to relink it.',
      )
      setMediaActionLabel(resolved.reconnectRecommended ? 'Reconnect File Access' : 'Locate File')
    }
    setMediaLoading(false)
  }, [revokeMediaUrl])

  const loadTranscriptByKey = useCallback(async (mediaKey: string, silent = false): Promise<ViewerTranscript | null> => {
    if (!silent) {
      setIsLoading(true)
      setError('')
    }

    try {
      let record = transcriptCacheRef.current[mediaKey]
      if (!record) {
        const raw = await getTranscript(mediaKey)
        if (!raw) throw new Error('Transcript not found')
        record = normalizeViewerTranscript(raw as TranscriptData, mediaKey)
        transcriptCacheRef.current[mediaKey] = record
      }

      setTranscript(record)
      setCurrentMediaKey(record.media_key)
      setActiveMediaKey(record.media_key)
      await loadMediaForTranscript(record)

      return record
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load transcript'
      setError(message)
      return null
    } finally {
      if (!silent) setIsLoading(false)
    }
  }, [loadMediaForTranscript, setActiveMediaKey])

  const getTranscriptForExport = useCallback(async (mediaKey: string): Promise<ViewerTranscript | null> => {
    const cached = transcriptCacheRef.current[mediaKey]
    if (cached) return cached
    try {
      const raw = await getTranscript(mediaKey)
      if (!raw) return null
      const normalized = normalizeViewerTranscript(raw as TranscriptData, mediaKey)
      transcriptCacheRef.current[mediaKey] = normalized
      return normalized
    } catch {
      return null
    }
  }, [])

  const relinkMedia = useCallback(async () => {
    if (!transcript) return
    const recovered = await resolveMediaObjectURLForRecord(transcript, { requestPermission: true })
    if (recovered.objectUrl) {
      let recoveredWorkspacePath: string | null = null
      if (recovered.resolvedHandleId) {
        const recoveredHandle = await getMediaHandle(recovered.resolvedHandleId)
        if (recoveredHandle) {
          recoveredWorkspacePath = await resolveWorkspaceRelativePathForHandle(recoveredHandle)
        }
      }

      const nextTranscript =
        (recovered.resolvedHandleId && recovered.resolvedHandleId !== transcript.media_handle_id) ||
        (recoveredWorkspacePath && recoveredWorkspacePath !== transcript.media_workspace_relpath)
          ? {
              ...transcript,
              media_handle_id: recovered.resolvedHandleId || transcript.media_handle_id,
              media_workspace_relpath: recoveredWorkspacePath || transcript.media_workspace_relpath,
              media_storage_mode: recoveredWorkspacePath ? 'workspace-relative' : transcript.media_storage_mode,
              playback_cache_path: recoveredWorkspacePath ? undefined : transcript.playback_cache_path,
              playback_cache_content_type: recoveredWorkspacePath ? undefined : transcript.playback_cache_content_type,
            }
          : transcript

      if (nextTranscript !== transcript) {
        if (recoveredWorkspacePath) {
          await removeMediaCacheEntry(transcript.media_key).catch(() => undefined)
        }
        const caseId = transcript.case_id && String(transcript.case_id).trim()
          ? String(transcript.case_id)
          : undefined
        await saveTranscript(transcript.media_key, nextTranscript as unknown as Record<string, unknown>, caseId)
        transcriptCacheRef.current[transcript.media_key] = nextTranscript as ViewerTranscript
        setTranscript(nextTranscript as ViewerTranscript)
      }

      await loadMediaForTranscript(nextTranscript as ViewerTranscript)
      return
    }

    const expected = transcript.media_filename || transcript.title_data?.FILE_NAME || 'media file'
    const result = await promptRelinkMedia(expected, transcript.media_key)
    if (!result) return

    const relinkedFile = await getMediaFile(result.handleId, { requestPermission: true })
    if (!relinkedFile) return
    const handle = await getMediaHandle(result.handleId)
    const workspaceRelativePath = handle ? await resolveWorkspaceRelativePathForHandle(handle) : null

    let cachePath = ''
    let cacheType = ''
    if (!workspaceRelativePath) {
      try {
        const cached = await cacheMediaForPlayback(transcript.media_key, relinkedFile, {
          filename: relinkedFile.name,
          contentType: relinkedFile.type || transcript.media_content_type || 'application/octet-stream',
        })
        cachePath = cached.path
        cacheType = cached.contentType
      } catch {
        // Ignore cache failures and rely on relinked handle.
      }
    }

    const nextTranscript: ViewerTranscript = {
      ...transcript,
      media_handle_id: transcript.media_key,
      media_filename: relinkedFile.name || transcript.media_filename,
      media_content_type: relinkedFile.type || transcript.media_content_type,
      media_storage_mode: workspaceRelativePath ? 'workspace-relative' : 'external-handle',
      media_workspace_relpath: workspaceRelativePath || undefined,
      playback_cache_path: cachePath || transcript.playback_cache_path,
      playback_cache_content_type: cacheType || transcript.playback_cache_content_type,
    }
    if (workspaceRelativePath) {
      delete nextTranscript.playback_cache_path
      delete nextTranscript.playback_cache_content_type
      await removeMediaCacheEntry(transcript.media_key).catch(() => undefined)
    }

    const caseId = transcript.case_id && String(transcript.case_id).trim()
      ? String(transcript.case_id)
      : undefined

    await saveTranscript(transcript.media_key, nextTranscript as unknown as Record<string, unknown>, caseId)
    transcriptCacheRef.current[transcript.media_key] = nextTranscript
    setTranscript(nextTranscript)
    await loadMediaForTranscript(nextTranscript)
  }, [loadMediaForTranscript, transcript])

  // Resolve initial media key from URL param or dashboard context
  useEffect(() => {
    if (queryMediaKey) {
      setCurrentMediaKey(queryMediaKey)
      return
    }
    if (activeMediaKey) {
      setCurrentMediaKey(activeMediaKey)
    }
  }, [queryMediaKey, activeMediaKey])

  // Load transcript whenever currentMediaKey changes
  useEffect(() => {
    if (!currentMediaKey) {
      setIsLoading(false)
      return
    }
    void loadTranscriptByKey(currentMediaKey)
  }, [currentMediaKey, loadTranscriptByKey])

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      revokeMediaUrl()
    }
  }, [revokeMediaUrl])

  return {
    transcript,
    isLoading,
    error,
    setError,
    currentMediaKey,
    setCurrentMediaKey,
    mediaUrl,
    mediaAvailable,
    mediaLoading,
    mediaMissingMessage,
    mediaActionLabel,
    transcriptCacheRef,
    loadTranscriptByKey,
    getTranscriptForExport,
    relinkMedia,
    revokeMediaUrl,
  }
}
