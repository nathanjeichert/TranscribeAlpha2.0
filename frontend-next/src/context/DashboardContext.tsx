'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { getAuthHeaders, getCurrentUser } from '@/utils/auth'
import {
  deleteFile,
  listCases as localListCases,
  listUncategorizedTranscripts as localListUncategorized,
  listTranscriptsInCase,
  readBinaryFile,
  resolveWorkspaceRelativePathForHandle,
  saveTranscript as localSaveTranscript,
  writeBinaryFile,
  type TranscriptData,
  type TranscriptSummary,
} from '@/lib/storage'
import { cacheMediaForPlayback } from '@/lib/mediaCache'
import { getMediaFile, storeMediaHandle } from '@/lib/mediaHandles'
import { openDB } from '@/lib/idb'
import {
  FFmpegCanceledError,
  cancelActiveFFmpegJob,
  convertToPlayable,
  detectCodec,
  extractAudio,
  extractAudioStereo,
  readConvertedFromCache,
  setFFmpegMemoryLimitMB,
  writeConvertedToCache,
  type CodecInfo,
} from '@/lib/ffmpegWorker'

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

export type JobKind = 'transcription' | 'conversion' | 'audio_extraction'
export type JobStatus =
  | 'queued'
  | 'running'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type JobRecord = {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  detail?: string
  progress?: number
  error?: string
  fileSizeBytes?: number

  createdAt: string
  updatedAt: string

  mediaKey?: string
  caseId?: string | null

  transcriptionModel?: 'assemblyai' | 'gemini'
  speakersExpected?: number | null
  sourceFilename?: string | null
  sourceMediaRefId?: string | null
  caseName?: string
  caseNumber?: string
  firmName?: string
  inputDate?: string
  inputTime?: string
  location?: string
  speakerNames?: string
  multichannel?: boolean
  channelLabels?: Record<number, string>

  unloadSensitive: boolean

  // Conversion metadata (serializable)
  codec?: CodecInfo | null
  needsConversion?: boolean
  convertedCachePath?: string | null
  convertedFilename?: string | null
  convertedContentType?: string | null
}

export type TranscriptionJobInput = {
  file: File
  fileHandle?: FileSystemFileHandle | null
  originalFileName: string
  mediaKey: string
  transcriptionModel: 'assemblyai' | 'gemini'
  caseId?: string | null
  case_name: string
  case_number: string
  firm_name: string
  input_date: string
  input_time?: string
  location: string
  speakers_expected?: number | null
  speaker_names?: string
  multichannel?: boolean
  channelLabels?: Record<number, string>
}

const MAX_PERSISTED_JOBS = 3000
const JOB_STORAGE_PREFIX = 'ta_jobs_v2:'
const LEGACY_JOB_STORAGE_PREFIX = 'ta_jobs_v1:'
const JOBS_STORE = 'jobs'

const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024
const CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS = 7 * 60 * 1000
const CRIMINAL_DIRECT_UPLOAD_FALLBACK_MAX_BYTES = 512 * 1024 * 1024
const CRIMINAL_TRANSCRIBE_REQUEST_TIMEOUT_MS = 16 * 60 * 1000
const MAX_IN_MEMORY_CONVERTED_FILES = 8
const MEMORY_LIMIT_KEY = 'ta_memory_limit_mb'
const DEFAULT_MEMORY_LIMIT_MB = 1024
const MIN_MEMORY_LIMIT_MB = 256
const MAX_MEMORY_LIMIT_MB = 4096
const MIN_CONCURRENT_UPLOADS = 2
const MAX_CONCURRENT_UPLOADS = 50

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm'])
const COMPRESSED_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma'])

type ActiveFileEntry = {
  file: File
  originalFileName: string
  fileHandle?: FileSystemFileHandle | null
}

type TranscriptionRuntimeInput = Omit<TranscriptionJobInput, 'file' | 'fileHandle'>

type MemoryUsage = {
  convertedFiles: number
  preparedAudio: number
  jobFiles: number
  inFlightUploads: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

function isLikelyVideoSource(file: File): boolean {
  if ((file.type || '').startsWith('video/')) return true
  return VIDEO_EXTENSIONS.has(getFileExtension(file.name))
}

function isLikelyCompressedAudioSource(file: File): boolean {
  if ((file.type || '').startsWith('audio/')) {
    const extension = getFileExtension(file.name)
    if (!extension) return false
    return COMPRESSED_AUDIO_EXTENSIONS.has(extension)
  }
  return COMPRESSED_AUDIO_EXTENSIONS.has(getFileExtension(file.name))
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getFilenameExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) return 'bin'
  return filename.slice(dot + 1).toLowerCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

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

function normalizeChannelLabels(value: unknown): Record<number, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const labels: Record<number, string> = {}
  for (const [rawKey, rawLabel] of Object.entries(value as Record<string, unknown>)) {
    const key = Number(rawKey)
    if (!Number.isInteger(key) || key <= 0) continue
    const label = String(rawLabel || '').trim()
    if (!label) continue
    labels[key] = label
  }
  return Object.keys(labels).length ? labels : undefined
}

function buildConvertedOutputPath(jobId: string, convertedFile: File): string {
  const ext = getFilenameExtension(convertedFile.name)
  return `cache/converted-jobs/${jobId}.${ext}`
}

