import { useCallback, useEffect, useState } from 'react'
import {
  listCaseClips,
  listCaseSequences,
  type ClipRecord,
  type ClipSequenceRecord,
} from '@/lib/storage'

interface UseCaseArtifactsParams {
  effectiveCaseId: string
}

export function useCaseArtifacts({ effectiveCaseId }: UseCaseArtifactsParams) {
  const [clips, setClips] = useState<ClipRecord[]>([])
  const [sequences, setSequences] = useState<ClipSequenceRecord[]>([])
  const [clipsLoading, setClipsLoading] = useState(false)

  const loadCaseArtifacts = useCallback(async (caseId: string) => {
    setClipsLoading(true)
    try {
      const [caseClips, caseSequences] = await Promise.all([
        listCaseClips(caseId),
        listCaseSequences(caseId),
      ])
      setClips(caseClips)
      setSequences(caseSequences)
    } finally {
      setClipsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!effectiveCaseId) {
      setClips([])
      setSequences([])
      return
    }
    void loadCaseArtifacts(effectiveCaseId)
  }, [effectiveCaseId, loadCaseArtifacts])

  return {
    clips,
    sequences,
    clipsLoading,
    loadCaseArtifacts,
  }
}
