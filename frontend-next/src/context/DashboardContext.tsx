'use client'

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react'
import { authenticatedFetch } from '@/utils/auth'
import {
  listCases as localListCases,
  listUncategorizedTranscripts as localListUncategorized,
  listTranscriptsInCase,
  type TranscriptSummary,
} from '@/lib/storage'

interface CaseMeta {
  case_id: string
  name: string
  description?: string
  created_at: string
  updated_at: string
  transcript_count: number
}

interface TranscriptListItem {
  media_key: string
  title_label: string
  updated_at?: string | null
  line_count?: number
  expires_at?: string | null
}

interface DashboardContextValue {
  // Cases
  cases: CaseMeta[]
  uncategorizedCount: number
  casesLoading: boolean
  refreshCases: () => Promise<void>

  // Recent transcripts (for sidebar)
  recentTranscripts: TranscriptListItem[]
  recentLoading: boolean
  refreshRecentTranscripts: () => Promise<void>

  // Current session state
  activeMediaKey: string | null
  setActiveMediaKey: (key: string | null) => void

  // App variant
  appVariant: 'oncue' | 'criminal'
  variantResolved: boolean
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [cases, setCases] = useState<CaseMeta[]>([])
  const [uncategorizedCount, setUncategorizedCount] = useState(0)
  const [casesLoading, setCasesLoading] = useState(true)

  const [recentTranscripts, setRecentTranscripts] = useState<TranscriptListItem[]>([])
  const [recentLoading, setRecentLoading] = useState(true)

  const [activeMediaKey, setActiveMediaKey] = useState<string | null>(null)
  const [appVariant, setAppVariant] = useState<'oncue' | 'criminal'>('oncue')
  const [variantResolved, setVariantResolved] = useState(false)

  // Fetch app config
  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.variant === 'criminal' || data.variant === 'oncue') {
          setAppVariant(data.variant)
        }
        setVariantResolved(true)
      })
      .catch(() => {
        setAppVariant('oncue')
        setVariantResolved(true)
      })
  }, [])

  // Load active media key from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('active_media_key')
    if (stored) {
      setActiveMediaKey(stored)
    }
  }, [])

  // Save active media key to localStorage
  useEffect(() => {
    if (activeMediaKey) {
      localStorage.setItem('active_media_key', activeMediaKey)
    } else {
      localStorage.removeItem('active_media_key')
    }
  }, [activeMediaKey])

  const refreshCases = useCallback(async () => {
    setCasesLoading(true)
    try {
      if (appVariant === 'criminal') {
        const localCases = await localListCases()
        setCases(localCases)
        const uncategorized = await localListUncategorized()
        setUncategorizedCount(uncategorized.length)
      } else {
        const response = await authenticatedFetch('/api/cases')
        if (response.ok) {
          const data = await response.json()
          setCases(data.cases || [])
          setUncategorizedCount(data.uncategorized_count || 0)
        }
      }
    } catch (err) {
      console.error('Failed to fetch cases:', err)
    } finally {
      setCasesLoading(false)
    }
  }, [appVariant])

  const refreshRecentTranscripts = useCallback(async () => {
    setRecentLoading(true)
    try {
      if (appVariant === 'criminal') {
        // Aggregate from all cases + uncategorized
        const allTranscripts: TranscriptSummary[] = []
        const localCases = await localListCases()
        for (const c of localCases) {
          const caseTranscripts = await listTranscriptsInCase(c.case_id)
          allTranscripts.push(...caseTranscripts)
        }
        const uncategorized = await localListUncategorized()
        allTranscripts.push(...uncategorized)
        // Sort by updated_at desc and take 5
        allTranscripts.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
        setRecentTranscripts(
          allTranscripts.slice(0, 5).map((t) => ({
            media_key: t.media_key,
            title_label: t.title_label,
            updated_at: t.updated_at,
            line_count: t.line_count,
          })),
        )
      } else {
        const response = await authenticatedFetch('/api/transcripts')
        if (response.ok) {
          const data = await response.json()
          // Get most recent 5 for sidebar
          setRecentTranscripts((data.transcripts || []).slice(0, 5))
        }
      }
    } catch (err) {
      console.error('Failed to fetch transcripts:', err)
    } finally {
      setRecentLoading(false)
    }
  }, [appVariant])

  // Initial load - only after variant is resolved
  useEffect(() => {
    if (!variantResolved) return
    refreshCases()
    refreshRecentTranscripts()
  }, [variantResolved, refreshCases, refreshRecentTranscripts])

  return (
    <DashboardContext.Provider
      value={{
        cases,
        uncategorizedCount,
        casesLoading,
        refreshCases,
        recentTranscripts,
        recentLoading,
        refreshRecentTranscripts,
        activeMediaKey,
        setActiveMediaKey,
        appVariant,
        variantResolved,
      }}
    >
      {children}
    </DashboardContext.Provider>
  )
}

export function useDashboard() {
  const context = useContext(DashboardContext)
  if (!context) {
    throw new Error('useDashboard must be used within a DashboardProvider')
  }
  return context
}
