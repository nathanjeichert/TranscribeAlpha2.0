import { useCallback, useEffect, useState } from 'react'
import {
  saveSequence,
  deleteSequence,
  type ClipRecord,
  type ClipSequenceEntry,
  type ClipSequenceRecord,
} from '@/lib/storage'
import { clipMediaBatch, type ClipBatchRequest } from '@/lib/ffmpegWorker'
import { resolveMediaFileForRecord } from '@/lib/mediaPlayback'
import { sanitizeFilename, type ViewerTranscript } from '@/utils/transcriptFormat'
import { downloadBlob } from '@/utils/helpers'
import JSZip from 'jszip'

interface UseSequenceManagementParams {
  effectiveCaseId: string
  clips: ClipRecord[]
  sequences: ClipSequenceRecord[]
  loadCaseArtifacts: (caseId: string) => Promise<void>
  getTranscriptForExport: (mediaKey: string) => Promise<ViewerTranscript | null>
  requestClipPdfBlob: (record: ViewerTranscript, clip: ClipRecord) => Promise<Blob>
  setExporting: (v: boolean) => void
  exporting: boolean
}

export function useSequenceManagement({
  effectiveCaseId,
  clips,
  sequences,
  loadCaseArtifacts,
  getTranscriptForExport,
  requestClipPdfBlob,
  setExporting,
  exporting,
}: UseSequenceManagementParams) {
  const [newSequenceName, setNewSequenceName] = useState('')
  const [selectedSequenceId, setSelectedSequenceId] = useState<string | null>(null)
  const [sequenceNameDrafts, setSequenceNameDrafts] = useState<Record<string, string>>({})
  const [sequenceError, setSequenceError] = useState('')
  const [sequenceExportStatus, setSequenceExportStatus] = useState('')

  // Keep sequence name drafts in sync when sequences change
  useEffect(() => {
    setSequenceNameDrafts((prev) => {
      const next: Record<string, string> = {}
      sequences.forEach((sequence) => {
        next[sequence.sequence_id] = prev[sequence.sequence_id] ?? sequence.name
      })
      return next
    })
  }, [sequences])

  const createSequence = useCallback(async () => {
    setSequenceError('')
    if (!effectiveCaseId) {
      setSequenceError('Sequences are available only for case transcripts.')
      return
    }

    const name = newSequenceName.trim() || `Sequence ${sequences.length + 1}`
    const now = new Date().toISOString()

    const sequence: ClipSequenceRecord = {
      sequence_id: crypto.randomUUID(),
      name,
      created_at: now,
      updated_at: now,
      entries: [],
    }

    await saveSequence(effectiveCaseId, sequence)
    await loadCaseArtifacts(effectiveCaseId)
    setNewSequenceName('')
    setSelectedSequenceId(sequence.sequence_id)
  }, [effectiveCaseId, loadCaseArtifacts, newSequenceName, sequences.length])

  const removeSequence = useCallback(async (sequence: ClipSequenceRecord) => {
    if (!effectiveCaseId) return
    if (!window.confirm(`Delete sequence "${sequence.name}"?`)) return
    await deleteSequence(effectiveCaseId, sequence.sequence_id)
    await loadCaseArtifacts(effectiveCaseId)
    if (selectedSequenceId === sequence.sequence_id) {
      setSelectedSequenceId(null)
    }
  }, [effectiveCaseId, loadCaseArtifacts, selectedSequenceId])

  const renameSequence = useCallback(async (sequence: ClipSequenceRecord, nextName: string) => {
    if (!effectiveCaseId) return
    const trimmed = nextName.trim()
    if (!trimmed) return

    const updated: ClipSequenceRecord = {
      ...sequence,
      name: trimmed,
      updated_at: new Date().toISOString(),
    }

    await saveSequence(effectiveCaseId, updated)
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

  const commitSequenceRename = useCallback(async (sequence: ClipSequenceRecord) => {
    const draftName = sequenceNameDrafts[sequence.sequence_id] ?? sequence.name
    const trimmed = draftName.trim()
    if (!trimmed) {
      setSequenceNameDrafts((prev) => ({ ...prev, [sequence.sequence_id]: sequence.name }))
      return
    }
    if (trimmed === sequence.name) return
    await renameSequence(sequence, trimmed)
  }, [renameSequence, sequenceNameDrafts])

  const addClipToSequence = useCallback(async (sequence: ClipSequenceRecord, clipId: string) => {
    if (!effectiveCaseId) return
    const clip = clips.find((item) => item.clip_id === clipId)
    if (!clip) return

    const nextEntries: ClipSequenceEntry[] = [
      ...sequence.entries,
      {
        clip_id: clip.clip_id,
        source_media_key: clip.source_media_key,
        order: sequence.entries.length,
      },
    ]

    await saveSequence(effectiveCaseId, {
      ...sequence,
      entries: nextEntries,
      updated_at: new Date().toISOString(),
    })
    await loadCaseArtifacts(effectiveCaseId)
  }, [clips, effectiveCaseId, loadCaseArtifacts])

  const removeSequenceEntry = useCallback(async (sequence: ClipSequenceRecord, index: number) => {
    if (!effectiveCaseId) return

    const nextEntries = sequence.entries
      .filter((_, idx) => idx !== index)
      .map((entry, idx) => ({ ...entry, order: idx }))

    await saveSequence(effectiveCaseId, {
      ...sequence,
      entries: nextEntries,
      updated_at: new Date().toISOString(),
    })
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

  const moveSequenceEntry = useCallback(async (sequence: ClipSequenceRecord, from: number, to: number) => {
    if (!effectiveCaseId) return
    if (to < 0 || to >= sequence.entries.length) return

    const next = [...sequence.entries]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)

    const normalized = next.map((entry, idx) => ({ ...entry, order: idx }))
    await saveSequence(effectiveCaseId, {
      ...sequence,
      entries: normalized,
      updated_at: new Date().toISOString(),
    })
    await loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

  const exportSequenceZip = useCallback(async (sequence: ClipSequenceRecord) => {
    setExporting(true)
    setSequenceError('')
    setSequenceExportStatus('')

    try {
      const zip = new JSZip()
      const rootFolder = zip.folder(sanitizeFilename(sequence.name))
      if (!rootFolder) throw new Error('Failed to initialize zip output')
      const pdfFolder = rootFolder.folder('pdf')
      const mediaFolder = rootFolder.folder('media')
      if (!pdfFolder || !mediaFolder) throw new Error('Failed to initialize zip output folders')

      const orderedEntries = [...sequence.entries].sort((a, b) => a.order - b.order)
      const exportItems: Array<{
        entry: ClipSequenceEntry
        clip: ClipRecord
        orderToken: string
        baseName: string
      }> = []
      for (const entry of orderedEntries) {
        const clip = clips.find((item) => item.clip_id === entry.clip_id)
        if (!clip) continue
        const orderToken = String(exportItems.length + 1).padStart(2, '0')
        exportItems.push({
          entry,
          clip,
          orderToken,
          baseName: sanitizeFilename(clip.name || `clip-${clip.clip_id}`),
        })
      }

      if (!exportItems.length) {
        throw new Error('No clips available for sequence export.')
      }

      const transcriptBySource = new Map<string, ViewerTranscript>()
      setSequenceExportStatus(`Exporting clip PDFs 0/${exportItems.length}...`)

      for (let index = 0; index < exportItems.length; index += 1) {
        const item = exportItems[index]
        let transcriptRecord = transcriptBySource.get(item.entry.source_media_key)
        if (!transcriptRecord) {
          transcriptRecord = await getTranscriptForExport(item.entry.source_media_key) || undefined
          if (!transcriptRecord) {
            throw new Error(`Unable to load transcript for clip "${item.clip.name}".`)
          }
          transcriptBySource.set(item.entry.source_media_key, transcriptRecord)
        }
        const pdfBlob = await requestClipPdfBlob(transcriptRecord, item.clip)
        pdfFolder.file(`${item.orderToken}-${item.baseName}.pdf`, pdfBlob)
        setSequenceExportStatus(`Exporting clip PDFs ${index + 1}/${exportItems.length}...`)
      }

      const itemsBySource = new Map<string, typeof exportItems>()
      exportItems.forEach((item) => {
        const existing = itemsBySource.get(item.entry.source_media_key)
        if (existing) {
          existing.push(item)
          return
        }
        itemsBySource.set(item.entry.source_media_key, [item])
      })

      let mediaCompleted = 0
      setSequenceExportStatus(`Exporting media clips 0/${exportItems.length}...`)

      for (const [sourceMediaKey, sourceItems] of Array.from(itemsBySource.entries())) {
        const transcriptRecord = transcriptBySource.get(sourceMediaKey)
        if (!transcriptRecord) {
          throw new Error(`Unable to load transcript for "${sourceMediaKey}".`)
        }
        const resolvedMedia = await resolveMediaFileForRecord(transcriptRecord, { requestPermission: true })
        const mediaFile = resolvedMedia.file
        if (!mediaFile) {
          throw new Error(
            resolvedMedia.message || `Media file not available for "${sourceMediaKey}". Relink media before sequence export.`,
          )
        }

        const batchRequests: ClipBatchRequest[] = sourceItems.map((item) => ({
          id: item.orderToken,
          startTime: item.clip.start_time,
          endTime: item.clip.end_time,
          downloadStem: `${item.orderToken}-${item.baseName}`,
        }))

        const batchClips = await clipMediaBatch(mediaFile, batchRequests, (progress) => {
          const completedNow = mediaCompleted + progress.completed
          setSequenceExportStatus(`Exporting media clips ${completedNow}/${exportItems.length}...`)
        })

        batchRequests.forEach((request) => {
          const clipFile = batchClips.get(request.id)
          if (!clipFile) {
            throw new Error(`Failed to export media clip ${request.id}.`)
          }
          mediaFolder.file(clipFile.name, clipFile)
        })

        mediaCompleted += sourceItems.length
        setSequenceExportStatus(`Exporting media clips ${mediaCompleted}/${exportItems.length}...`)
      }

      setSequenceExportStatus('Building ZIP archive...')
      const output = await zip.generateAsync({ type: 'blob', streamFiles: true })
      downloadBlob(output, `${sanitizeFilename(sequence.name)}.zip`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export sequence zip'
      setSequenceError(message)
    } finally {
      setSequenceExportStatus('')
      setExporting(false)
    }
  }, [clips, getTranscriptForExport, requestClipPdfBlob, setExporting])

  return {
    newSequenceName,
    setNewSequenceName,
    selectedSequenceId,
    setSelectedSequenceId,
    sequenceNameDrafts,
    setSequenceNameDrafts,
    sequenceError,
    setSequenceError,
    sequenceExportStatus,
    createSequence,
    removeSequence,
    renameSequence,
    commitSequenceRename,
    addClipToSequence,
    removeSequenceEntry,
    moveSequenceEntry,
    exportSequenceZip,
  }
}
