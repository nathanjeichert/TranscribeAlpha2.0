import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  saveClip,
  deleteClip,
  type ClipRecord,
} from '@/lib/storage'
import { clipMedia } from '@/lib/ffmpegWorker'
import { resolveMediaFileForRecord } from '@/lib/mediaPlayback'
import {
  parseTimeInput,
  formatClock,
  sanitizeFilename,
  type ViewerTranscript,
  type ViewerLine,
} from '@/utils/transcriptFormat'
import { downloadBlob } from '@/utils/helpers'
import { guardedPush } from '@/utils/navigationGuard'
import { routes } from '@/utils/routes'

interface UseClipManagementParams {
  effectiveCaseId: string
  clips: ClipRecord[]
  transcript: ViewerTranscript | null
  duration: number
  currentMediaKey: string | null
  loadCaseArtifacts: (caseId: string) => Promise<void>
  playRange: (start: number, end: number, clipId?: string, abortRef?: React.MutableRefObject<boolean>) => Promise<void>
  nearestLineFromTime: (value: number) => ViewerLine | null
  getPlayerElement: () => HTMLMediaElement | null
  getTranscriptForExport: (mediaKey: string) => Promise<ViewerTranscript | null>
  setExporting: (v: boolean) => void
  setClipError: (msg: string) => void
  exporting: boolean
}

interface EditingClip {
  id: string
  name: string
  start: string
  end: string
}

