import { nowIso, getFileExtension } from '@/utils/helpers'
import { idbGet, idbPut } from '@/lib/idb'
import { isTerminalStatus } from '@/context/dashboardTypes'
import type { JobRecord, JobKind, JobStatus } from '@/context/dashboardTypes'
import type { CodecInfo } from '@/lib/ffmpegWorker'

export const MAX_PERSISTED_JOBS = 3000
export const JOB_STORAGE_PREFIX = 'ta_jobs_v2:'
export const LEGACY_JOB_STORAGE_PREFIX = 'ta_jobs_v1:'
const JOBS_STORE = 'jobs'

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function normalizeChannelLabels(value: unknown): Record<number, string> | undefined {
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

export function buildConvertedOutputPath(jobId: string, convertedFile: File): string {
  const ext = getFileExtension(convertedFile.name) || 'bin'
  return `cache/converted-jobs/${jobId}.${ext}`
}

export function normalizePersistedJobs(rawJobs: unknown): JobRecord[] {
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

export async function readPersistedJobs(userKey: string, legacyKey: string): Promise<JobRecord[]> {
  try {
    const idbValue = await idbGet<unknown>(JOBS_STORE, userKey)
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

export async function writePersistedJobs(userKey: string, jobs: JobRecord[]): Promise<void> {
  await idbPut(JOBS_STORE, userKey, jobs.slice(Math.max(0, jobs.length - MAX_PERSISTED_JOBS)))
}