function normalizePersistedJobs(rawJobs: unknown): JobRecord[] {
  if (!Array.isArray(rawJobs)) return []

  const loaded: JobRecord[] = []
  for (const entry of rawJobs) {
    if (!entry || typeof entry !== 'object') continue
    const job = entry as Partial<JobRecord>
    if (!job.id || !job.kind || !job.status) continue
    loaded.push({
      id: String(job.id),
      kind: job.kind as JobKind,
      status: job.status as JobStatus,
      title: String(job.title || 'Job'),
      detail: getString(job.detail),
      progress: typeof job.progress === 'number' ? job.progress : undefined,
      error: getString(job.error),
      fileSizeBytes: typeof job.fileSizeBytes === 'number' ? job.fileSizeBytes : undefined,
      createdAt: String(job.createdAt || nowIso()),
      updatedAt: String(job.updatedAt || nowIso()),
      mediaKey: getString(job.mediaKey),
      caseId: typeof job.caseId === 'string' ? job.caseId : null,
      transcriptionModel: job.transcriptionModel as JobRecord['transcriptionModel'],
      speakersExpected: typeof job.speakersExpected === 'number' ? job.speakersExpected : null,
      sourceFilename: getString(job.sourceFilename) ?? null,
      sourceMediaRefId: getString(job.sourceMediaRefId) ?? null,
      caseName: getString(job.caseName),
      caseNumber: getString(job.caseNumber),
      firmName: getString(job.firmName),
      inputDate: getString(job.inputDate),
      inputTime: getString(job.inputTime),
      location: getString(job.location),
      speakerNames: getString(job.speakerNames),
      multichannel: typeof job.multichannel === 'boolean' ? job.multichannel : false,
      channelLabels: normalizeChannelLabels(job.channelLabels),
      unloadSensitive: Boolean(job.unloadSensitive),
      codec: (job.codec as CodecInfo | null | undefined) ?? undefined,
      needsConversion: typeof job.needsConversion === 'boolean' ? job.needsConversion : undefined,
      convertedCachePath: getString(job.convertedCachePath) ?? null,
      convertedFilename: getString(job.convertedFilename) ?? null,
      convertedContentType: getString(job.convertedContentType) ?? null,
    })
  }

  const normalized = loaded.map((job): JobRecord => {
    if (isTerminalStatus(job.status)) return job
    return {
      ...job,
      status: 'failed',
      error:
        job.error ||
        'This job stopped because the page was reloaded or closed. Use Retry to continue.',
      unloadSensitive: false,
      updatedAt: nowIso(),
    }
  })

  return normalized.slice(Math.max(0, normalized.length - MAX_PERSISTED_JOBS))
}

async function readPersistedJobs(userKey: string, legacyKey: string): Promise<JobRecord[]> {
  try {
    const db = await openDB()
    const idbValue = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(JOBS_STORE, 'readonly')
      const store = tx.objectStore(JOBS_STORE)
      const request = store.get(userKey)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const normalized = normalizePersistedJobs(idbValue)
    if (normalized.length > 0) return normalized
  } catch {
    // fall through to legacy storage
  }

  try {
    const legacy = localStorage.getItem(legacyKey)
    if (!legacy) return []
    return normalizePersistedJobs(JSON.parse(legacy))
  } catch {
    return []
  }
}

