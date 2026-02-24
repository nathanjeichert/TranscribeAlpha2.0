'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { getCurrentUser } from '@/utils/auth'
import { nowIso, type TranscriptListItem } from '@/utils/helpers'
import {
  deleteFile,
  listCases as localListCases,
  listUncategorizedTranscripts as localListUncategorized,
  listTranscriptsInCase,
  type TranscriptSummary,
} from '@/lib/storage'
import { logger } from '@/utils/logger'
import { setFFmpegMemoryLimitMB } from '@/lib/ffmpegWorker'
import {
  MAX_PERSISTED_JOBS,
  JOB_STORAGE_PREFIX,
  LEGACY_JOB_STORAGE_PREFIX,
  readPersistedJobs,
  writePersistedJobs,
} from '@/lib/jobPersistence'
import type {
  CaseMeta,
  JobKind,
  JobStatus,
  JobRecord,
  TranscriptionJobInput,
  ActiveFileEntry,
  TranscriptionRuntimeInput,
  MemoryUsage,
  DashboardContextValue,
} from './dashboardTypes'
import { isTerminalStatus } from './dashboardTypes'
import { useConversionQueue } from './useConversionQueue'
import { useTranscriptionQueue } from './useTranscriptionQueue'

// Re-export types for consumers that import from DashboardContext
export type { CaseMeta, JobKind, JobStatus, JobRecord, TranscriptionJobInput, ActiveFileEntry, TranscriptionRuntimeInput, MemoryUsage, DashboardContextValue }
export { isTerminalStatus }

const ONCUE_XML_ENABLED_KEY = 'ta_oncue_xml_enabled'
const MEMORY_LIMIT_KEY = 'ta_memory_limit_mb'
const DEFAULT_MEMORY_LIMIT_MB = 1024
const MIN_MEMORY_LIMIT_MB = 256
const MAX_MEMORY_LIMIT_MB = 4096

function clampMemoryLimitMB(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_LIMIT_MB
  const rounded = Math.floor(value)
  return Math.max(MIN_MEMORY_LIMIT_MB, Math.min(MAX_MEMORY_LIMIT_MB, rounded))
}

