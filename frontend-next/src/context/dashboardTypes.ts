import type { CaseMeta as StorageCaseMeta, TranscriptSummary } from '@/lib/storage'
import type { CodecInfo } from '@/lib/ffmpegWorker'
import type { TranscriptListItem } from '@/utils/helpers'

// Extend storage CaseMeta with the transcript_count field used by the dashboard
export type CaseMeta = StorageCaseMeta & { transcript_count: number }

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

export type ActiveFileEntry = {
  file: File
  originalFileName: string
  fileHandle?: FileSystemFileHandle | null
}

export type TranscriptionRuntimeInput = Omit<TranscriptionJobInput, 'file' | 'fileHandle'>

export type MemoryUsage = {
  convertedFiles: number
  preparedAudio: number
  jobFiles: number
  inFlightUploads: number
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

export interface DashboardContextValue {
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

  // Settings
  oncueXmlEnabled: boolean
  setOncueXmlEnabled: (value: boolean) => void
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
