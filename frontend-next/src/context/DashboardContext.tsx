'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { getAuthHeaders, getCurrentUser } from '@/utils/auth'
import {
  listCases as localListCases,
  listUncategorizedTranscripts as localListUncategorized,
  listTranscriptsInCase,
  saveTranscript as localSaveTranscript,
  type TranscriptData,
  type TranscriptSummary,
} from '@/lib/storage'
import { storeMediaBlob, storeMediaHandle } from '@/lib/mediaHandles'
import {
  FFmpegCanceledError,
  cancelActiveFFmpegJob,
  convertToPlayable,
  detectCodec,
  extractAudio,
  readConvertedFromCache,
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

  unloadSensitive: boolean

  // Conversion metadata (serializable)
  codec?: CodecInfo | null
  needsConversion?: boolean
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
}

const MAX_PERSISTED_JOBS = 200
const JOB_STORAGE_PREFIX = 'ta_jobs_v1:'

const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024
const CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS = 7 * 60 * 1000
const CRIMINAL_DIRECT_UPLOAD_FALLBACK_MAX_BYTES = 512 * 1024 * 1024
const CRIMINAL_TRANSCRIBE_REQUEST_TIMEOUT_MS = 16 * 60 * 1000

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm'])
const COMPRESSED_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma'])

type ActiveFileEntry = {
  file: File
  originalFileName: string
  fileHandle?: FileSystemFileHandle | null
}

