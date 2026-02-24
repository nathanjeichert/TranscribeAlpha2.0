import { useCallback, useRef } from 'react'
import { getAuthHeaders } from '@/utils/auth'
import { apiUrl } from '@/lib/platform/api'
import { nowIso, sleep, getFileExtension } from '@/utils/helpers'
import {
  resolveWorkspaceRelativePathForHandle,
  saveTranscript as localSaveTranscript,
  type TranscriptData,
} from '@/lib/storage'
import { cacheMediaForPlayback } from '@/lib/mediaCache'
import { logger } from '@/utils/logger'
import { getMediaFile, storeMediaHandle } from '@/lib/mediaHandles'
import {
  FFmpegCanceledError,
  cancelActiveFFmpegJob,
  extractAudio,
  extractAudioStereo,
} from '@/lib/ffmpegWorker'
import {
  MAX_PERSISTED_JOBS,
  normalizeChannelLabels,
} from '@/lib/jobPersistence'
import type {
  JobRecord,
  TranscriptionJobInput,
  ActiveFileEntry,
  TranscriptionRuntimeInput,
} from './dashboardTypes'

const AUDIO_EXTRACTION_TIMEOUT_MS = 7 * 60 * 1000
const DIRECT_UPLOAD_FALLBACK_MAX_BYTES = 512 * 1024 * 1024
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 16 * 60 * 1000
const MIN_CONCURRENT_UPLOADS = 2
const MAX_CONCURRENT_UPLOADS = 50

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm'])
const COMPRESSED_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma'])

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

export interface TranscriptionQueueDeps {
  jobsRef: React.MutableRefObject<JobRecord[]>
  jobFilesRef: React.MutableRefObject<Map<string, ActiveFileEntry>>
  jobsHydratedRef: React.MutableRefObject<boolean>
  applyJobsMutation: (updater: (prev: JobRecord[]) => JobRecord[]) => void
  updateJob: (jobId: string, updater: Partial<JobRecord> | ((job: JobRecord) => JobRecord)) => void
  memoryLimitMB: number
  getConvertedBytes: () => number
  setActiveMediaKey: (key: string | null) => void
  refreshCases: () => Promise<void>
  refreshRecentTranscripts: () => Promise<void>
}

export function useTranscriptionQueue(deps: TranscriptionQueueDeps) {
  const {
    jobsRef, jobFilesRef, jobsHydratedRef,
    applyJobsMutation, updateJob, memoryLimitMB,
    getConvertedBytes, setActiveMediaKey,
    refreshCases, refreshRecentTranscripts,
  } = deps

  const transcriptionInputsRef = useRef<Map<string, TranscriptionRuntimeInput>>(new Map())
  const preparedAudioRef = useRef<Map<string, File>>(new Map())
  const abortRef = useRef<Map<string, XMLHttpRequest>>(new Map())
  const inFlightUploadBytesRef = useRef<Map<string, number>>(new Map())
  const activeTranscriptionJobIdsRef = useRef<Set<string>>(new Set())
  const transcriptionRunnerActiveRef = useRef(false)

  const getTotalUsedBytes = useCallback((): number => {
    let preparedAudio = 0
    preparedAudioRef.current.forEach((file) => {
      preparedAudio += file.size
    })

    let inFlightUploads = 0
    inFlightUploadBytesRef.current.forEach((estimatedBytes) => {
      inFlightUploads += estimatedBytes
    })

    return getConvertedBytes() + preparedAudio + inFlightUploads
  }, [getConvertedBytes])

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
  }, [jobsRef, jobFilesRef])

  const getMaxConcurrentUploads = useCallback((): number => {
    const available = getAvailableBudgetBytes()
    const avgFileSize = calculateAverageQueuedFileSize()
    const perSlotCost = Math.max(avgFileSize + 2 * 1024 * 1024, 3 * 1024 * 1024)
    const slots = Math.floor(available / perSlotCost)
    return Math.max(MIN_CONCURRENT_UPLOADS, Math.min(slots, MAX_CONCURRENT_UPLOADS))
  }, [calculateAverageQueuedFileSize, getAvailableBudgetBytes])

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
        if (Date.now() - startedAt > AUDIO_EXTRACTION_TIMEOUT_MS) {
          throw new Error('Memory budget limit reached. Increase Memory Limit in Settings or reduce batch size.')
        }
        await sleep(250)
      }
    },
    [getAvailableBudgetBytes, updateJob],
  )

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
    [jobsRef, jobFilesRef, setActiveMediaKey, refreshCases, refreshRecentTranscripts],
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
            }, AUDIO_EXTRACTION_TIMEOUT_MS)
          })

          const extracted = await Promise.race([extractionPromise, timeoutPromise])
          preparedAudioRef.current.set(jobId, extracted)
          updateJob(jobId, { detail: 'Multichannel audio ready. Preparing upload...' })
          return extracted
        } catch (error) {
          if (error instanceof FFmpegCanceledError && !extractionTimedOut) {
            throw new Error('Preparing multichannel audio was canceled.')
          }

          if (sourceFile.size > DIRECT_UPLOAD_FALLBACK_MAX_BYTES) {
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
          }, AUDIO_EXTRACTION_TIMEOUT_MS)
        })

        const extracted = await Promise.race([extractionPromise, timeoutPromise])
        preparedAudioRef.current.set(jobId, extracted)
        updateJob(jobId, { detail: 'Audio extraction complete. Preparing upload...' })
        return extracted
      } catch (error) {
        if (error instanceof FFmpegCanceledError && !extractionTimedOut) {
          throw new Error('Preparing audio was canceled.')
        }

        if (sourceFile.size > DIRECT_UPLOAD_FALLBACK_MAX_BYTES) {
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
    [jobsRef, updateJob, waitForMemoryBudget, waitForPreparedAudioCapacity],
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

      const endpoint = apiUrl('/api/transcribe')
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
        request.timeout = TRANSCRIBE_REQUEST_TIMEOUT_MS

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
              logger.warn(
                'File missing for job',
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
  }, [jobsRef, jobFilesRef, jobsHydratedRef, getMaxConcurrentUploads, prepareUploadFile, submitTranscriptionJob, updateJob])

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
    [applyJobsMutation, jobFilesRef, runTranscriptionQueue],
  )

  const cleanupTranscriptionJob = useCallback((jobId: string) => {
    transcriptionInputsRef.current.delete(jobId)
    preparedAudioRef.current.delete(jobId)
    inFlightUploadBytesRef.current.delete(jobId)
    activeTranscriptionJobIdsRef.current.delete(jobId)
    const xhr = abortRef.current.get(jobId)
    if (xhr) {
      try { xhr.abort() } catch {}
      abortRef.current.delete(jobId)
    }
  }, [])

  return {
    enqueueTranscriptionJobs,
    runTranscriptionQueue,
    cleanupTranscriptionJob,
  }
}
