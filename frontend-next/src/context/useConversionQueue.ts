import { useCallback, useRef } from 'react'
import { logger } from '@/utils/logger'
import {
  readBinaryFile,
  writeBinaryFile,
} from '@/lib/storage'
import {
  FFmpegCanceledError,
  cancelActiveFFmpegJob,
  convertToPlayable,
  detectCodec,
  readConvertedFromCache,
  writeConvertedToCache,
} from '@/lib/ffmpegWorker'
import {
  MAX_PERSISTED_JOBS,
  buildConvertedOutputPath,
} from '@/lib/jobPersistence'
import { nowIso } from '@/utils/helpers'
import type { JobRecord, ActiveFileEntry } from './dashboardTypes'

const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024
const MAX_IN_MEMORY_CONVERTED_FILES = 8

export interface ConversionQueueDeps {
  jobsRef: React.MutableRefObject<JobRecord[]>
  jobFilesRef: React.MutableRefObject<Map<string, ActiveFileEntry>>
  applyJobsMutation: (updater: (prev: JobRecord[]) => JobRecord[]) => void
  updateJob: (jobId: string, updater: Partial<JobRecord> | ((job: JobRecord) => JobRecord)) => void
  memoryLimitMB: number
}

export function useConversionQueue(deps: ConversionQueueDeps) {
  const { jobsRef, jobFilesRef, applyJobsMutation, updateJob, memoryLimitMB } = deps

  const convertedFilesRef = useRef<Map<string, File>>(new Map())
  const convertedReloadingRef = useRef<Set<string>>(new Set())
  const convertedOrderRef = useRef<string[]>([])
  const convertedBytesRef = useRef(0)
  const conversionRunnerActiveRef = useRef(false)
  const stopConversionRequestedRef = useRef(false)

  const removeConvertedFromMemory = useCallback((jobId: string) => {
    const existing = convertedFilesRef.current.get(jobId)
    if (existing) {
      convertedBytesRef.current = Math.max(0, convertedBytesRef.current - existing.size)
    }
    convertedFilesRef.current.delete(jobId)
    convertedOrderRef.current = convertedOrderRef.current.filter((id) => id !== jobId)
  }, [])

  const getConvertedBytes = useCallback((): number => {
    return convertedBytesRef.current
  }, [])

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
  }, [jobsRef, jobFilesRef, persistConvertedOutput, storeConvertedInMemory, updateJob])

  const addConversionJobs = useCallback(
    async (files: File[]) => {
      if (!files.length) return

      const createdAt = nowIso()
      const newJobs: JobRecord[] = files.map((file) => {
        const jobId = crypto.randomUUID()
        jobFilesRef.current.set(jobId, { file, originalFileName: file.name, fileHandle: null })
        return {
          id: jobId,
          kind: 'conversion' as const,
          status: 'queued' as const,
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
    [applyJobsMutation, jobFilesRef, updateJob],
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
              logger.warn('Converter cache read failed, continuing with conversion.', cacheReadError)
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
              logger.warn('Converter cache write failed, continuing without cache.', cacheWriteError)
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
    [jobsRef, jobFilesRef, persistConvertedOutput, storeConvertedInMemory, updateJob],
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

  const cleanupConversionJob = useCallback((jobId: string) => {
    removeConvertedFromMemory(jobId)
    convertedReloadingRef.current.delete(jobId)
  }, [removeConvertedFromMemory])

  return {
    addConversionJobs,
    startConversionQueue,
    stopConversionQueue,
    runConversionQueue,
    getConvertedFile,
    resolveConvertedFile,
    removeConvertedFromMemory,
    getConvertedBytes,
    cleanupConversionJob,
  }
}
