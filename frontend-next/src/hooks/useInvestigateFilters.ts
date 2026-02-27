import { useMemo, useState } from 'react'
import type { EvidenceType } from '@/lib/storage'

export interface InvestigateFilters {
  evidenceTypes: EvidenceType[]
  dateFrom: string
  dateTo: string
  speakers: string[]
  location: string
}

interface TranscriptMeta {
  media_key: string
  evidence_type?: EvidenceType
  updated_at?: string | null
  speakers?: string[]
  location?: string
}

const GENERIC_SPEAKER_PATTERN = /^Speaker\s+\d+$/i

export function useInvestigateFilters(transcripts: TranscriptMeta[]) {
  const [filters, setFilters] = useState<InvestigateFilters>({
    evidenceTypes: [],
    dateFrom: '',
    dateTo: '',
    speakers: [],
    location: '',
  })

  const availableEvidenceTypes = useMemo(() => {
    const types = new Set<EvidenceType>()
    for (const t of transcripts) {
      if (t.evidence_type) types.add(t.evidence_type)
    }
    return Array.from(types).sort()
  }, [transcripts])

  const availableSpeakers = useMemo(() => {
    const speakers = new Set<string>()
    for (const t of transcripts) {
      if (Array.isArray(t.speakers)) {
        for (const s of t.speakers) {
          if (!GENERIC_SPEAKER_PATTERN.test(s)) {
            speakers.add(s)
          }
        }
      }
    }
    return Array.from(speakers).sort()
  }, [transcripts])

  const availableLocations = useMemo(() => {
    const locations = new Set<string>()
    for (const t of transcripts) {
      if (t.location) {
        locations.add(t.location)
      }
    }
    return Array.from(locations).sort()
  }, [transcripts])

  const hasActiveFilters = useMemo(
    () =>
      filters.evidenceTypes.length > 0 ||
      !!filters.dateFrom ||
      !!filters.dateTo ||
      filters.speakers.length > 0 ||
      !!filters.location,
    [filters],
  )

  return {
    filters,
    availableEvidenceTypes,
    availableSpeakers,
    availableLocations,
    hasActiveFilters,
    setEvidenceTypes: (types: EvidenceType[]) =>
      setFilters((f) => ({ ...f, evidenceTypes: types })),
    setDateFrom: (date: string) =>
      setFilters((f) => ({ ...f, dateFrom: date })),
    setDateTo: (date: string) =>
      setFilters((f) => ({ ...f, dateTo: date })),
    setSpeakers: (speakers: string[]) =>
      setFilters((f) => ({ ...f, speakers })),
    setLocation: (location: string) =>
      setFilters((f) => ({ ...f, location })),
    clearFilters: () =>
      setFilters({
        evidenceTypes: [],
        dateFrom: '',
        dateTo: '',
        speakers: [],
        location: '',
      }),
  }
}