type TranscriptionRuntimeInput = Omit<TranscriptionJobInput, 'file' | 'fileHandle'>

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

  // Jobs (global)
  jobs: JobRecord[]
  activeJobCount: number
  enqueueTranscriptionJobs: (items: TranscriptionJobInput[]) => void
  addConversionJobs: (files: File[]) => Promise<void>
  startConversionQueue: (options?: { promptLargeFiles?: boolean }) => Promise<void>
  stopConversionQueue: () => void
  getConvertedFile: (jobId: string) => File | null
  retryJob: (jobId: string) => void
  cancelJob: (jobId: string) => Promise<void>
  removeJob: (jobId: string) => void
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

  const [jobs, setJobs] = useState<JobRecord[]>([])
  const jobsRef = useRef<JobRecord[]>([])
  const jobsUserKeyRef = useRef<string | null>(null)

  const jobFilesRef = useRef<Map<string, ActiveFileEntry>>(new Map())
  const transcriptionInputsRef = useRef<Map<string, TranscriptionRuntimeInput>>(new Map())
  const convertedFilesRef = useRef<Map<string, File>>(new Map())
  const preparedAudioRef = useRef<Map<string, File>>(new Map())
  const abortRef = useRef<Map<string, XMLHttpRequest>>(new Map())

  const transcriptionRunnerActiveRef = useRef(false)
  const conversionRunnerActiveRef = useRef(false)
  const stopConversionRequestedRef = useRef(false)

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

  // Initialize per-user job persistence key
  useEffect(() => {
    const user = getCurrentUser()
    const username = user?.username || 'unknown'
    jobsUserKeyRef.current = `${JOB_STORAGE_PREFIX}${username}`

    try {
      const raw = localStorage.getItem(jobsUserKeyRef.current)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return

      const loaded: JobRecord[] = []
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue
        const job = entry as Partial<JobRecord>
        if (!job.id || !job.kind || !job.status) continue
        loaded.push({
          id: String(job.id),
          kind: job.kind as JobKind,
          status: job.status as JobStatus,
          title: String(job.title || 'Job'),
          detail: typeof job.detail === 'string' ? job.detail : undefined,
          progress: typeof job.progress === 'number' ? job.progress : undefined,
          error: typeof job.error === 'string' ? job.error : undefined,
          fileSizeBytes: typeof job.fileSizeBytes === 'number' ? job.fileSizeBytes : undefined,
          createdAt: String(job.createdAt || nowIso()),
          updatedAt: String(job.updatedAt || nowIso()),
          mediaKey: typeof job.mediaKey === 'string' ? job.mediaKey : undefined,
          caseId: typeof job.caseId === 'string' ? job.caseId : null,
          transcriptionModel: job.transcriptionModel as any,
          speakersExpected: typeof job.speakersExpected === 'number' ? job.speakersExpected : null,
          sourceFilename: typeof job.sourceFilename === 'string' ? job.sourceFilename : null,
          unloadSensitive: Boolean(job.unloadSensitive),
          codec: (job.codec as CodecInfo | null | undefined) ?? undefined,
          needsConversion: typeof job.needsConversion === 'boolean' ? job.needsConversion : undefined,
        })
      }

      const normalized: JobRecord[] = loaded.map((job): JobRecord => {
        if (isTerminalStatus(job.status)) return job
        // Client-side work cannot resume after reload.
        return {
          ...job,
          status: 'failed',
          error: job.error || 'Interrupted by reload.',
          unloadSensitive: false,
          updatedAt: nowIso(),
        }
      })

      const start = Math.max(0, normalized.length - MAX_PERSISTED_JOBS)
      setJobs(normalized.slice(start))
    } catch {
      // Ignore corrupt or inaccessible localStorage.
    }
  }, [])

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  // Persist jobs to localStorage (metadata only)
  useEffect(() => {
    const key = jobsUserKeyRef.current
    if (!key) return
    try {
      localStorage.setItem(key, JSON.stringify(jobs.slice(0, MAX_PERSISTED_JOBS)))
    } catch {
      // Ignore storage failures
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

  const updateJob = useCallback((jobId: string, updater: Partial<JobRecord> | ((job: JobRecord) => JobRecord)) => {
    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job
        const next = typeof updater === 'function' ? updater(job) : { ...job, ...updater }
        return { ...next, updatedAt: nowIso() }
      }),
    )
  }, [])

  const removeJob = useCallback((jobId: string) => {
    jobFilesRef.current.delete(jobId)
    transcriptionInputsRef.current.delete(jobId)
    convertedFilesRef.current.delete(jobId)
    preparedAudioRef.current.delete(jobId)
    abortRef.current.delete(jobId)
    setJobs((prev) => prev.filter((job) => job.id !== jobId))
  }, [])

  const getConvertedFile = useCallback((jobId: string) => {
    return convertedFilesRef.current.get(jobId) ?? null
  }, [])

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

      const record = transcriptPayload as unknown as TranscriptData
      await localSaveTranscript(mediaKey, record, caseId)

      const activeFile = jobFilesRef.current.get(jobId)
      const shouldPersistBlobFallback = !activeFile?.fileHandle
      const mediaFilename =
        (transcriptPayload.media_filename as string | undefined) ||
        activeFile?.originalFileName ||
        activeFile?.file.name ||
        'media'
      const mediaContentType =
        (transcriptPayload.media_content_type as string | undefined) ||
        activeFile?.file.type ||
        'application/octet-stream'

      try {
        if (activeFile?.fileHandle) {
          await storeMediaHandle(mediaKey, activeFile.fileHandle)
        }
        if (shouldPersistBlobFallback && activeFile?.file) {
          await storeMediaBlob(mediaKey, activeFile.file, mediaFilename, mediaContentType)
        }
      } catch {
        // Media persistence is best-effort; transcript save is the priority.
      }

      setActiveMediaKey(mediaKey)
      await refreshRecentTranscripts()
      if (caseId) {
        await refreshCases()
      }

      return mediaKey
    },
    [refreshCases, refreshRecentTranscripts],
  )

  const prepareUploadFile = useCallback(
    async (jobId: string, sourceFile: File): Promise<File> => {
      // If it's already a compressed audio file (not video), upload directly.
      if (!isLikelyVideoSource(sourceFile) && isLikelyCompressedAudioSource(sourceFile)) {
        return sourceFile
      }

      const cached = preparedAudioRef.current.get(jobId)
      if (cached) return cached

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
            reject(new Error('Audio extraction timed out in browser'))
          }, CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS)
        })

        const extracted = await Promise.race([extractionPromise, timeoutPromise])
        preparedAudioRef.current.set(jobId, extracted)
        updateJob(jobId, { detail: 'Audio extraction complete. Preparing upload...' })
        return extracted
      } catch (error) {
        if (error instanceof FFmpegCanceledError && !extractionTimedOut) {
          throw new Error('Audio extraction canceled.')
        }

        if (sourceFile.size > CRIMINAL_DIRECT_UPLOAD_FALLBACK_MAX_BYTES) {
          const sizeMb = (sourceFile.size / (1024 * 1024)).toFixed(1)
          const reason = extractionTimedOut ? 'Audio extraction timed out in browser.' : 'Audio extraction failed in browser.'
          throw new Error(
            `${reason} Skipping direct upload of the ${sizeMb} MB original file because it is likely to exceed server upload timeout. ` +
              'Use the Converter page (or desktop FFmpeg) to create an MP3, then retry.',
          )
        }

        // Fall back to sending original media when in-browser extraction fails.
        updateJob(jobId, { detail: 'Audio extraction unavailable. Uploading original media...' })
        return sourceFile
      } finally {
        if (timeoutId) window.clearTimeout(timeoutId)
      }
    },
    [updateJob],
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

      const endpoint = '/api/transcribe'

      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest()
        abortRef.current.set(jobId, request)

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
          const message = 'Upload failed. Please try again.'
          updateJob(jobId, { status: 'failed', unloadSensitive: false, error: message, detail: 'Failed' })
          reject(new Error(message))
        }

        request.onabort = () => {
          abortRef.current.delete(jobId)
          updateJob(jobId, { status: 'canceled', unloadSensitive: false, error: 'Canceled.', detail: 'Canceled' })
          const err = new Error('Canceled')
          err.name = 'AbortError'
          reject(err)
        }

        request.ontimeout = () => {
          abortRef.current.delete(jobId)
          const message =
            'Transcription request timed out. For large media, convert to MP3 first (Converter page or desktop FFmpeg) and retry.'
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
      while (true) {
        const nextJob = jobsRef.current.find(
          (job) => job.kind === 'transcription' && job.status === 'queued',
        )
        if (!nextJob) break

        const activeFile = jobFilesRef.current.get(nextJob.id)
        if (!activeFile?.file) {
          updateJob(nextJob.id, {
            status: 'failed',
            unloadSensitive: false,
            detail: 'Failed',
            error: 'File not available (try adding the file again).',
          })
          continue
        }

        const input = transcriptionInputsRef.current.get(nextJob.id)
        if (!input) {
          updateJob(nextJob.id, {
            status: 'failed',
            unloadSensitive: false,
            detail: 'Failed',
            error: 'Job input metadata missing.',
          })
          continue
        }

        updateJob(nextJob.id, { status: 'running', unloadSensitive: true, detail: 'Preparing...' })

        try {
          const fileForUpload = await prepareUploadFile(nextJob.id, activeFile.file)
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
          // Free extracted audio cache for this job once it has completed submission.
          preparedAudioRef.current.delete(nextJob.id)
        }
      }
    } finally {
      transcriptionRunnerActiveRef.current = false
    }
  }, [prepareUploadFile, submitTranscriptionJob, updateJob])

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
          unloadSensitive: false,
        }
        return job
      })

      setJobs((prev) => {
        const combined = [...prev, ...newJobs]
        return combined.slice(Math.max(0, combined.length - MAX_PERSISTED_JOBS))
      })
      void runTranscriptionQueue()
    },
    [runTranscriptionQueue],
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

      setJobs((prev) => {
        const combined = [...prev, ...newJobs]
        return combined.slice(Math.max(0, combined.length - MAX_PERSISTED_JOBS))
      })

      await Promise.allSettled(
        newJobs.map(async (job) => {
          const active = jobFilesRef.current.get(job.id)
          if (!active?.file) return
          try {
            const codec = await detectCodec(active.file)
            if (codec.needsConversion) {
              updateJob(job.id, { codec, needsConversion: true, detail: 'Ready', status: 'queued' })
            } else {
              updateJob(job.id, { codec, needsConversion: false, detail: 'Already OK', status: 'succeeded' })
            }
          } catch {
            updateJob(job.id, { codec: null, needsConversion: true, detail: 'Skipped', status: 'failed', error: 'Could not detect format.' })
          }
        }),
      )
    },
    [updateJob],
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
            updateJob(next.id, { status: 'failed', detail: 'Failed', error: 'File not available.' })
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
            try {
              cached = await readConvertedFromCache(active.file)
            } catch (cacheReadError) {
              console.warn('Converter cache read failed, continuing with conversion.', cacheReadError)
            }

            if (cached) {
              convertedFilesRef.current.set(next.id, cached)
              updateJob(next.id, { status: 'succeeded', unloadSensitive: false, detail: 'Converted', progress: 1 })
              continue
            }

            const converted = await convertToPlayable(active.file, (ratio) => {
              updateJob(next.id, { progress: ratio, detail: 'Converting...' })
            })

            convertedFilesRef.current.set(next.id, converted)

            try {
              await writeConvertedToCache(active.file, converted)
            } catch (cacheWriteError) {
              console.warn('Converter cache write failed, continuing without cache.', cacheWriteError)
            }

            updateJob(next.id, { status: 'succeeded', unloadSensitive: false, detail: 'Converted', progress: 1 })
          } catch (err) {
            if (err instanceof FFmpegCanceledError || stopConversionRequestedRef.current) {
              updateJob(next.id, { status: 'canceled', unloadSensitive: false, detail: 'Canceled', error: 'Conversion canceled.' })
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
    [updateJob],
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
          updateJob(jobId, { status: 'failed', error: 'File not available.' })
          return
        }
        updateJob(jobId, { status: 'queued', error: '', detail: 'Ready', progress: 0 })
        void runConversionQueue()
        return
      }

      if (job.kind === 'transcription') {
        updateJob(jobId, { status: 'queued', error: '', detail: 'Queued', unloadSensitive: false })
        void runTranscriptionQueue()
      }
    },
    [runConversionQueue, runTranscriptionQueue, updateJob],
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
        jobs,
        activeJobCount,
        enqueueTranscriptionJobs,
        addConversionJobs,
        startConversionQueue,
        stopConversionQueue,
        getConvertedFile,
        retryJob,
        cancelJob,
        removeJob,
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
