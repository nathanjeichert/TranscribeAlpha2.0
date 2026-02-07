'use client'

import JSZip from 'jszip'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authenticatedFetch, getAuthHeaders } from '@/utils/auth'
import { useDashboard } from '@/context/DashboardContext'
import { routes } from '@/utils/routes'
import {
  confirmQueueNavigation,
  guardedPush,
  setQueueNavigationGuardActive,
} from '@/utils/navigationGuard'
import {
  createCase as localCreateCase,
  saveTranscript as localSaveTranscript,
  type TranscriptData,
} from '@/lib/storage'
import { storeMediaBlob, storeMediaHandle } from '@/lib/mediaHandles'
import {
  cancelActiveFFmpegJob,
  FFmpegCanceledError,
  extractAudio,
} from '@/lib/ffmpegWorker'

interface FormData {
  case_name: string
  case_number: string
  firm_name: string
  input_date: string
  location: string
  transcription_model: 'assemblyai' | 'gemini'
  case_id: string
}

type WizardStep = 'upload' | 'configure' | 'transcribe'
type QueueItemStatus = 'queued' | 'uploading' | 'transcribing' | 'building' | 'done' | 'failed' | 'canceled'

interface TranscriptResponse {
  media_key: string
  lines?: Array<unknown>
  pdf_base64?: string
  docx_base64?: string
  oncue_xml_base64?: string
  viewer_html_base64?: string
  title_data?: Record<string, string>
}

interface QueueItem {
  id: string
  file: File
  originalFileName: string
  fileHandle?: FileSystemFileHandle | null
  status: QueueItemStatus
  stageText: string
  error: string
  result: TranscriptResponse | null
  attemptCount: number
  speaker_names: string
  speakers_expected: string
  case_target: string
}

interface RequestFailure {
  message: string
  retryable: boolean
}

const wizardSteps: Array<{ key: WizardStep; label: string }> = [
  { key: 'upload', label: 'Upload' },
  { key: 'configure', label: 'Configure' },
  { key: 'transcribe', label: 'Results' },
]

const MAX_BATCH_FILES = 50
const RESULTS_PREVIEW_LIMIT = 10
const CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS = 7 * 60 * 1000
const CRIMINAL_DIRECT_UPLOAD_FALLBACK_MAX_BYTES = 512 * 1024 * 1024
const CRIMINAL_TRANSCRIBE_REQUEST_TIMEOUT_MS = 16 * 60 * 1000
const CASE_USE_BATCH = '__batch__'
const CASE_UNCATEGORIZED = '__uncategorized__'
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm'])
const COMPRESSED_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma'])

const buildQueueId = () => `${Date.now()}_${Math.random().toString(16).slice(2)}`

const sanitizeFilenamePart = (value: string) => {
  const sanitized = value
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return sanitized || 'transcript'
}

const stripExtension = (filename: string) => filename.replace(/\.[^.]+$/, '')

const buildFileSignature = (file: File) => `${file.name}::${file.size}::${file.lastModified}`
const getFileExtension = (filename: string) => {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.slice(dot + 1).toLowerCase()
}
const isLikelyVideoSource = (file: File) => {
  if ((file.type || '').startsWith('video/')) return true
  return VIDEO_EXTENSIONS.has(getFileExtension(file.name))
}
const isLikelyCompressedAudioSource = (file: File) => {
  if ((file.type || '').startsWith('audio/')) {
    const extension = getFileExtension(file.name)
    if (!extension) return false
    return COMPRESSED_AUDIO_EXTENSIONS.has(extension)
  }
  return COMPRESSED_AUDIO_EXTENSIONS.has(getFileExtension(file.name))
}

const statusLabel = (status: QueueItemStatus) => {
  if (status === 'queued') return 'Queued'
  if (status === 'uploading') return 'Uploading'
  if (status === 'transcribing') return 'Transcribing'
  if (status === 'building') return 'Building'
  if (status === 'done') return 'Complete'
  if (status === 'failed') return 'Failed'
  return 'Canceled'
}

const statusBadgeClass = (status: QueueItemStatus) => {
  if (status === 'done') return 'bg-green-100 text-green-700'
  if (status === 'failed') return 'bg-red-100 text-red-700'
  if (status === 'canceled') return 'bg-amber-100 text-amber-800'
  if (status === 'queued') return 'bg-gray-100 text-gray-600'
  return 'bg-primary-100 text-primary-700'
}

const isRetryableStatus = (status: number) => status === 429 || (status >= 500 && status <= 599)