function getStoredMemoryLimitMB(): number {
  try {
    const stored = localStorage.getItem(MEMORY_LIMIT_KEY)
    if (!stored) return DEFAULT_MEMORY_LIMIT_MB
    return clampMemoryLimitMB(parseInt(stored, 10))
  } catch {
    return DEFAULT_MEMORY_LIMIT_MB
  }
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [cases, setCases] = useState<CaseMeta[]>([])
  const [uncategorizedCount, setUncategorizedCount] = useState(0)
  const [casesLoading, setCasesLoading] = useState(true)

  const [recentTranscripts, setRecentTranscripts] = useState<TranscriptListItem[]>([])
  const [recentLoading, setRecentLoading] = useState(true)

  const [activeMediaKey, setActiveMediaKey] = useState<string | null>(null)
  const [oncueXmlEnabled, setOncueXmlEnabledState] = useState(false)
  const [memoryLimitMB, setMemoryLimitMBState] = useState<number>(DEFAULT_MEMORY_LIMIT_MB)

  const [jobs, setJobs] = useState<JobRecord[]>([])
  const jobsRef = useRef<JobRecord[]>([])
  const jobsUserKeyRef = useRef<string | null>(null)
  const jobsHydratedRef = useRef(false)

  const jobFilesRef = useRef<Map<string, ActiveFileEntry>>(new Map())

  const applyJobsMutation = useCallback((updater: (prev: JobRecord[]) => JobRecord[]) => {
    const next = updater(jobsRef.current)
    jobsRef.current = next
    setJobs(next)
  }, [])

  const updateJob = useCallback((jobId: string, updater: Partial<JobRecord> | ((job: JobRecord) => JobRecord)) => {
    applyJobsMutation((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job
        const next = typeof updater === 'function' ? updater(job) : { ...job, ...updater }
        return { ...next, updatedAt: nowIso() }
      }),
    )
  }, [applyJobsMutation])

  // Read OnCue XML setting from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(ONCUE_XML_ENABLED_KEY)
      if (stored === 'true') setOncueXmlEnabledState(true)
    } catch {
      // Ignore localStorage errors
    }
  }, [])

  const setOncueXmlEnabled = useCallback((value: boolean) => {
    setOncueXmlEnabledState(value)
    try {
      localStorage.setItem(ONCUE_XML_ENABLED_KEY, value ? 'true' : 'false')
    } catch {
      // Ignore localStorage errors
    }
  }, [])

  useEffect(() => {
    setMemoryLimitMBState(getStoredMemoryLimitMB())
  }, [])

  const setMemoryLimitMB = useCallback((value: number) => {
    const clamped = clampMemoryLimitMB(value)
    setMemoryLimitMBState(clamped)
    try {
      localStorage.setItem(MEMORY_LIMIT_KEY, String(clamped))
    } catch {
      // Ignore localStorage errors.
    }
  }, [])

  useEffect(() => {
    setFFmpegMemoryLimitMB(memoryLimitMB)
  }, [memoryLimitMB])

  // Initialize per-user job persistence key
  useEffect(() => {
    const user = getCurrentUser()
    const username = user?.username || 'unknown'
    const idbKey = `${JOB_STORAGE_PREFIX}${username}`
    const legacyKey = `${LEGACY_JOB_STORAGE_PREFIX}${username}`
    jobsUserKeyRef.current = idbKey
    jobsHydratedRef.current = false

    let canceled = false
    void (async () => {
      const loaded = await readPersistedJobs(idbKey, legacyKey)
      if (canceled) return
      applyJobsMutation((current) => {
        const currentIds = new Set(current.map((j) => j.id))
        const merged = [...current, ...loaded.filter((j) => !currentIds.has(j.id))]
        return merged.slice(Math.max(0, merged.length - MAX_PERSISTED_JOBS))
      })
      jobsHydratedRef.current = true
      try {
        localStorage.removeItem(legacyKey)
      } catch {
        // Ignore cleanup failures.
      }
    })()

    return () => {
      canceled = true
    }
  }, [applyJobsMutation])

  // Persist jobs metadata to IndexedDB.
  useEffect(() => {
    const key = jobsUserKeyRef.current
    if (!key || !jobsHydratedRef.current) return

    const timeout = window.setTimeout(() => {
      void writePersistedJobs(key, jobs).catch(() => undefined)
    }, 250)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [jobs])

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

  // Cases & transcripts
  const refreshCases = useCallback(async () => {
    setCasesLoading(true)
    try {
      const localCases = await localListCases()
      setCases(localCases)
      const uncategorized = await localListUncategorized()
      setUncategorizedCount(uncategorized.length)
    } catch (err) {
      logger.error('Failed to fetch cases:', err)
    } finally {
      setCasesLoading(false)
    }
  }, [])

  const refreshRecentTranscripts = useCallback(async () => {
    setRecentLoading(true)
    try {
      const allTranscripts: TranscriptSummary[] = []
      const localCases = await localListCases()
      for (const c of localCases) {
        const caseTranscripts = await listTranscriptsInCase(c.case_id)
        allTranscripts.push(...caseTranscripts)
      }
      const uncategorized = await localListUncategorized()
      allTranscripts.push(...uncategorized)
      allTranscripts.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      setRecentTranscripts(
        allTranscripts.slice(0, 5).map((t) => ({
          media_key: t.media_key,
          title_label: t.title_label,
          updated_at: t.updated_at,
          line_count: t.line_count,
        })),
      )
    } catch (err) {
      logger.error('Failed to fetch transcripts:', err)
    } finally {
      setRecentLoading(false)
    }
  }, [])

  // Queue hooks
  const {
    addConversionJobs, startConversionQueue, stopConversionQueue,
    runConversionQueue, getConvertedFile, resolveConvertedFile,
    removeConvertedFromMemory, getConvertedBytes, cleanupConversionJob,
  } = useConversionQueue({ jobsRef, jobFilesRef, applyJobsMutation, updateJob, memoryLimitMB })

  const {
    enqueueTranscriptionJobs, runTranscriptionQueue, cleanupTranscriptionJob,
  } = useTranscriptionQueue({
    jobsRef, jobFilesRef, jobsHydratedRef,
    applyJobsMutation, updateJob, memoryLimitMB,
    getConvertedBytes, setActiveMediaKey,
    refreshCases, refreshRecentTranscripts,
  })

  // Cross-queue orchestration
  const removeJob = useCallback((jobId: string) => {
    const existing = jobsRef.current.find((job) => job.id === jobId)
    if (existing?.convertedCachePath) {
      void deleteFile(existing.convertedCachePath).catch(() => undefined)
    }
    cleanupTranscriptionJob(jobId)
    cleanupConversionJob(jobId)
    jobFilesRef.current.delete(jobId)
    applyJobsMutation((prev) => prev.filter((job) => job.id !== jobId))
  }, [applyJobsMutation, cleanupConversionJob, cleanupTranscriptionJob])

  const clearTerminalJobs = useCallback(() => {
    const toRemove = jobsRef.current.filter((job) => isTerminalStatus(job.status))
    for (const job of toRemove) {
      if (job.convertedCachePath) {
        void deleteFile(job.convertedCachePath).catch(() => undefined)
      }
      cleanupTranscriptionJob(job.id)
      cleanupConversionJob(job.id)
      jobFilesRef.current.delete(job.id)
    }
    applyJobsMutation((prev) => prev.filter((job) => !isTerminalStatus(job.status)))
  }, [applyJobsMutation, cleanupConversionJob, cleanupTranscriptionJob])

  const retryJob = useCallback(
    (jobId: string) => {
      const job = jobsRef.current.find((entry) => entry.id === jobId)
      if (!job) return

      if (job.kind === 'conversion') {
        const active = jobFilesRef.current.get(jobId)
        if (!active?.file) {
          updateJob(jobId, {
            status: 'failed',
            error: 'The source file is no longer available in this tab. Please add it again.',
          })
          return
        }
        removeConvertedFromMemory(jobId)
        updateJob(jobId, {
          status: 'queued',
          error: '',
          detail: 'Ready',
          progress: 0,
          needsConversion: true,
        })
        void runConversionQueue()
        return
      }

      if (job.kind === 'transcription') {
        cleanupTranscriptionJob(jobId)
        updateJob(jobId, { status: 'queued', error: '', detail: 'Queued', unloadSensitive: false })
        void runTranscriptionQueue()
      }
    },
    [cleanupTranscriptionJob, removeConvertedFromMemory, runConversionQueue, runTranscriptionQueue, updateJob],
  )

  const cancelJob = useCallback(
    async (jobId: string) => {
      const job = jobsRef.current.find((entry) => entry.id === jobId)
      if (!job) return

      if (job.kind === 'conversion') {
        if (job.status === 'running') {
          stopConversionQueue()
        }
        updateJob(jobId, { status: 'canceled', unloadSensitive: false, detail: 'Canceled' })
        return
      }

      if (job.kind === 'transcription') {
        cleanupTranscriptionJob(jobId)
        updateJob(jobId, { status: 'canceled', unloadSensitive: false, detail: 'Canceled' })
      }
    },
    [cleanupTranscriptionJob, stopConversionQueue, updateJob],
  )

  const activeJobCount = useMemo(() => {
    return jobs.filter((job) => !isTerminalStatus(job.status)).length
  }, [jobs])

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
        oncueXmlEnabled,
        setOncueXmlEnabled,
        memoryLimitMB,
        setMemoryLimitMB,
        jobs,
        activeJobCount,
        enqueueTranscriptionJobs,
        addConversionJobs,
        startConversionQueue,
        stopConversionQueue,
        getConvertedFile,
        resolveConvertedFile,
        retryJob,
        cancelJob,
        removeJob,
        clearTerminalJobs,
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
