import { useCallback, useState } from 'react'
import {
  deleteTranscript as localDeleteTranscript,
  moveTranscriptToCase as localMoveTranscriptToCase,
} from '@/lib/storage'

export interface TranscriptActionItem {
  media_key: string
  title_label: string
}

/**
 * Shared state + handlers for deleting and reassigning transcripts.
 * Used by both cases/page.tsx (uncategorized list) and case-detail/page.tsx.
 */
export function useTranscriptActions(onMutate: () => Promise<void>) {
  // ---- delete flow ----
  const [deleteTarget, setDeleteTarget] = useState<TranscriptActionItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await localDeleteTranscript(deleteTarget.media_key)
      setDeleteTarget(null)
      await onMutate()
    } finally {
      setIsDeleting(false)
    }
  }, [deleteTarget, onMutate])

  // ---- assign / reassign flow ----
  const [assignTargets, setAssignTargets] = useState<Record<string, string>>({})
  const [assigningKey, setAssigningKey] = useState<string | null>(null)

  const getAssignTarget = useCallback(
    (mediaKey: string, fallback: string) => assignTargets[mediaKey] ?? fallback,
    [assignTargets],
  )

  const updateAssignTarget = useCallback((mediaKey: string, caseId: string) => {
    setAssignTargets((prev) => ({ ...prev, [mediaKey]: caseId }))
  }, [])

  const resetAssignment = useCallback(() => {
    setAssignTargets({})
    setAssigningKey(null)
  }, [])

  const confirmAssign = useCallback(
    async (mediaKey: string, targetCaseId: string) => {
      if (!targetCaseId) return
      setAssigningKey(mediaKey)
      try {
        await localMoveTranscriptToCase(mediaKey, targetCaseId)
        await onMutate()
      } finally {
        setAssigningKey(null)
      }
    },
    [onMutate],
  )

  return {
    // delete
    deleteTarget,
    isDeleting,
    setDeleteTarget,
    confirmDelete,
    // assign
    assignTargets,
    assigningKey,
    getAssignTarget,
    updateAssignTarget,
    resetAssignment,
    confirmAssign,
  }
}