export function useClipManagement({
  effectiveCaseId,
  clips,
  transcript,
  duration,
  currentMediaKey,
  loadCaseArtifacts,
  playRange,
  nearestLineFromTime,
  getPlayerElement,
  getTranscriptForExport,
  setExporting,
  setClipError,
  exporting,
}: UseClipManagementParams) {
  const router = useRouter()

  const [clipName, setClipName] = useState('')
  const [clipStart, setClipStart] = useState('')
  const [clipEnd, setClipEnd] = useState('')
  const [clipError, setLocalClipError] = useState('')
  const [editingClip, setEditingClip] = useState<EditingClip | null>(null)
  const [dragClipId, setDragClipId] = useState<string | null>(null)

  const emitClipError = useCallback((msg: string) => {
    setLocalClipError(msg)
    setClipError(msg)
  }, [setClipError])

  const persistClipOrder = useCallback(async (orderedVisibleClips: ClipRecord[]) => {
    if (!effectiveCaseId) return

    const orderMap = new Map<string, number>()
    orderedVisibleClips.forEach((clip, idx) => {
      orderMap.set(clip.clip_id, idx)
    })

    const updatedAll = clips.map((clip, idx) => {
      if (orderMap.has(clip.clip_id)) {
        return { ...clip, order: orderMap.get(clip.clip_id) }
      }
      const base = Number.isFinite(clip.order) ? Number(clip.order) : idx + orderedVisibleClips.length
      return { ...clip, order: base + orderedVisibleClips.length }
    })

    await Promise.all(updatedAll.map(async (clip) => {
      await saveClip(effectiveCaseId, clip)
    }))

    await loadCaseArtifacts(effectiveCaseId)
  }, [clips, effectiveCaseId, loadCaseArtifacts])

  const createClip = useCallback(async () => {
    emitClipError('')
    if (!transcript || !currentMediaKey || !effectiveCaseId) {
      emitClipError('Clips are available only for transcripts assigned to a case.')
      return
    }

    const startVal = parseTimeInput(clipStart)
    const endVal = parseTimeInput(clipEnd)

    if (startVal === null || endVal === null) {
      emitClipError('Enter valid start and end times (M:SS or H:MM:SS).')
      return
    }

    const maxDuration = duration || transcript.audio_duration || Number.MAX_SAFE_INTEGER
    const start = Math.max(0, Math.min(startVal, maxDuration))
    const end = Math.max(0, Math.min(endVal, maxDuration))

    if (end <= start) {
      emitClipError('End time must be greater than start time.')
      return
    }

    const startLine = nearestLineFromTime(start)
    const endLine = nearestLineFromTime(end)

    const maxOrder = clips.reduce((max, clip) => {
      const order = Number.isFinite(clip.order) ? Number(clip.order) : max
      return Math.max(max, order)
    }, -1)

    const clip: ClipRecord = {
      clip_id: crypto.randomUUID(),
      name: clipName.trim() || `Clip ${clips.length + 1}`,
      source_media_key: currentMediaKey,
      start_time: start,
      end_time: end,
      start_pgln: startLine ? (startLine.pgln ?? null) : null,
      end_pgln: endLine ? (endLine.pgln ?? null) : null,
      start_page: startLine ? (startLine.page ?? null) : null,
      start_line: startLine ? (startLine.line ?? null) : null,
      end_page: endLine ? (endLine.page ?? null) : null,
      end_line: endLine ? (endLine.line ?? null) : null,
      created_at: new Date().toISOString(),
      order: maxOrder + 1,
    }

    await saveClip(effectiveCaseId, clip)
    await loadCaseArtifacts(effectiveCaseId)

    setClipName('')
    setClipStart('')
    setClipEnd('')
  }, [clipEnd, clipName, clipStart, clips, currentMediaKey, duration, effectiveCaseId, emitClipError, loadCaseArtifacts, nearestLineFromTime, transcript])

  const startEditingClip = useCallback((clip: ClipRecord) => {
    setEditingClip({
      id: clip.clip_id,
      name: clip.name,
      start: formatClock(clip.start_time),
      end: formatClock(clip.end_time),
    })
  }, [])

  const saveEditedClip = useCallback(async () => {
    emitClipError('')
    if (!effectiveCaseId || !editingClip) return
    const existing = clips.find((clip) => clip.clip_id === editingClip.id)
    if (!existing) return

    const startVal = parseTimeInput(editingClip.start)
    const endVal = parseTimeInput(editingClip.end)
    if (startVal === null || endVal === null || endVal <= startVal) {
      emitClipError('Provide a valid clip range before saving.')
      return
    }

    const updated: ClipRecord = {
      ...existing,
      name: editingClip.name.trim() || existing.name,
      start_time: startVal,
      end_time: endVal,
      updated_at: new Date().toISOString(),
    }

    await saveClip(effectiveCaseId, updated)
    await loadCaseArtifacts(effectiveCaseId)
    setEditingClip(null)
  }, [clips, editingClip, effectiveCaseId, emitClipError, loadCaseArtifacts])

  const cancelEditingClip = useCallback(() => {
    setEditingClip(null)
  }, [])

  const removeClip = useCallback(async (clip: ClipRecord) => {
    emitClipError('')
    if (!effectiveCaseId) return
    if (!window.confirm(`Delete clip "${clip.name}"?`)) return
    await deleteClip(effectiveCaseId, clip.clip_id)
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, emitClipError, loadCaseArtifacts])

  const playClip = useCallback(async (clip: ClipRecord) => {
    emitClipError('')
    if (!currentMediaKey || !effectiveCaseId) return

    if (clip.source_media_key !== currentMediaKey) {
      const openOther = window.confirm('This clip belongs to another recording. Open that recording in Viewer now?')
      if (openOther) {
        guardedPush(router, routes.viewer(clip.source_media_key, effectiveCaseId))
      }
      return
    }

    await playRange(clip.start_time, clip.end_time, clip.clip_id)
  }, [currentMediaKey, effectiveCaseId, emitClipError, playRange, router])

  const reorderVisibleClips = useCallback(async (sourceClipId: string, targetClipId: string, visibleClips: ClipRecord[]) => {
    emitClipError('')
    const list = [...visibleClips]
    const fromIdx = list.findIndex((clip) => clip.clip_id === sourceClipId)
    const toIdx = list.findIndex((clip) => clip.clip_id === targetClipId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return

    const [moved] = list.splice(fromIdx, 1)
    list.splice(toIdx, 0, moved)

    await persistClipOrder(list)
  }, [emitClipError, persistClipOrder])

  const exportClipMedia = useCallback(async (clip: ClipRecord) => {
    if (!transcript) return
    emitClipError('')
    setExporting(true)
    try {
      const record = clip.source_media_key === transcript.media_key
        ? transcript
        : await getTranscriptForExport(clip.source_media_key)
      if (!record) {
        throw new Error('Unable to load transcript for clip export.')
      }

      const resolvedMedia = await resolveMediaFileForRecord(record, { requestPermission: true })
      const mediaFile = resolvedMedia.file
      if (!mediaFile) {
        throw new Error(
          resolvedMedia.message || 'Media file not available. Relink media before exporting this clip.',
        )
      }

      const clipFile = await clipMedia(mediaFile, clip.start_time, clip.end_time)
      const dotIndex = clipFile.name.lastIndexOf('.')
      const extension = dotIndex > -1 ? clipFile.name.slice(dotIndex) : ''
      const baseStem = sanitizeFilename(`${clip.name || 'clip'}-${clip.clip_id}`)
      downloadBlob(clipFile, `${baseStem}${extension}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export clip media'
      emitClipError(message)
    } finally {
      setExporting(false)
    }
  }, [emitClipError, getTranscriptForExport, setExporting, transcript])

  return {
    clipName,
    setClipName,
    clipStart,
    setClipStart,
    clipEnd,
    setClipEnd,
    clipError: clipError,
    editingClip,
    setEditingClip,
    dragClipId,
    setDragClipId,
    createClip,
    startEditingClip,
    saveEditedClip,
    cancelEditingClip,
    removeClip,
    playClip,
    reorderVisibleClips,
    persistClipOrder,
    exportClipMedia,
  }
}