export default function TranscribePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { cases, refreshCases, refreshRecentTranscripts, setActiveMediaKey, appVariant } = useDashboard()

  const [step, setStep] = useState<WizardStep>('upload')
  const [formData, setFormData] = useState<FormData>({
    case_name: '',
    case_number: '',
    firm_name: '',
    input_date: '',
    location: '',
    transcription_model: 'assemblyai',
    case_id: '',
  })

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [stopAfterCurrent, setStopAfterCurrent] = useState(false)
  const [pageError, setPageError] = useState('')
  const [pageNotice, setPageNotice] = useState('')
  const [showAllResults, setShowAllResults] = useState(false)
  const [zipBusy, setZipBusy] = useState<'pdf' | 'variant' | null>(null)

  const [showNewCaseModal, setShowNewCaseModal] = useState(false)
  const [newCaseName, setNewCaseName] = useState('')
  const [newCaseDescription, setNewCaseDescription] = useState('')
  const [creatingCase, setCreatingCase] = useState(false)

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueRef = useRef<QueueItem[]>([])
  const stopAfterCurrentRef = useRef(false)
  const skipNextPopstateRef = useRef(false)
  const preparedAudioByItemRef = useRef<Map<string, File>>(new Map())

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    stopAfterCurrentRef.current = stopAfterCurrent
  }, [stopAfterCurrent])

  useEffect(() => {
    const caseIdParam = searchParams.get('case_id')
    if (caseIdParam) {
      setFormData((prev) => ({ ...prev, case_id: caseIdParam }))
    }
  }, [searchParams])

  useEffect(() => {
    if (!isProcessing) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isProcessing])

  useEffect(() => {
    if (!isProcessing) return

    const handlePopstate = () => {
      if (skipNextPopstateRef.current) {
        skipNextPopstateRef.current = false
        return
      }

      if (confirmQueueNavigation()) {
        return
      }

      skipNextPopstateRef.current = true
      window.history.go(1)
    }

    window.addEventListener('popstate', handlePopstate)
    return () => {
      window.removeEventListener('popstate', handlePopstate)
      skipNextPopstateRef.current = false
    }
  }, [isProcessing])

  useEffect(() => {
    setQueueNavigationGuardActive(isProcessing)
    return () => {
      setQueueNavigationGuardActive(false)
    }
  }, [isProcessing])

  const caseNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of cases) {
      map.set(c.case_id, c.name)
    }
    return map
  }, [cases])

  const queuedCount = useMemo(() => queue.filter((item) => item.status === 'queued').length, [queue])
  const doneCount = useMemo(() => queue.filter((item) => item.status === 'done').length, [queue])
  const failedCount = useMemo(() => queue.filter((item) => item.status === 'failed').length, [queue])
  const canceledCount = useMemo(() => queue.filter((item) => item.status === 'canceled').length, [queue])
  const inProgressCount = useMemo(
    () => queue.filter((item) => item.status === 'uploading' || item.status === 'transcribing' || item.status === 'building').length,
    [queue],
  )

  const processedItems = useMemo(
    () => queue.filter((item) => item.status === 'done' || item.status === 'failed' || item.status === 'canceled'),
    [queue],
  )

  const visibleProcessedItems = useMemo(() => {
    if (showAllResults) return processedItems
    return processedItems.slice(0, RESULTS_PREVIEW_LIMIT)
  }, [processedItems, showAllResults])

  const updateQueueItem = useCallback((itemId: string, updater: Partial<QueueItem> | ((current: QueueItem) => QueueItem)) => {
    setQueue((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item
        if (typeof updater === 'function') {
          return updater(item)
        }
        return { ...item, ...updater }
      }),
    )
  }, [])

  const reorderQueue = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return
    setQueue((prev) => {
      const sourceIndex = prev.findIndex((item) => item.id === sourceId)
      const targetIndex = prev.findIndex((item) => item.id === targetId)
      if (sourceIndex === -1 || targetIndex === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
  }, [])

  const createQueueItem = useCallback((file: File, fileHandle?: FileSystemFileHandle | null): QueueItem => {
    return {
      id: buildQueueId(),
      file,
      originalFileName: file.name,
      fileHandle: fileHandle ?? null,
      status: 'queued',
      stageText: 'Queued',
      error: '',
      result: null,
      attemptCount: 0,
      speaker_names: '',
      speakers_expected: '',
      case_target: CASE_USE_BATCH,
    }
  }, [])

  const addFilesToQueue = useCallback(
    (incoming: File[]) => {
      if (!incoming.length) return

      setPageError('')
      setPageNotice('')
      setShowAllResults(false)

      const current = queueRef.current
      const currentHasProcessed = current.some((item) => item.status !== 'queued')
      const currentHasQueued = current.some((item) => item.status === 'queued')
      const baseQueue = currentHasProcessed && !currentHasQueued ? [] : current
      if (baseQueue.length === 0) {
        preparedAudioByItemRef.current.clear()
      }

      const existingSignatures = new Set(baseQueue.map((item) => buildFileSignature(item.file)))
      let duplicateCount = 0
      const dedupedIncoming: File[] = []

      for (const file of incoming) {
        const signature = buildFileSignature(file)
        if (existingSignatures.has(signature)) {
          duplicateCount += 1
        }
        dedupedIncoming.push(file)
        existingSignatures.add(signature)
      }

      const remainingSlots = Math.max(MAX_BATCH_FILES - baseQueue.length, 0)
      if (remainingSlots <= 0) {
        setPageError(`Batch limit reached. Maximum ${MAX_BATCH_FILES} files per run.`)
        return
      }

      const accepted = dedupedIncoming.slice(0, remainingSlots)
      const dropped = dedupedIncoming.length - accepted.length

      const nextItems = accepted.map((file) => createQueueItem(file))
      setQueue([...baseQueue, ...nextItems])

      if (duplicateCount > 0) {
        setPageNotice(`${duplicateCount} duplicate file(s) were added. Duplicates are allowed and will be processed.`)
      }
      if (dropped > 0) {
        setPageError(`Added ${accepted.length} file(s). ${dropped} file(s) were not added because of the ${MAX_BATCH_FILES}-file limit.`)
      }
    },
    [createQueueItem],
  )

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0) return
    addFilesToQueue(Array.from(files))
    event.target.value = ''
  }

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const files = event.dataTransfer.files
      if (!files || files.length === 0) return
      addFilesToQueue(Array.from(files))
    },
    [addFilesToQueue],
  )

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
  }, [])

  const handleOpenFilePicker = useCallback(async () => {
    if (appVariant !== 'criminal') return
    try {
      const handles: FileSystemFileHandle[] = await (window as any).showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: 'Audio/Video files',
            accept: {
              'audio/*': ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac', '.wma'],
              'video/*': ['.mp4', '.mov', '.avi', '.mkv'],
            },
          },
        ],
      })
      if (!handles.length) return

      setPageError('')
      setPageNotice('')
      setShowAllResults(false)

      const current = queueRef.current
      const currentHasProcessed = current.some((item) => item.status !== 'queued')
      const currentHasQueued = current.some((item) => item.status === 'queued')
      const baseQueue = currentHasProcessed && !currentHasQueued ? [] : current
      if (baseQueue.length === 0) {
        preparedAudioByItemRef.current.clear()
      }

      const remainingSlots = Math.max(MAX_BATCH_FILES - baseQueue.length, 0)
      if (remainingSlots <= 0) {
        setPageError(`Batch limit reached. Maximum ${MAX_BATCH_FILES} files per run.`)
        return
      }

      const accepted = handles.slice(0, remainingSlots)
      const dropped = handles.length - accepted.length

      const nextItems: QueueItem[] = []
      for (const handle of accepted) {
        const file = await handle.getFile()
        nextItems.push(createQueueItem(file, handle))
      }
      setQueue([...baseQueue, ...nextItems])

      if (dropped > 0) {
        setPageError(`Added ${accepted.length} file(s). ${dropped} file(s) were not added because of the ${MAX_BATCH_FILES}-file limit.`)
      }
    } catch {
      // User cancelled the file picker
    }
  }, [appVariant, createQueueItem])

  const handleCreateCase = async () => {
    if (!newCaseName.trim()) return
    setCreatingCase(true)
    setPageError('')

    try {
      if (appVariant === 'criminal') {
        const newCaseId = crypto.randomUUID()
        const now = new Date().toISOString()
        await localCreateCase({
          case_id: newCaseId,
          name: newCaseName.trim(),
          description: newCaseDescription.trim(),
          created_at: now,
          updated_at: now,
        })
        await refreshCases()
        setFormData((prev) => ({ ...prev, case_id: newCaseId }))
      } else {
        const response = await authenticatedFetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newCaseName.trim(), description: newCaseDescription.trim() }),
        })
        if (!response.ok) throw new Error('Failed to create case')
        const data = await response.json()
        await refreshCases()
        setFormData((prev) => ({ ...prev, case_id: data.case.case_id }))
      }
      setShowNewCaseModal(false)
      setNewCaseName('')
      setNewCaseDescription('')
    } catch {
      setPageError('Failed to create case')
    } finally {
      setCreatingCase(false)
    }
  }

  const getEffectiveCaseId = useCallback(
    (item: QueueItem) => {
      if (item.case_target === CASE_USE_BATCH) {
        return formData.case_id
      }
      if (item.case_target === CASE_UNCATEGORIZED) {
        return ''
      }
      return item.case_target
    },
    [formData.case_id],
  )

  const buildRequestFormData = useCallback(
    (item: QueueItem) => {
      const submitFormData = new FormData()
      submitFormData.append('file', item.file)
      submitFormData.append('transcription_model', formData.transcription_model)
      if (appVariant === 'criminal' && item.originalFileName) {
        submitFormData.append('source_filename', item.originalFileName)
      }

      if (formData.case_name.trim()) submitFormData.append('case_name', formData.case_name.trim())
      if (formData.case_number.trim()) submitFormData.append('case_number', formData.case_number.trim())
      if (formData.firm_name.trim()) submitFormData.append('firm_name', formData.firm_name.trim())
      if (formData.input_date) submitFormData.append('input_date', formData.input_date)
      if (formData.location.trim()) submitFormData.append('location', formData.location.trim())

      const effectiveCaseId = getEffectiveCaseId(item)
      // Criminal variant: don't send case_id to backend (backend doesn't persist)
      if (effectiveCaseId && appVariant !== 'criminal') {
        submitFormData.append('case_id', effectiveCaseId)
      }

      if (item.speaker_names.trim()) {
        submitFormData.append('speaker_names', item.speaker_names.trim())
      }

      const expectedSpeakers = Number(item.speakers_expected)
      if (Number.isInteger(expectedSpeakers) && expectedSpeakers > 0) {
        submitFormData.append('speakers_expected', String(expectedSpeakers))
      }

      return submitFormData
    },
    [appVariant, formData, getEffectiveCaseId],
  )

  const transcribeOneItem = useCallback(
    async (item: QueueItem): Promise<TranscriptResponse> => {
      const submitFormData = buildRequestFormData(item)

      return new Promise<TranscriptResponse>((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open('POST', '/api/transcribe', true)
        request.responseType = 'json'
        request.timeout = CRIMINAL_TRANSCRIBE_REQUEST_TIMEOUT_MS

        const authHeaders = getAuthHeaders()
        Object.entries(authHeaders).forEach(([key, value]) => {
          request.setRequestHeader(key, String(value))
        })

        const isVideoFile =
          (item.file.type || '').startsWith('video/') || /\.(mp4|mov|avi|mkv)$/i.test(item.file.name)

        let stageTimer: number | null = null
        const clearStageTimer = () => {
          if (stageTimer) {
            window.clearTimeout(stageTimer)
            stageTimer = null
          }
        }

        updateQueueItem(item.id, {
          status: 'uploading',
          stageText: 'Uploading media...',
          error: '',
        })

        request.upload.onprogress = () => {
          updateQueueItem(item.id, {
            status: 'uploading',
            stageText: 'Uploading media...',
          })
        }

        request.upload.onload = () => {
          clearStageTimer()
          if (isVideoFile) {
            updateQueueItem(item.id, {
              status: 'transcribing',
              stageText: 'Converting to audio...',
            })
            stageTimer = window.setTimeout(() => {
              updateQueueItem(item.id, {
                status: 'transcribing',
                stageText: 'Transcribing (this may take a few minutes)...',
              })
              stageTimer = null
            }, 1200)
          } else {
            updateQueueItem(item.id, {
              status: 'transcribing',
              stageText: 'Transcribing (this may take a few minutes)...',
            })
          }
        }

        request.onload = () => {
          clearStageTimer()
          const responseData =
            request.response
            ?? (() => {
              try {
                return JSON.parse(request.responseText)
              } catch {
                return null
              }
            })()

          if (request.status >= 200 && request.status < 300) {
            updateQueueItem(item.id, {
              status: 'building',
              stageText: 'Producing transcript...',
            })
            resolve(responseData as TranscriptResponse)
            return
          }

          let detail = responseData?.detail || 'Transcription failed'
          if (request.status === 408) {
            detail = 'Request timed out while uploading or processing media. This usually means the source file is too large for direct upload.'
          }
          const failure: RequestFailure = {
            message: detail,
            retryable: isRetryableStatus(request.status),
          }
          reject(failure)
        }

        request.onerror = () => {
          clearStageTimer()
          reject({
            message: 'Upload failed. Please try again.',
            retryable: true,
          } satisfies RequestFailure)
        }

        request.ontimeout = () => {
          clearStageTimer()
          reject({
            message:
              'Transcription request timed out. For large media, convert to MP3 first (Converter page or desktop FFmpeg) and retry.',
            retryable: false,
          } satisfies RequestFailure)
        }

        request.send(submitFormData)
      })
    },
    [buildRequestFormData, updateQueueItem],
  )

  const prepareUploadFile = useCallback(
    async (item: QueueItem): Promise<File> => {
      if (appVariant !== 'criminal') return item.file

      if (!isLikelyVideoSource(item.file) && isLikelyCompressedAudioSource(item.file)) {
        updateQueueItem(item.id, {
          status: 'transcribing',
          stageText: 'Using source audio upload...',
          error: '',
        })
        return item.file
      }

      const cachedAudio = preparedAudioByItemRef.current.get(item.id)
      if (cachedAudio) {
        updateQueueItem(item.id, {
          status: 'transcribing',
          stageText: 'Using prepared audio upload...',
          error: '',
        })
        return cachedAudio
      }

      updateQueueItem(item.id, {
        status: 'transcribing',
        stageText: 'Extracting compressed mono audio for upload...',
        error: '',
      })

      let extractionTimedOut = false
      try {
        let timeoutId: number | null = null
        try {
          const extractionPromise = extractAudio(item.file, (ratio) => {
            updateQueueItem(item.id, {
              status: 'transcribing',
              stageText: `Extracting compressed mono audio for upload... ${Math.round(ratio * 100)}%`,
            })
          })
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(() => {
              extractionTimedOut = true
              cancelActiveFFmpegJob()
              reject(new Error('Audio extraction timed out in browser'))
            }, CRIMINAL_AUDIO_EXTRACTION_TIMEOUT_MS)
          })
          const extractedAudio = await Promise.race([extractionPromise, timeoutPromise])
          preparedAudioByItemRef.current.set(item.id, extractedAudio)
          updateQueueItem(item.id, {
            status: 'transcribing',
            stageText: 'Audio extraction complete. Preparing upload...',
          })
          return extractedAudio
        } finally {
          if (timeoutId) {
            window.clearTimeout(timeoutId)
          }
        }
      } catch (error) {
        if (error instanceof FFmpegCanceledError && !extractionTimedOut) {
          throw {
            message: 'Audio extraction canceled.',
            retryable: false,
          } satisfies RequestFailure
        }

        if (item.file.size > CRIMINAL_DIRECT_UPLOAD_FALLBACK_MAX_BYTES) {
          const sizeMb = (item.file.size / (1024 * 1024)).toFixed(1)
          const reason = extractionTimedOut
            ? 'Audio extraction timed out in browser.'
            : 'Audio extraction failed in browser.'
          throw {
            message:
              `${reason} Skipping direct upload of the ${sizeMb} MB original file because it is likely to exceed server upload timeout. ` +
              'Use the Converter page (or desktop FFmpeg) to create an MP3, then retry.',
            retryable: false,
          } satisfies RequestFailure
        }

        // Fall back to sending original media when in-browser extraction fails.
        // The backend can still convert before transcription.
        updateQueueItem(item.id, {
          status: 'transcribing',
          stageText: 'Audio extraction unavailable. Uploading original media...',
        })
        return item.file
      }
    },
    [appVariant, updateQueueItem],
  )

  const runQueue = useCallback(
    async (targetStatuses: QueueItemStatus[]) => {
      if (isProcessing) return

      setPageError('')
      setPageNotice('')
      setStep('transcribe')
      setIsProcessing(true)
      setStopAfterCurrent(false)
      stopAfterCurrentRef.current = false

      const targetStatusSet = new Set(targetStatuses)
      const snapshot = queueRef.current
      const targetIds = snapshot
        .filter((item) => targetStatusSet.has(item.status))
        .map((item) => item.id)

      if (!targetIds.length) {
        setIsProcessing(false)
        setPageNotice('No files matched that action.')
        return
      }

      const targetIdSet = new Set(targetIds)
      setQueue((prev) =>
        prev.map((item) => {
          if (!targetIdSet.has(item.id)) return item
          return {
            ...item,
            status: 'queued',
            stageText: 'Queued',
            error: '',
          }
        }),
      )

      let needsCaseRefresh = false

      for (const itemId of targetIds) {
        if (stopAfterCurrentRef.current) {
          break
        }

        const currentItem = queueRef.current.find((entry) => entry.id === itemId)
        if (!currentItem) {
          continue
        }

        let succeeded = false

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const freshItem = queueRef.current.find((entry) => entry.id === itemId)
          if (!freshItem) break

          updateQueueItem(itemId, {
            attemptCount: attempt + 1,
            error: '',
            stageText: attempt === 0 ? 'Queued' : 'Retrying once...',
            status: attempt === 0 ? 'queued' : 'uploading',
          })

          try {
            const fileForUpload = await prepareUploadFile(freshItem)
            const uploadItem: QueueItem = fileForUpload === freshItem.file
              ? freshItem
              : { ...freshItem, file: fileForUpload }
            const data = await transcribeOneItem(uploadItem)

            // Criminal variant: save transcript + playable media source to local workspace.
            if (appVariant === 'criminal' && data.media_key) {
              const effectiveCaseId = getEffectiveCaseId(freshItem)
              const titleData = { ...(data.title_data || {}) }
              const shouldPersistBlobFallback = !freshItem.fileHandle
              const mediaFilename = freshItem.originalFileName || freshItem.file.name
              const mediaContentType = freshItem.file.type || 'application/octet-stream'
              if (freshItem.originalFileName) {
                titleData.FILE_NAME = freshItem.originalFileName
              }
              const transcriptToSave = {
                ...(data as unknown as Record<string, unknown>),
                title_data: titleData,
                media_filename: mediaFilename,
                media_content_type: mediaContentType,
                media_handle_id: data.media_key,
              } as TranscriptData
              await localSaveTranscript(
                data.media_key,
                transcriptToSave,
                effectiveCaseId || undefined,
              )

              try {
                // Store file handle when available (picker flow), and persist a blob fallback
                // when there is no handle.
                if (freshItem.fileHandle) {
                  await storeMediaHandle(data.media_key, freshItem.fileHandle)
                }
                if (shouldPersistBlobFallback) {
                  await storeMediaBlob(
                    data.media_key,
                    freshItem.file,
                    mediaFilename,
                    mediaContentType,
                  )
                }
              } catch {
                setPageNotice(
                  'Transcript saved, but media auto-linking was incomplete. You may need to relink the media in Editor/Viewer.',
                )
              }
            }

            updateQueueItem(itemId, {
              status: 'done',
              stageText: 'Complete',
              error: '',
              result: data,
              attemptCount: attempt + 1,
            })
            setActiveMediaKey(data.media_key)
            await refreshRecentTranscripts()

            const effectiveCaseId = getEffectiveCaseId(freshItem)
            if (effectiveCaseId) {
              needsCaseRefresh = true
            }

            succeeded = true
            break
          } catch (err) {
            const failure = err as RequestFailure
            const retryable = failure?.retryable ?? false
            const message = failure?.message || 'Transcription failed'

            if (attempt === 0 && retryable) {
              updateQueueItem(itemId, {
                status: 'uploading',
                stageText: 'Retrying once...',
                error: '',
                attemptCount: attempt + 1,
              })
              continue
            }

            updateQueueItem(itemId, {
              status: 'failed',
              stageText: 'Failed',
              error: message,
              attemptCount: attempt + 1,
            })
          }
        }

        preparedAudioByItemRef.current.delete(itemId)

        if (!succeeded) {
          // Continue with next file.
        }
      }

      if (stopAfterCurrentRef.current) {
        const pendingIds = new Set(targetIds)
        setQueue((prev) =>
          prev.map((item) => {
            if (!pendingIds.has(item.id)) return item
            if (item.status === 'queued') {
              return {
                ...item,
                status: 'canceled',
                stageText: 'Canceled before start',
                error: 'Processing was stopped before this file started.',
              }
            }
            return item
          }),
        )
        setPageNotice('Queue stopped. Current item finished; remaining queued items were canceled.')
      }

      if (needsCaseRefresh) {
        await refreshCases()
      }

      setIsProcessing(false)
      setStopAfterCurrent(false)
      stopAfterCurrentRef.current = false
    },
    [
      appVariant,
      getEffectiveCaseId,
      isProcessing,
      refreshCases,
      refreshRecentTranscripts,
      setActiveMediaKey,
      prepareUploadFile,
      transcribeOneItem,
      updateQueueItem,
    ],
  )

  const handleStartQueued = () => {
    if (!queue.length) {
      setPageError('Please add at least one file.')
      return
    }
    void runQueue(['queued'])
  }

  const handleRetryFailures = () => {
    void runQueue(['failed', 'canceled'])
  }

  const handleStopQueue = () => {
    setStopAfterCurrent(true)
    stopAfterCurrentRef.current = true
  }

  const downloadBase64File = (base64Data: string, filename: string, mimeType: string) => {
    const byteCharacters = atob(base64Data)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i += 1) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    const byteArray = new Uint8Array(byteNumbers)
    const blob = new Blob([byteArray], { type: mimeType })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(objectUrl)
  }

  const buildItemFilename = useCallback(
    (item: QueueItem, extension: '.pdf' | '.xml' | '.html') => {
      const titleData = item.result?.title_data || {}
      const caseName = titleData.CASE_NAME || formData.case_name || stripExtension(item.file.name)
      const datePart = titleData.DATE || formData.input_date
      const sanitizedBase = sanitizeFilenamePart(caseName)
      return `${sanitizedBase}${datePart ? `-${datePart}` : ''}${extension}`
    },
    [formData.case_name, formData.input_date],
  )

  const handleDownloadBatchZip = useCallback(
    async (kind: 'pdf' | 'variant') => {
      const completed = queueRef.current.filter((item) => item.status === 'done' && item.result)
      if (!completed.length) {
        setPageError('No completed transcripts available to download.')
        return
      }

      setPageError('')
      setZipBusy(kind)

      try {
        const zip = new JSZip()
        const usedNames = new Set<string>()

        const reserveUniqueName = (baseName: string) => {
          if (!usedNames.has(baseName)) {
            usedNames.add(baseName)
            return baseName
          }

          const dotIndex = baseName.lastIndexOf('.')
          const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName
          const ext = dotIndex > 0 ? baseName.slice(dotIndex) : ''

          let counter = 2
          while (true) {
            const candidate = `${stem}-${counter}${ext}`
            if (!usedNames.has(candidate)) {
              usedNames.add(candidate)
              return candidate
            }
            counter += 1
          }
        }

        let addedCount = 0

        for (const item of completed) {
          const payload = item.result
          if (!payload) continue

          if (kind === 'pdf') {
            const pdfData = payload.pdf_base64 ?? payload.docx_base64
            if (!pdfData) continue
            const filename = reserveUniqueName(buildItemFilename(item, '.pdf'))
            zip.file(filename, pdfData, { base64: true })
            addedCount += 1
            continue
          }

          if (appVariant === 'oncue') {
            if (!payload.oncue_xml_base64) continue
            const filename = reserveUniqueName(buildItemFilename(item, '.xml'))
            zip.file(filename, payload.oncue_xml_base64, { base64: true })
            addedCount += 1
          } else {
            if (!payload.viewer_html_base64) continue
            const filename = reserveUniqueName(buildItemFilename(item, '.html'))
            zip.file(filename, payload.viewer_html_base64, { base64: true })
            addedCount += 1
          }
        }

        if (addedCount === 0) {
          setPageError(kind === 'pdf' ? 'No PDF files available to bundle.' : `No ${appVariant === 'oncue' ? 'XML' : 'HTML'} files available to bundle.`)
          return
        }

        const blob = await zip.generateAsync({ type: 'blob' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        const stamp = new Date().toISOString().slice(0, 10)
        anchor.download =
          kind === 'pdf'
            ? `transcribealpha-pdfs-${stamp}.zip`
            : `transcribealpha-${appVariant === 'oncue' ? 'xml' : 'html'}-${stamp}.zip`
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        URL.revokeObjectURL(url)
      } catch {
        setPageError('Failed to generate ZIP archive.')
      } finally {
        setZipBusy(null)
      }
    },
    [appVariant, buildItemFilename],
  )

  const hasQueue = queue.length > 0
  const isBatchSelection = queue.length > 1
  const singleQueueItem = queue[0] ?? null
  const hasProcessed = isProcessing || processedItems.length > 0
  const canProceedToConfig = hasQueue
  const canProceedToTranscribe = queuedCount > 0
  const currentStepIndex = wizardSteps.findIndex((wizardStep) => wizardStep.key === step)

  const canNavigateToStep = (targetStep: WizardStep) => {
    if (targetStep === 'upload') return true
    if (targetStep === 'configure') return canProceedToConfig
    return hasProcessed
  }

  const setFileCaseTarget = (itemId: string, value: string) => {
    updateQueueItem(itemId, { case_target: value })
  }

  const setFileSpeakerNames = (itemId: string, value: string) => {
    updateQueueItem(itemId, { speaker_names: value })
  }

  const setFileSpeakersExpected = (itemId: string, value: string) => {
    updateQueueItem(itemId, { speakers_expected: value })
  }

  const resetForNewBatch = () => {
    if (isProcessing) return
    preparedAudioByItemRef.current.clear()
    setQueue([])
    setStep('upload')
    setShowAllResults(false)
    setPageError('')
    setPageNotice('')
  }

  const renderCaseTargetLabel = (item: QueueItem) => {
    const effective = getEffectiveCaseId(item)
    if (!effective) return 'Uncategorized'
    return caseNameById.get(effective) || 'Assigned Case'
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">New Transcript</h1>
          <p className="text-gray-600 mt-1">
            {isBatchSelection
              ? `Upload up to ${MAX_BATCH_FILES} files and process them in a managed queue.`
              : 'Upload one file to transcribe, or add more files to run as a batch.'}
          </p>
        </div>
      </div>

      <div className="flex items-center mb-8">
        {wizardSteps.map((wizardStep, i) => (
          <div key={wizardStep.key} className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (canNavigateToStep(wizardStep.key)) {
                  setStep(wizardStep.key)
                }
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                step === wizardStep.key
                  ? 'bg-primary-600 text-white'
                  : currentStepIndex > i
                    ? 'text-primary-600 hover:bg-primary-50'
                    : 'text-gray-400'
              }`}
              disabled={!canNavigateToStep(wizardStep.key)}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-sm ${
                  step === wizardStep.key ? 'bg-white text-primary-600' : 'bg-gray-200 text-gray-600'
                }`}
              >
                {i + 1}
              </span>
              <span>{wizardStep.label}</span>
            </button>
            {i < wizardSteps.length - 1 && (
              <div
                className={`w-12 h-0.5 mx-2 ${
                  currentStepIndex > i ? 'bg-primary-600' : 'bg-gray-200'
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {(pageError || pageNotice) && (
        <div className="space-y-3 mb-6">
          {pageError && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{pageError}</div>}
          {pageNotice && <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">{pageNotice}</div>}
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
              Upload Media {isBatchSelection ? 'Files' : 'File'}
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              {isBatchSelection
                ? `Choose up to ${MAX_BATCH_FILES} files. Drag the grip handle in the queue to reorder.`
                : `Choose one or more audio/video files. Select multiple files to run a batch (up to ${MAX_BATCH_FILES}).`}
            </p>

            <label
              htmlFor="media-upload"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className="block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors border-gray-300 hover:border-primary-400 hover:bg-primary-50"
            >
              <input
                id="media-upload"
                type="file"
                ref={fileInputRef}
                onChange={handleFileInputChange}
                multiple
                accept="audio/*,video/*,.mp4,.avi,.mov,.mkv,.wav,.mp3,.m4a,.flac,.ogg"
                className="sr-only"
              />
              <div className="space-y-3">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto">
                  <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                <div className="font-medium text-gray-900">
                  {isBatchSelection ? 'Drop files here or click to browse' : 'Drop file(s) here or click to browse'}
                </div>
                <div className="text-sm text-gray-500">Supports MP4, MOV, AVI, WAV, MP3, FLAC and more</div>
              </div>
            </label>

            {appVariant === 'criminal' && (
              <button
                type="button"
                onClick={handleOpenFilePicker}
                className="mt-3 w-full py-2.5 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 transition-colors"
              >
                Browse Files (preserves file access for playback)
              </button>
            )}
          </div>

          {queue.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">Queue</h3>
                  <p className="text-sm text-gray-500">
                    {queue.length} file{queue.length !== 1 ? 's' : ''} selected
                  </p>
                </div>
                {!isProcessing && (
                  <button
                    type="button"
                    onClick={() => setQueue([])}
                    className="btn-outline text-sm px-3 py-1"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="divide-y divide-gray-100">
                {queue.map((item, index) => (
                  <div
                    key={item.id}
                    draggable={!isProcessing}
                    onDragStart={() => setDraggingId(item.id)}
                    onDragOver={(event) => {
                      event.preventDefault()
                      if (draggingId && draggingId !== item.id) {
                        setDragOverId(item.id)
                      }
                    }}
                    onDragEnd={() => {
                      setDraggingId(null)
                      setDragOverId(null)
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (!draggingId) return
                      reorderQueue(draggingId, item.id)
                      setDraggingId(null)
                      setDragOverId(null)
                    }}
                    className={`p-4 flex items-center gap-4 ${dragOverId === item.id ? 'bg-primary-50' : 'bg-white'}`}
                  >
                    <div className="text-gray-400 cursor-grab" title="Drag to reorder">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                      </svg>
                    </div>
                    <div className="w-8 h-8 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center text-sm font-semibold">
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{item.file.name}</p>
                      <p className="text-sm text-gray-500">{(item.file.size / (1024 * 1024)).toFixed(1)} MB</p>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusBadgeClass(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                    {!isProcessing && (
                      <button
                        type="button"
                        onClick={() => {
                          preparedAudioByItemRef.current.delete(item.id)
                          setQueue((prev) => prev.filter((entry) => entry.id !== item.id))
                        }}
                        className="text-gray-400 hover:text-red-600 transition-colors"
                        title="Remove"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setStep('configure')}
              disabled={!canProceedToConfig}
              className="btn-primary px-8 py-3"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'configure' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Assign to Case (Recommended)</h2>
            <p className="text-sm text-gray-500 mb-4">
              {isBatchSelection
                ? 'Batch default case assignment. Each file can optionally override this below.'
                : 'Case assignment for this transcript.'}
            </p>
            <div className="flex gap-3">
              <select
                name="case_id"
                value={formData.case_id}
                onChange={(event) => setFormData((prev) => ({ ...prev, case_id: event.target.value }))}
                className="input-field flex-1"
              >
                <option value="">{appVariant === 'criminal' ? 'No case (uncategorized)' : 'No case (expires in 30 days)'}</option>
                {cases.map((c) => (
                  <option key={c.case_id} value={c.case_id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setShowNewCaseModal(true)} className="btn-outline whitespace-nowrap">
                + New Case
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">{isBatchSelection ? 'Batch Metadata Defaults' : 'Transcript Metadata'}</h2>
              <span className="text-sm text-gray-400">{isBatchSelection ? 'Applied to all files in this run' : 'Applied to this transcript'}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Name</label>
                <input
                  type="text"
                  value={formData.case_name}
                  onChange={(event) => setFormData((prev) => ({ ...prev, case_name: event.target.value }))}
                  className="input-field"
                  placeholder="e.g., Smith vs. Johnson"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Number</label>
                <input
                  type="text"
                  value={formData.case_number}
                  onChange={(event) => setFormData((prev) => ({ ...prev, case_number: event.target.value }))}
                  className="input-field"
                  placeholder="e.g., CV-2023-001234"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Firm / Organization</label>
                <input
                  type="text"
                  value={formData.firm_name}
                  onChange={(event) => setFormData((prev) => ({ ...prev, firm_name: event.target.value }))}
                  className="input-field"
                  placeholder="e.g., Legal Associates LLC"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input
                  type="date"
                  value={formData.input_date}
                  onChange={(event) => setFormData((prev) => ({ ...prev, input_date: event.target.value }))}
                  className="input-field"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                <input
                  type="text"
                  value={formData.location}
                  onChange={(event) => setFormData((prev) => ({ ...prev, location: event.target.value }))}
                  className="input-field"
                  placeholder="e.g., Conference Room A"
                />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Transcription Model</h2>
            <select
              value={formData.transcription_model}
              onChange={(event) =>
                setFormData((prev) => ({
                  ...prev,
                  transcription_model: event.target.value as 'assemblyai' | 'gemini',
                }))
              }
              className="input-field"
            >
              <option value="assemblyai">AssemblyAI (Recommended)</option>
              <option value="gemini">Gemini 3.0 Pro</option>
            </select>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">{isBatchSelection ? 'Per-File Overrides' : 'Transcript Options'}</h2>
              <p className="text-sm text-gray-500 mt-1">
                {isBatchSelection
                  ? 'Set optional speaker hints and case override per file.'
                  : 'Set optional speaker hints for this transcript.'}
              </p>
            </div>
            <div className="divide-y divide-gray-100">
              {queue.map((item, index) => (
                <div key={item.id} className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-gray-900">
                        {index + 1}. {item.file.name}
                      </p>
                      <p className="text-xs text-gray-500">{(item.file.size / (1024 * 1024)).toFixed(1)} MB</p>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusBadgeClass(item.status)}`}>
                      {statusLabel(item.status)}
                    </span>
                  </div>

                  <div className={`grid grid-cols-1 ${isBatchSelection ? 'lg:grid-cols-3' : 'lg:grid-cols-2'} gap-3`}>
                    {isBatchSelection && (
                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                          Case Assignment
                        </label>
                        <select
                          value={item.case_target}
                          onChange={(event) => setFileCaseTarget(item.id, event.target.value)}
                          disabled={isProcessing}
                          className="input-field text-sm"
                        >
                          <option value={CASE_USE_BATCH}>Use batch setting</option>
                          <option value={CASE_UNCATEGORIZED}>No case (uncategorized)</option>
                          {cases.map((c) => (
                            <option key={c.case_id} value={c.case_id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-gray-500 mt-1">Current: {renderCaseTargetLabel(item)}</p>
                      </div>
                    )}

                    <div className={isBatchSelection ? 'lg:col-span-2' : ''}>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                        Speaker Names (Optional)
                      </label>
                      <input
                        type="text"
                        value={item.speaker_names}
                        onChange={(event) => setFileSpeakerNames(item.id, event.target.value)}
                        disabled={isProcessing}
                        className="input-field text-sm"
                        placeholder="e.g., John Smith, Jane Doe"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                        Number of Speakers (Optional)
                      </label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={item.speakers_expected}
                        onChange={(event) => setFileSpeakersExpected(item.id, event.target.value)}
                        disabled={isProcessing}
                        className="input-field text-sm"
                        placeholder="e.g., 2"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-between">
            <button type="button" onClick={() => setStep('upload')} className="btn-outline px-6 py-3">
              Back
            </button>
            <button
              type="button"
              onClick={handleStartQueued}
              disabled={!canProceedToTranscribe || isProcessing}
              className="btn-primary px-8 py-3"
            >
              {isBatchSelection ? 'Start Queue' : 'Start Transcription'}
            </button>
          </div>
        </div>
      )}

      {step === 'transcribe' && (
        <div className="space-y-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-900 text-sm">
            {isBatchSelection
              ? 'Keep this tab open while processing. If you leave or close the tab, queued work stops.'
              : 'Keep this tab open while processing. If you leave or close the tab, transcription stops.'}
          </div>

          {isBatchSelection ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Queue Progress</h2>
                  <p className="text-sm text-gray-500">
                    {doneCount} complete, {failedCount} failed, {canceledCount} canceled, {queuedCount} queued
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {isProcessing ? (
                    <>
                      <span className="text-sm text-primary-700 font-medium">
                        {stopAfterCurrent ? 'Stopping after current file...' : `${inProgressCount || 1} file in progress`}
                      </span>
                      <button
                        type="button"
                        onClick={handleStopQueue}
                        disabled={stopAfterCurrent}
                        className="btn-outline px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Stop Queue
                      </button>
                    </>
                  ) : (
                    <>
                      {queuedCount > 0 && (
                        <button type="button" onClick={handleStartQueued} className="btn-primary px-3 py-2 text-sm">
                          Resume Queue
                        </button>
                      )}
                      {(failedCount > 0 || canceledCount > 0) && (
                        <button type="button" onClick={handleRetryFailures} className="btn-outline px-3 py-2 text-sm">
                          Retry Failed/Canceled
                        </button>
                      )}
                      <button type="button" onClick={resetForNewBatch} className="btn-outline px-3 py-2 text-sm">
                        New Batch
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="divide-y divide-gray-100">
                {queue.map((item, index) => (
                  <div key={item.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 truncate">
                          {index + 1}. {item.file.name}
                        </p>
                        <p className="text-sm text-gray-500">{item.stageText}</p>
                        {item.error && <p className="text-sm text-red-600 mt-1">{item.error}</p>}
                      </div>
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusBadgeClass(item.status)}`}>
                        {statusLabel(item.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Transcription Status</h2>
                  <p className="text-sm text-gray-500">{singleQueueItem?.file.name ?? 'No file selected'}</p>
                </div>
                <div className="flex items-center gap-2">
                  {isProcessing ? (
                    <>
                      <span className="text-sm text-primary-700 font-medium">
                        {stopAfterCurrent ? 'Stopping after current file...' : 'Processing...'}
                      </span>
                      <button
                        type="button"
                        onClick={handleStopQueue}
                        disabled={stopAfterCurrent}
                        className="btn-outline px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Stop
                      </button>
                    </>
                  ) : (
                    <>
                      {queuedCount > 0 && (
                        <button type="button" onClick={handleStartQueued} className="btn-primary px-3 py-2 text-sm">
                          Start Transcription
                        </button>
                      )}
                      {(failedCount > 0 || canceledCount > 0) && (
                        <button type="button" onClick={handleRetryFailures} className="btn-outline px-3 py-2 text-sm">
                          Retry
                        </button>
                      )}
                      <button type="button" onClick={resetForNewBatch} className="btn-outline px-3 py-2 text-sm">
                        New Transcript
                      </button>
                    </>
                  )}
                </div>
              </div>
              {singleQueueItem && (
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{singleQueueItem.file.name}</p>
                      <p className="text-sm text-gray-500">{singleQueueItem.stageText}</p>
                      {singleQueueItem.error && <p className="text-sm text-red-600 mt-1">{singleQueueItem.error}</p>}
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusBadgeClass(singleQueueItem.status)}`}>
                      {statusLabel(singleQueueItem.status)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {doneCount > 0 && isBatchSelection && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
              <h3 className="font-semibold text-gray-900 mb-3">Batch Downloads</h3>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => handleDownloadBatchZip('pdf')}
                  disabled={zipBusy !== null}
                  className="btn-primary px-4 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {zipBusy === 'pdf' ? 'Building PDF ZIP...' : 'Download All PDFs (.zip)'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadBatchZip('variant')}
                  disabled={zipBusy !== null}
                  className="btn-primary px-4 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {zipBusy === 'variant'
                    ? `Building ${appVariant === 'oncue' ? 'XML' : 'HTML'} ZIP...`
                    : `Download All ${appVariant === 'oncue' ? 'OnCue XML' : 'HTML Viewer'} (.zip)`}
                </button>
              </div>
            </div>
          )}

          {processedItems.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-semibold text-gray-900">Results</h3>
                {processedItems.length > RESULTS_PREVIEW_LIMIT && (
                  <button
                    type="button"
                    onClick={() => setShowAllResults((prev) => !prev)}
                    className="text-sm text-primary-600 hover:text-primary-700"
                  >
                    {showAllResults ? 'Show fewer' : `Show all (${processedItems.length})`}
                  </button>
                )}
              </div>
              <div className="divide-y divide-gray-100">
                {visibleProcessedItems.map((item) => {
                  const result = item.result
                  const lineCount = Array.isArray(result?.lines) ? result?.lines.length : 0
                  const effectiveCaseId = getEffectiveCaseId(item)

                  return (
                    <div key={item.id} className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 truncate">{item.file.name}</p>
                          <p className="text-sm text-gray-500">
                            {item.status === 'done'
                              ? `${lineCount} transcript lines`
                              : item.status === 'failed'
                                ? `Failed${item.attemptCount > 1 ? ' after retry' : ''}`
                                : 'Canceled'}
                          </p>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusBadgeClass(item.status)}`}>
                          {statusLabel(item.status)}
                        </span>
                      </div>

                      {item.error && <p className="text-sm text-red-600">{item.error}</p>}

                      {item.status === 'done' && result && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMediaKey(result.media_key)
                              guardedPush(router, routes.editor(result.media_key))
                            }}
                            className="btn-primary text-sm px-3 py-2"
                          >
                            Open Editor
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              const pdfData = result.pdf_base64 ?? result.docx_base64
                              if (!pdfData) return
                              downloadBase64File(pdfData, buildItemFilename(item, '.pdf'), 'application/pdf')
                            }}
                            disabled={!result.pdf_base64 && !result.docx_base64}
                            className="btn-outline text-sm px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Download PDF
                          </button>

                          {appVariant === 'oncue' ? (
                            <button
                              type="button"
                              onClick={() => {
                                if (!result.oncue_xml_base64) return
                                downloadBase64File(result.oncue_xml_base64, buildItemFilename(item, '.xml'), 'application/xml')
                              }}
                              disabled={!result.oncue_xml_base64}
                              className="btn-outline text-sm px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Download OnCue XML
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                if (!result.viewer_html_base64) return
                                downloadBase64File(result.viewer_html_base64, buildItemFilename(item, '.html'), 'text/html')
                              }}
                              disabled={!result.viewer_html_base64}
                              className="btn-outline text-sm px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Download HTML Viewer
                            </button>
                          )}

                          {effectiveCaseId && (
                            <Link href={routes.caseDetail(effectiveCaseId)} className="btn-outline text-sm px-3 py-2">
                              View Case
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!isProcessing && processedItems.length === 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-500">
              {isBatchSelection ? 'Queue has not started yet.' : 'Transcription has not started yet.'}
            </div>
          )}

          <div className="flex justify-start">
            <button type="button" onClick={() => setStep('configure')} className="btn-outline px-6 py-3">
              Back to Configure
            </button>
          </div>
        </div>
      )}

      {showNewCaseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Create New Case</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Name</label>
                <input
                  type="text"
                  value={newCaseName}
                  onChange={(event) => setNewCaseName(event.target.value)}
                  className="input-field"
                  placeholder="e.g., Smith vs. Johnson"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea
                  value={newCaseDescription}
                  onChange={(event) => setNewCaseDescription(event.target.value)}
                  className="input-field"
                  rows={3}
                  placeholder="Brief description of the case..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => {
                  setShowNewCaseModal(false)
                  setNewCaseName('')
                  setNewCaseDescription('')
                }}
                className="btn-outline px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateCase}
                disabled={!newCaseName.trim() || creatingCase}
                className="btn-primary px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creatingCase ? 'Creating...' : 'Create Case'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
