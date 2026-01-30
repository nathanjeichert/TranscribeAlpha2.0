'use client'

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react'
import { authenticatedFetch } from '@/utils/auth'

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

  // Fetch app config
  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.variant === 'criminal' || data.variant === 'oncue') {
          setAppVariant(data.variant)
        }
      })
      .catch(() => {
        setAppVariant('oncue')
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
      const response = await authenticatedFetch('/api/cases')
      if (response.ok) {
        const data = await response.json()
        setCases(data.cases || [])
        setUncategorizedCount(data.uncategorized_count || 0)
      }
    } catch (err) {
      console.error('Failed to fetch cases:', err)
    } finally {
      setCasesLoading(false)
    }
  }, [])

  const refreshRecentTranscripts = useCallback(async () => {
    setRecentLoading(true)
    try {
      const response = await authenticatedFetch('/api/transcripts')
      if (response.ok) {
        const data = await response.json()
        // Get most recent 5 for sidebar
        setRecentTranscripts((data.transcripts || []).slice(0, 5))
      }
    } catch (err) {
      console.error('Failed to fetch transcripts:', err)
    } finally {
      setRecentLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    refreshCases()
    refreshRecentTranscripts()
  }, [refreshCases, refreshRecentTranscripts])

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