async function writePersistedJobs(userKey: string, jobs: JobRecord[]): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(JOBS_STORE, 'readwrite')
    const store = tx.objectStore(JOBS_STORE)
    const request = store.put(jobs.slice(Math.max(0, jobs.length - MAX_PERSISTED_JOBS)), userKey)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
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
  memoryLimitMB: number
  setMemoryLimitMB: (value: number) => void

  // Jobs (global)
  jobs: JobRecord[]
  activeJobCount: number
  enqueueTranscriptionJobs: (items: TranscriptionJobInput[]) => void
  addConversionJobs: (files: File[]) => Promise<void>
  startConversionQueue: (options?: { promptLargeFiles?: boolean }) => Promise<void>
  stopConversionQueue: () => void
  getConvertedFile: (jobId: string) => File | null
  resolveConvertedFile: (jobId: string) => Promise<File | null>
  retryJob: (jobId: string) => void
  cancelJob: (jobId: string) => Promise<void>
  removeJob: (jobId: string) => void
  clearTerminalJobs: () => void
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
  const [memoryLimitMB, setMemoryLimitMBState] = useState<number>(DEFAULT_MEMORY_LIMIT_MB)

  const [jobs, setJobs] = useState<JobRecord[]>([])
  const jobsRef = useRef<JobRecord[]>([])
  const jobsUserKeyRef = useRef<string | null>(null)
  const jobsHydratedRef = useRef(false)

  const jobFilesRef = useRef<Map<string, ActiveFileEntry>>(new Map())
  const transcriptionInputsRef = useRef<Map<string, TranscriptionRuntimeInput>>(new Map())
  const convertedFilesRef = useRef<Map<string, File>>(new Map())
  const convertedReloadingRef = useRef<Set<string>>(new Set())
  const convertedOrderRef = useRef<string[]>([])
  const convertedBytesRef = useRef(0)
  const preparedAudioRef = useRef<Map<string, File>>(new Map())
  const abortRef = useRef<Map<string, XMLHttpRequest>>(new Map())
  const inFlightUploadBytesRef = useRef<Map<string, number>>(new Map())
  const activeTranscriptionJobIdsRef = useRef<Set<string>>(new Set())

  const transcriptionRunnerActiveRef = useRef(false)
  const conversionRunnerActiveRef = useRef(false)
  const stopConversionRequestedRef = useRef(false)

  const applyJobsMutation = useCallback((updater: (prev: JobRecord[]) => JobRecord[]) => {
    const next = updater(jobsRef.current)
    jobsRef.current = next
    setJobs(next)
  }, [])

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
        // Merge: keep any in-flight jobs that were enqueued before hydration finished,
        // and add loaded (persisted) jobs that aren't already present.
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

  // Note: jobsRef.current is kept in sync by applyJobsMutation (immediate write).
  // A useEffect sync here would be harmful — it fires after React renders and can
  // revert jobsRef.current to a stale snapshot while workers are mid-processing.

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

  const removeConvertedFromMemory = useCallback((jobId: string) => {
    const existing = convertedFilesRef.current.get(jobId)
    if (existing) {
      convertedBytesRef.current = Math.max(0, convertedBytesRef.current - existing.size)
    }
    convertedFilesRef.current.delete(jobId)
    convertedOrderRef.current = convertedOrderRef.current.filter((id) => id !== jobId)
  }, [])

  const getCurrentMemoryUsage = useCallback((): MemoryUsage => {
    let preparedAudio = 0
    preparedAudioRef.current.forEach((file) => {
      preparedAudio += file.size
    })

    let jobFiles = 0
    for (const job of jobsRef.current) {
      if (job.kind !== 'transcription') continue
      if (!(job.status === 'running' || job.status === 'finalizing')) continue
      const active = jobFilesRef.current.get(job.id)
      if (active?.file) {
        jobFiles += active.file.size
      }
    }

    let inFlightUploads = 0
    inFlightUploadBytesRef.current.forEach((estimatedBytes) => {
      inFlightUploads += estimatedBytes
    })

    return {
      convertedFiles: convertedBytesRef.current,
      preparedAudio,
      jobFiles,
      inFlightUploads,
    }
  }, [])

  const getTotalUsedBytes = useCallback((): number => {
    const usage = getCurrentMemoryUsage()
    // jobFiles is excluded: File objects from the filesystem are lazy references,
    // not in-memory blobs. Real memory is tracked by preparedAudio and inFlightUploads.
    return usage.convertedFiles + usage.preparedAudio + usage.inFlightUploads
  }, [getCurrentMemoryUsage])

  const getMemoryLimitBytes = useCallback((): number => memoryLimitMB * 1024 * 1024, [memoryLimitMB])

  const getAvailableBudgetBytes = useCallback((): number => {
    const available = getMemoryLimitBytes() - getTotalUsedBytes()
    return Math.max(0, available)
  }, [getMemoryLimitBytes, getTotalUsedBytes])

  const calculateAverageQueuedFileSize = useCallback((): number => {
    let total = 0
    let count = 0
    for (const job of jobsRef.current) {
      if (job.kind !== 'transcription' || job.status !== 'queued') continue
      const active = jobFilesRef.current.get(job.id)
      if (!active?.file) continue
      total += active.file.size
      count += 1
    }
    if (!count) return 1 * 1024 * 1024
    return total / count
  }, [])

  const getMaxConcurrentUploads = useCallback((): number => {
    const available = getAvailableBudgetBytes()
    const avgFileSize = calculateAverageQueuedFileSize()
    const perSlotCost = Math.max(avgFileSize + 2 * 1024 * 1024, 3 * 1024 * 1024)
    const slots = Math.floor(available / perSlotCost)
    return Math.max(MIN_CONCURRENT_UPLOADS, Math.min(slots, MAX_CONCURRENT_UPLOADS))
  }, [calculateAverageQueuedFileSize, getAvailableBudgetBytes])

  const getConvertedFileBudgetBytes = useCallback((): number => {
    return Math.floor(memoryLimitMB * 0.25 * 1024 * 1024)
  }, [memoryLimitMB])

  const storeConvertedInMemory = useCallback(
    (jobId: string, file: File) => {
      removeConvertedFromMemory(jobId)
      convertedFilesRef.current.set(jobId, file)
      convertedOrderRef.current.push(jobId)
      convertedBytesRef.current += file.size

      while (
        convertedOrderRef.current.length > MAX_IN_MEMORY_CONVERTED_FILES ||
        convertedBytesRef.current > getConvertedFileBudgetBytes()
      ) {
        const evictId = convertedOrderRef.current.shift()
        if (!evictId) break
        if (evictId === jobId) {
          convertedOrderRef.current.push(evictId)
          break
        }
        const evictFile = convertedFilesRef.current.get(evictId)
        if (evictFile) {
          convertedBytesRef.current = Math.max(0, convertedBytesRef.current - evictFile.size)
          convertedFilesRef.current.delete(evictId)
        }
      }
    },
    [getConvertedFileBudgetBytes, removeConvertedFromMemory],
  )

  const persistConvertedOutput = useCallback(async (jobId: string, convertedFile: File): Promise<string | null> => {
    const outputPath = buildConvertedOutputPath(jobId, convertedFile)
    try {
      const payload = await convertedFile.arrayBuffer()
      await writeBinaryFile(outputPath, payload)
      return outputPath
    } catch {
      return null
    }
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

  const removeJob = useCallback((jobId: string) => {
    const existing = jobsRef.current.find((job) => job.id === jobId)
    if (existing?.convertedCachePath) {
      void deleteFile(existing.convertedCachePath).catch(() => undefined)
    }
    const xhr = abortRef.current.get(jobId)
    if (xhr) {
      try { xhr.abort() } catch {}
      abortRef.current.delete(jobId)
    }
    jobFilesRef.current.delete(jobId)
    transcriptionInputsRef.current.delete(jobId)
    removeConvertedFromMemory(jobId)
    convertedReloadingRef.current.delete(jobId)
    preparedAudioRef.current.delete(jobId)
    abortRef.current.delete(jobId)
    inFlightUploadBytesRef.current.delete(jobId)
    activeTranscriptionJobIdsRef.current.delete(jobId)
    applyJobsMutation((prev) => prev.filter((job) => job.id !== jobId))
  }, [applyJobsMutation, removeConvertedFromMemory])

  const clearTerminalJobs = useCallback(() => {
    const toRemove = jobsRef.current.filter((job) => isTerminalStatus(job.status))
    for (const job of toRemove) {
      if (job.convertedCachePath) {
        void deleteFile(job.convertedCachePath).catch(() => undefined)
      }
      jobFilesRef.current.delete(job.id)
      transcriptionInputsRef.current.delete(job.id)
      removeConvertedFromMemory(job.id)
      convertedReloadingRef.current.delete(job.id)
      preparedAudioRef.current.delete(job.id)
      inFlightUploadBytesRef.current.delete(job.id)
    }
    applyJobsMutation((prev) => prev.filter((job) => !isTerminalStatus(job.status)))
  }, [applyJobsMutation, removeConvertedFromMemory])

  const getConvertedFile = useCallback((jobId: string) => {
    return convertedFilesRef.current.get(jobId) ?? null
  }, [])

  const resolveConvertedFile = useCallback(async (jobId: string): Promise<File | null> => {
    const existing = convertedFilesRef.current.get(jobId)
    if (existing) return existing

    const job = jobsRef.current.find((entry) => entry.id === jobId)
    if (!job || job.kind !== 'conversion' || !job.needsConversion) return null

    if (job.convertedCachePath && !convertedReloadingRef.current.has(jobId)) {
      convertedReloadingRef.current.add(jobId)
      try {
        const bytes = await readBinaryFile(job.convertedCachePath)
        if (bytes) {
          const restored = new File([bytes], job.convertedFilename || `${job.title}_converted`, {
            type: job.convertedContentType || 'application/octet-stream',
            lastModified: Date.now(),
          })
          storeConvertedInMemory(jobId, restored)
          return restored
        }
      } finally {
        convertedReloadingRef.current.delete(jobId)
      }
    }

    const active = jobFilesRef.current.get(jobId)
    if (!active?.file) return null

    try {
      const cached = await readConvertedFromCache(active.file)
      if (!cached) return null
      storeConvertedInMemory(jobId, cached)

      if (!job.convertedCachePath) {
        const cachePath = await persistConvertedOutput(jobId, cached)
        updateJob(jobId, {
          convertedCachePath: cachePath,
          convertedFilename: cached.name,
          convertedContentType: cached.type || 'application/octet-stream',
        })
      }
      return cached
    } catch {
      return null
    }
  }, [persistConvertedOutput, storeConvertedInMemory, updateJob])

  const refreshCases = useCallback(async () => {
    setCasesLoading(true)
    try {
      const localCases = await localListCases()
      setCases(localCases)
      const uncategorized = await localListUncategorized()
      setUncategorizedCount(uncategorized.length)
    } catch (err) {
      console.error('Failed to fetch cases:', err)
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
      console.error('Failed to fetch transcripts:', err)
    } finally {
      setRecentLoading(false)
    }
  }, [])

  const saveTranscriptLocally = useCallback(
    async (jobId: string, transcriptPayload: Record<string, unknown>) => {
      const mediaKey = String(transcriptPayload.media_key || '')
      if (!mediaKey) {
        throw new Error('Missing media_key in transcript response')
      }

      const job = jobsRef.current.find((entry) => entry.id === jobId)
      const caseId = job?.caseId ? String(job.caseId) : undefined
      const activeFile = jobFilesRef.current.get(jobId)

      const mediaFilename =
        (transcriptPayload.media_filename as string | undefined) ||
        activeFile?.originalFileName ||
        activeFile?.file.name ||
        'media'
      const backendContentType =
        (transcriptPayload.media_content_type as string | undefined) || ''
      const originalFileType = activeFile?.file.type || ''
      // Prefer the original file's video type over the backend's extracted-audio type
      const mediaContentType =
        (originalFileType.startsWith('video/') ? originalFileType : '') ||
        backendContentType ||
        originalFileType ||
        'application/octet-stream'

      const record = { ...(transcriptPayload as Record<string, unknown>) } as TranscriptData
      record.media_filename = mediaFilename
      record.media_content_type = mediaContentType
      record.media_handle_id = mediaKey
      record.media_storage_mode = activeFile?.fileHandle ? 'external-handle' : 'workspace-cache'

      let workspaceRelativePath: string | null = null
      if (activeFile?.fileHandle) {
        try {
          await storeMediaHandle(mediaKey, activeFile.fileHandle)
        } catch {
          // Best effort only; cached playback remains available even if handle persistence fails.
        }

        workspaceRelativePath = await resolveWorkspaceRelativePathForHandle(activeFile.fileHandle)
        if (workspaceRelativePath) {
          record.media_workspace_relpath = workspaceRelativePath
          record.media_storage_mode = 'workspace-relative'
        }
      }

      if (!workspaceRelativePath) {
        delete record.media_workspace_relpath
      }

      if (job?.multichannel) {
        const prepared = preparedAudioRef.current.get(jobId)
        if (prepared) {
          try {
            const cached = await cacheMediaForPlayback(mediaKey, prepared, {
              filename: prepared.name || mediaFilename,
              contentType: prepared.type || 'audio/ogg',
            })
            record.playback_cache_path = cached.path
            record.playback_cache_content_type = cached.contentType
            if (!workspaceRelativePath) {
              record.media_storage_mode = 'workspace-cache'
            }
          } catch {
            // Ignore playback-cache write failures; transcript persistence remains primary.
          }
        }
      } else if (!workspaceRelativePath && activeFile?.file) {
        try {
          const cached = await cacheMediaForPlayback(mediaKey, activeFile.file, {
            filename: mediaFilename,
            contentType: mediaContentType,
          })
          record.playback_cache_path = cached.path
          record.playback_cache_content_type = cached.contentType
        } catch {
          // Ignore playback-cache write failures and rely on external handles when available.
        }
      } else if (workspaceRelativePath) {
        delete record.playback_cache_path
        delete record.playback_cache_content_type
      }

      await localSaveTranscript(mediaKey, record, caseId)

      setActiveMediaKey(mediaKey)
      await refreshRecentTranscripts()
      if (caseId) {
        await refreshCases()
      }

      return mediaKey
    },
    [refreshCases, refreshRecentTranscripts],
  )

  const waitForPreparedAudioCapacity = useCallback(
    async (jobId: string) => {
      let announced = false
      while (preparedAudioRef.current.size >= getMaxConcurrentUploads()) {
        if (!announced) {
          updateJob(jobId, { detail: 'Waiting for an available upload slot...' })
          announced = true
        }
        await sleep(200)
      }
    },
    [getMaxConcurrentUploads, updateJob],
  )

  const waitForMemoryBudget = useCallback(
    async (jobId: string, requiredBytes: number) => {
      const startedAt = Date.now()
      let announced = false
      while (getAvailableBudgetBytes() < requiredBytes) {
        if (!announced) {
          updateJob(jobId, { detail: 'Waiting for memory budget...' })
          announced = true
        }
        if (Date.now() - startedAt > CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS) {
          throw new Error('Memory budget limit reached. Increase Memory Limit in Settings or reduce batch size.')
        }
        await sleep(250)
      }
    },
    [getAvailableBudgetBytes, updateJob],
  )

  const prepareUploadFile = useCallback(
    async (jobId: string, sourceFile: File): Promise<File> => {
      const job = jobsRef.current.find((entry) => entry.id === jobId)

      if (job?.multichannel) {
        const cached = preparedAudioRef.current.get(jobId)
        if (cached) return cached

        await waitForPreparedAudioCapacity(jobId)
        const estimatedStereoBytes = Math.max(Math.floor(sourceFile.size * 0.5), 3 * 1024 * 1024)
        await waitForMemoryBudget(jobId, estimatedStereoBytes)

        updateJob(jobId, {
          detail: 'Converting for multichannel upload...',
        })

        let extractionTimedOut = false
        let timeoutId: number | null = null
        try {
          const extractionPromise = extractAudioStereo(sourceFile, (ratio) => {
            updateJob(jobId, {
              detail: `Converting for multichannel upload... ${Math.round(ratio * 100)}%`,
            })
          })

          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(() => {
              extractionTimedOut = true
              cancelActiveFFmpegJob()
              reject(new Error('Preparing multichannel audio took too long in this tab.'))
            }, CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS)
          })

          const extracted = await Promise.race([extractionPromise, timeoutPromise])
          preparedAudioRef.current.set(jobId, extracted)
          updateJob(jobId, { detail: 'Multichannel audio ready. Preparing upload...' })
          return extracted
        } catch (error) {
          if (error instanceof FFmpegCanceledError && !extractionTimedOut) {
            throw new Error('Preparing multichannel audio was canceled.')
          }

          if (sourceFile.size > CRIMINAL_DIRECT_UPLOAD_FALLBACK_MAX_BYTES) {
            const sizeMb = (sourceFile.size / (1024 * 1024)).toFixed(1)
            const reason = extractionTimedOut
              ? 'Preparing this file in the browser took too long.'
              : 'This file could not be prepared in the browser.'
            throw new Error(
              `${reason} The original ${sizeMb} MB file is likely too large to upload directly. ` +
                'Convert it to MP3 on the Converter page, then try again.',
            )
          }

          // Fall back to sending original media when in-browser stereo extraction fails
          // (e.g. G.729 WAV files that ffmpeg.wasm cannot decode).
          // AssemblyAI handles multichannel separation server-side.
          updateJob(jobId, { detail: 'Multichannel extraction unavailable. Uploading original media...' })
          return sourceFile
        } finally {
          if (timeoutId) window.clearTimeout(timeoutId)
        }
      }

      // If it's already a compressed audio file (not video), upload directly.
      if (!isLikelyVideoSource(sourceFile) && isLikelyCompressedAudioSource(sourceFile)) {
        return sourceFile
      }

      const cached = preparedAudioRef.current.get(jobId)
      if (cached) return cached

      await waitForPreparedAudioCapacity(jobId)
      const estimatedExtractionBytes = Math.max(Math.floor(sourceFile.size * 0.35), 3 * 1024 * 1024)
      await waitForMemoryBudget(jobId, estimatedExtractionBytes)

      updateJob(jobId, {
        detail: 'Extracting compressed mono audio for upload...',
      })

      let extractionTimedOut = false
      let timeoutId: number | null = null
      try {
        const extractionPromise = extractAudio(sourceFile, (ratio) => {
          updateJob(jobId, {
            detail: `Extracting compressed mono audio for upload... ${Math.round(ratio * 100)}%`,
          })
        })

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            extractionTimedOut = true
            cancelActiveFFmpegJob()
            reject(new Error('Preparing the upload took too long in this tab.'))
          }, CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS)
        })

        const extracted = await Promise.race([extractionPromise, timeoutPromise])
        preparedAudioRef.current.set(jobId, extracted)
        updateJob(jobId, { detail: 'Audio extraction complete. Preparing upload...' })
        return extracted
      } catch (error) {
        if (error instanceof FFmpegCanceledError && !extractionTimedOut) {
          throw new Error('Preparing audio was canceled.')
        }

        if (sourceFile.size > CRIMINAL_DIRECT_UPLOAD_FALLBACK_MAX_BYTES) {
          const sizeMb = (sourceFile.size / (1024 * 1024)).toFixed(1)
          const reason = extractionTimedOut
            ? 'Preparing this file in the browser took too long.'
            : 'This file could not be prepared in the browser.'
          throw new Error(
            `${reason} The original ${sizeMb} MB file is likely too large to upload directly. ` +
              'Convert it to MP3 on the Converter page, then try again.',
          )
        }

        // Fall back to sending original media when in-browser extraction fails.
        updateJob(jobId, { detail: 'Audio extraction unavailable. Uploading original media...' })
        return sourceFile
      } finally {
        if (timeoutId) window.clearTimeout(timeoutId)
      }
    },
    [updateJob, waitForMemoryBudget, waitForPreparedAudioCapacity],
  )

  const submitTranscriptionJob = useCallback(
    async (jobId: string, input: TranscriptionRuntimeInput, uploadFile: File): Promise<void> => {
      const form = new FormData()
      form.append('file', uploadFile)
      form.append('transcription_model', input.transcriptionModel)
      form.append('media_key', input.mediaKey)
      form.append('source_filename', input.originalFileName)

      if (input.case_name.trim()) form.append('case_name', input.case_name.trim())
      if (input.case_number.trim()) form.append('case_number', input.case_number.trim())
      if (input.firm_name.trim()) form.append('firm_name', input.firm_name.trim())
      if (input.input_date) form.append('input_date', input.input_date)
      if (input.input_time) form.append('input_time', input.input_time)
      if (input.location.trim()) form.append('location', input.location.trim())
      if (input.caseId) form.append('case_id', String(input.caseId))
      if (typeof input.speakers_expected === 'number' && input.speakers_expected > 0) {
        form.append('speakers_expected', String(input.speakers_expected))
      }
      if (input.speaker_names?.trim()) {
        form.append('speaker_names', input.speaker_names.trim())
      }
      if (input.multichannel) {
        form.append('multichannel', 'true')
        if (input.channelLabels && Object.keys(input.channelLabels).length > 0) {
          form.append('channel_labels', JSON.stringify(input.channelLabels))
        }
      }

      const endpoint = '/api/transcribe'
      const uploadSlotBytes = Math.max(uploadFile.size + 2 * 1024 * 1024, 3 * 1024 * 1024)
      inFlightUploadBytesRef.current.set(jobId, uploadSlotBytes)

      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest()
        abortRef.current.set(jobId, request)
        const clearInFlight = () => {
          inFlightUploadBytesRef.current.delete(jobId)
        }

        request.open('POST', endpoint, true)
        request.responseType = 'json'
        request.timeout = CRIMINAL_TRANSCRIBE_REQUEST_TIMEOUT_MS

        const authHeaders = getAuthHeaders()
        Object.entries(authHeaders).forEach(([key, value]) => {
          request.setRequestHeader(key, String(value))
        })

        updateJob(jobId, {
          status: 'running',
          unloadSensitive: true,
          detail: 'Uploading media...',
          error: '',
        })

        request.upload.onprogress = () => {
          updateJob(jobId, { detail: 'Uploading media...' })
        }

        request.upload.onload = () => {
          updateJob(jobId, { detail: 'Transcribing (this may take a while)...' })
        }

        request.onload = async () => {
          abortRef.current.delete(jobId)
          clearInFlight()

          const responseData =
            request.response ??
            (() => {
              try {
                return JSON.parse(request.responseText)
              } catch {
                return null
              }
            })()

          if (request.status >= 200 && request.status < 300) {
            try {
              // Synchronous flow: save immediately once the server returns the transcript payload.
              updateJob(jobId, {
                status: 'finalizing',
                unloadSensitive: true,
                detail: 'Saving transcript...',
              })

              const mediaKey = await saveTranscriptLocally(jobId, responseData as Record<string, unknown>)
              updateJob(jobId, {
                status: 'succeeded',
                unloadSensitive: false,
                detail: 'Complete',
                mediaKey,
                error: '',
              })

              resolve()
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Failed to save transcript.'
              updateJob(jobId, { status: 'failed', unloadSensitive: false, error: message, detail: 'Failed' })
              reject(err)
            }
            return
          }

          const detail = responseData?.detail || 'Transcription failed'
          updateJob(jobId, { status: 'failed', unloadSensitive: false, error: String(detail), detail: 'Failed' })
          reject(new Error(String(detail)))
        }

        request.onerror = () => {
          abortRef.current.delete(jobId)
          clearInFlight()
          const message = 'Upload failed. Please try again.'
          updateJob(jobId, { status: 'failed', unloadSensitive: false, error: message, detail: 'Failed' })
          reject(new Error(message))
        }

        request.onabort = () => {
          abortRef.current.delete(jobId)
          clearInFlight()
          updateJob(jobId, { status: 'canceled', unloadSensitive: false, error: 'Canceled.', detail: 'Canceled' })
          const err = new Error('Canceled')
          err.name = 'AbortError'
          reject(err)
        }

        request.ontimeout = () => {
          abortRef.current.delete(jobId)
          clearInFlight()
          const message =
            'This upload took too long. Convert the file to MP3 on the Converter page, then try again.'
          updateJob(jobId, { status: 'failed', unloadSensitive: false, error: message, detail: 'Failed' })
          reject(new Error(message))
        }

        request.send(form)
      })
    },
    [saveTranscriptLocally, updateJob],
  )

  const runTranscriptionQueue = useCallback(async () => {
    if (transcriptionRunnerActiveRef.current) return
    transcriptionRunnerActiveRef.current = true

    try {
      const worker = async (workerIndex: number) => {
        while (true) {
          const hasQueuedJobs = jobsRef.current.some(
            (job) => job.kind === 'transcription' && job.status === 'queued',
          )
          if (!hasQueuedJobs) return

          const allowedSlots = getMaxConcurrentUploads()
          if (workerIndex >= allowedSlots) {
            await sleep(150)
            continue
          }

          const nextJob = jobsRef.current.find(
            (job) =>
              job.kind === 'transcription' &&
              job.status === 'queued' &&
              !activeTranscriptionJobIdsRef.current.has(job.id),
          )
          if (!nextJob) {
            await sleep(100)
            continue
          }

          activeTranscriptionJobIdsRef.current.add(nextJob.id)
          updateJob(nextJob.id, { status: 'running', unloadSensitive: true, detail: 'Preparing...' })

          try {
            let activeFile = jobFilesRef.current.get(nextJob.id)
            if (!activeFile?.file && nextJob.sourceMediaRefId) {
              try {
                const restored = await getMediaFile(nextJob.sourceMediaRefId)
                if (restored) {
                  activeFile = {
                    file: restored,
                    originalFileName: nextJob.sourceFilename || restored.name,
                    fileHandle: null,
                  }
                  jobFilesRef.current.set(nextJob.id, activeFile)
                }
              } catch {
                // best effort
              }
            }
            if (!activeFile?.file) {
              console.warn(
                '[TranscribeAlpha] File missing for job',
                nextJob.id,
                '| title:', nextJob.title,
                '| sourceMediaRefId:', nextJob.sourceMediaRefId,
                '| jobFilesRef size:', jobFilesRef.current.size,
                '| jobsRef queued count:', jobsRef.current.filter((j) => j.kind === 'transcription' && j.status === 'queued').length,
                '| hydrated:', jobsHydratedRef.current,
              )
              updateJob(nextJob.id, {
                status: 'failed',
                unloadSensitive: false,
                detail: 'Failed',
                error: 'The source file is no longer available in this tab. Please re-add it and try again.',
              })
              continue
            }

            let input = transcriptionInputsRef.current.get(nextJob.id)
            if (!input && nextJob.mediaKey && nextJob.transcriptionModel) {
              input = {
                originalFileName: nextJob.sourceFilename || nextJob.title,
                mediaKey: nextJob.mediaKey,
                transcriptionModel: nextJob.transcriptionModel,
                caseId: nextJob.caseId ?? null,
                case_name: nextJob.caseName || '',
                case_number: nextJob.caseNumber || '',
                firm_name: nextJob.firmName || '',
                input_date: nextJob.inputDate || '',
                input_time: nextJob.inputTime || '',
                location: nextJob.location || '',
                speakers_expected: nextJob.speakersExpected ?? null,
                speaker_names: nextJob.speakerNames || '',
                multichannel: Boolean(nextJob.multichannel),
                channelLabels: nextJob.channelLabels,
              }
              transcriptionInputsRef.current.set(nextJob.id, input)
            }
            if (!input) {
              updateJob(nextJob.id, {
                status: 'failed',
                unloadSensitive: false,
                detail: 'Failed',
                error: 'This job is missing required details. Please remove it and start again.',
              })
              continue
            }

            const fileForUpload = await prepareUploadFile(nextJob.id, activeFile.file)
            // Release prepared audio now — the file has been handed to FormData
            // and inFlightUploadBytesRef will track memory from here.
            preparedAudioRef.current.delete(nextJob.id)
            const latest = jobsRef.current.find((entry) => entry.id === nextJob.id)
            if (latest?.status === 'canceled') {
              continue
            }
            await submitTranscriptionJob(nextJob.id, input, fileForUpload)
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              updateJob(nextJob.id, { status: 'canceled', unloadSensitive: false, detail: 'Canceled', error: 'Canceled.' })
            } else {
              const message = err instanceof Error ? err.message : 'Transcription failed.'
              updateJob(nextJob.id, { status: 'failed', unloadSensitive: false, detail: 'Failed', error: message })
            }
          } finally {
            preparedAudioRef.current.delete(nextJob.id)
            inFlightUploadBytesRef.current.delete(nextJob.id)
            activeTranscriptionJobIdsRef.current.delete(nextJob.id)
          }
        }
      }

      const workers = Array.from({ length: MAX_CONCURRENT_UPLOADS }, (_, index) => worker(index))
      await Promise.allSettled(workers)
    } finally {
      transcriptionRunnerActiveRef.current = false
      activeTranscriptionJobIdsRef.current.clear()
    }
  }, [getMaxConcurrentUploads, prepareUploadFile, submitTranscriptionJob, updateJob])

  const enqueueTranscriptionJobs = useCallback(
    (items: TranscriptionJobInput[]) => {
      if (!items.length) return

      const createdAt = nowIso()
      const newJobs: JobRecord[] = items.map((item) => {
        const jobId = crypto.randomUUID()
        jobFilesRef.current.set(jobId, {
          file: item.file,
          originalFileName: item.originalFileName,
          fileHandle: item.fileHandle ?? null,
        })
        transcriptionInputsRef.current.set(jobId, {
          originalFileName: item.originalFileName,
          mediaKey: item.mediaKey,
          transcriptionModel: item.transcriptionModel,
          caseId: item.caseId ?? null,
          case_name: item.case_name,
          case_number: item.case_number,
          firm_name: item.firm_name,
          input_date: item.input_date,
          input_time: item.input_time,
          location: item.location,
          speakers_expected: item.speakers_expected ?? null,
          speaker_names: item.speaker_names,
          multichannel: Boolean(item.multichannel),
          channelLabels: normalizeChannelLabels(item.channelLabels),
        })

        // Store handle immediately when available so reloads can still playback/relink.
        if (item.fileHandle) {
          storeMediaHandle(item.mediaKey, item.fileHandle).catch(() => undefined)
        }

        const job: JobRecord = {
          id: jobId,
          kind: 'transcription',
          status: 'queued',
          title: item.originalFileName || item.file.name,
          fileSizeBytes: item.file.size,
          detail: 'Queued',
          createdAt,
          updatedAt: createdAt,
          mediaKey: item.mediaKey,
          caseId: item.caseId ?? null,
          transcriptionModel: item.transcriptionModel,
          speakersExpected: typeof item.speakers_expected === 'number' ? item.speakers_expected : null,
          sourceFilename: item.originalFileName || null,
          sourceMediaRefId: item.fileHandle ? item.mediaKey : null,
          caseName: item.case_name,
          caseNumber: item.case_number,
          firmName: item.firm_name,
          inputDate: item.input_date,
          inputTime: item.input_time,
          location: item.location,
          speakerNames: item.speaker_names,
          multichannel: Boolean(item.multichannel),
          channelLabels: normalizeChannelLabels(item.channelLabels),
          unloadSensitive: false,
        }
        return job
      })

      applyJobsMutation((prev) => {
        const combined = [...prev, ...newJobs]
        return combined.slice(Math.max(0, combined.length - MAX_PERSISTED_JOBS))
      })
      void runTranscriptionQueue()
    },
    [applyJobsMutation, runTranscriptionQueue],
  )

  const addConversionJobs = useCallback(
    async (files: File[]) => {
      if (!files.length) return

      const createdAt = nowIso()
      const newJobs: JobRecord[] = files.map((file) => {
        const jobId = crypto.randomUUID()
        jobFilesRef.current.set(jobId, { file, originalFileName: file.name, fileHandle: null })
        return {
          id: jobId,
          kind: 'conversion',
          status: 'queued',
          title: file.name,
          fileSizeBytes: file.size,
          detail: 'Detecting...',
          createdAt,
          updatedAt: createdAt,
          unloadSensitive: false,
          codec: null,
          needsConversion: undefined,
        }
      })

      applyJobsMutation((prev) => {
        const combined = [...prev, ...newJobs]
        return combined.slice(Math.max(0, combined.length - MAX_PERSISTED_JOBS))
      })

      for (const job of newJobs) {
        const active = jobFilesRef.current.get(job.id)
        if (!active?.file) continue
        try {
          const codec = await detectCodec(active.file)
          if (codec.needsConversion) {
            updateJob(job.id, { codec, needsConversion: true, detail: 'Ready', status: 'queued' })
          } else {
            updateJob(job.id, { codec, needsConversion: false, detail: 'Already OK', status: 'succeeded' })
          }
        } catch {
          updateJob(job.id, {
            codec: null,
            needsConversion: true,
            detail: 'Skipped',
            status: 'failed',
            error: 'We could not read this file format. Please try converting it again.',
          })
        }
      }
    },
    [applyJobsMutation, updateJob],
  )

  const runConversionQueue = useCallback(
    async (options?: { promptLargeFiles?: boolean }) => {
      if (conversionRunnerActiveRef.current) return
      conversionRunnerActiveRef.current = true
      stopConversionRequestedRef.current = false

      const promptLargeFiles = options?.promptLargeFiles ?? false

      try {
        while (true) {
          const next = jobsRef.current.find(
            (job) => job.kind === 'conversion' && job.status === 'queued' && job.needsConversion,
          )
          if (!next) break
          if (stopConversionRequestedRef.current) break

          const active = jobFilesRef.current.get(next.id)
          if (!active?.file) {
            updateJob(next.id, {
              status: 'failed',
              detail: 'Failed',
              error: 'The source file is no longer available in this tab. Please add it again.',
            })
            continue
          }

          if (promptLargeFiles && active.file.size > LARGE_FILE_WARNING_BYTES) {
            const shouldContinue = window.confirm(
              `This file is very large (${(active.file.size / (1024 * 1024 * 1024)).toFixed(2)} GB). In-browser conversion may fail. Continue?\n\n${active.file.name}`,
            )
            if (!shouldContinue) {
              updateJob(next.id, {
                status: 'queued',
                detail: 'Ready',
                error: 'Skipped in this batch due to large file size.',
              })
              continue
            }
            updateJob(next.id, { error: '' })
          }

          updateJob(next.id, { status: 'running', unloadSensitive: true, detail: 'Converting...', progress: 0, error: '' })

          try {
            let cached: File | null = null
            let outputPath: string | null = null
            try {
              cached = await readConvertedFromCache(active.file)
            } catch (cacheReadError) {
              console.warn('Converter cache read failed, continuing with conversion.', cacheReadError)
            }

            if (cached) {
              storeConvertedInMemory(next.id, cached)
              outputPath = await persistConvertedOutput(next.id, cached)
              updateJob(next.id, {
                status: 'succeeded',
                unloadSensitive: false,
                detail: 'Converted',
                progress: 1,
                convertedCachePath: outputPath,
                convertedFilename: cached.name,
                convertedContentType: cached.type || 'application/octet-stream',
              })
              continue
            }

            const converted = await convertToPlayable(active.file, (ratio) => {
              updateJob(next.id, { progress: ratio, detail: 'Converting...' })
            })

            storeConvertedInMemory(next.id, converted)

            try {
              await writeConvertedToCache(active.file, converted)
            } catch (cacheWriteError) {
              console.warn('Converter cache write failed, continuing without cache.', cacheWriteError)
            }

            outputPath = await persistConvertedOutput(next.id, converted)

            updateJob(next.id, {
              status: 'succeeded',
              unloadSensitive: false,
              detail: 'Converted',
              progress: 1,
              convertedCachePath: outputPath,
              convertedFilename: converted.name,
              convertedContentType: converted.type || 'application/octet-stream',
            })
          } catch (err) {
            if (err instanceof FFmpegCanceledError || stopConversionRequestedRef.current) {
              updateJob(next.id, {
                status: 'canceled',
                unloadSensitive: false,
                detail: 'Canceled',
                error: 'Conversion was canceled.',
              })
              break
            }
            const msg = err instanceof Error ? err.message : 'Conversion failed.'
            updateJob(next.id, { status: 'failed', unloadSensitive: false, detail: 'Failed', error: msg })
          }
        }
      } finally {
        conversionRunnerActiveRef.current = false
        stopConversionRequestedRef.current = false
      }
    },
    [persistConvertedOutput, storeConvertedInMemory, updateJob],
  )

  const startConversionQueue = useCallback(
    async (options?: { promptLargeFiles?: boolean }) => {
      await runConversionQueue(options)
    },
    [runConversionQueue],
  )

  const stopConversionQueue = useCallback(() => {
    stopConversionRequestedRef.current = true
    cancelActiveFFmpegJob()
  }, [])

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
        preparedAudioRef.current.delete(jobId)
        inFlightUploadBytesRef.current.delete(jobId)
        activeTranscriptionJobIdsRef.current.delete(jobId)
        updateJob(jobId, { status: 'queued', error: '', detail: 'Queued', unloadSensitive: false })
        void runTranscriptionQueue()
      }
    },
    [removeConvertedFromMemory, runConversionQueue, runTranscriptionQueue, updateJob],
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
        const xhr = abortRef.current.get(jobId)
        if (xhr) {
          try { xhr.abort() } catch {}
          abortRef.current.delete(jobId)
        }
        inFlightUploadBytesRef.current.delete(jobId)
        activeTranscriptionJobIdsRef.current.delete(jobId)
        preparedAudioRef.current.delete(jobId)

        updateJob(jobId, { status: 'canceled', unloadSensitive: false, detail: 'Canceled' })
      }
    },
    [stopConversionQueue, updateJob],
  )

  const activeJobCount = useMemo(() => {
    return jobs.filter((job) => !isTerminalStatus(job.status)).length
  }, [jobs])

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
