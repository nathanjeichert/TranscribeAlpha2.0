'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useDashboard, type TranscriptionJobInput } from '@/context/DashboardContext'
import { routes } from '@/utils/routes'
import { guardedPush } from '@/utils/navigationGuard'
import { createCase as localCreateCase } from '@/lib/storage'
import { detectCodec, type CodecInfo } from '@/lib/ffmpegWorker'

interface FormData {
  case_name: string
  case_number: string
  firm_name: string
  input_date: string
  location: string
  transcription_model: 'assemblyai' | 'gemini'
  case_id: string
}

type WizardStep = 'upload' | 'configure'

interface QueueItem {
  id: string
  file: File
  originalFileName: string
  fileHandle?: FileSystemFileHandle | null
  speaker_names: string
  speakers_expected: string
  channel_label_1: string
  channel_label_2: string
  case_target: string
}

const wizardSteps: Array<{ key: WizardStep; label: string }> = [
  { key: 'upload', label: 'Upload' },
  { key: 'configure', label: 'Configure' },
]

const MAX_BATCH_FILES = 3000
const CASE_USE_BATCH = '__batch__'
const CASE_UNCATEGORIZED = '__uncategorized__'

const buildQueueId = () => `${Date.now()}_${Math.random().toString(16).slice(2)}`
const buildFileSignature = (file: File) => `${file.name}::${file.size}::${file.lastModified}`

function isLikelyG729Codec(codec: CodecInfo | null): boolean {
  if (!codec) return false
  if (codec.formatCode === 0x2222) return true
  const label = (codec.codecName || '').toLowerCase()
  return label.includes('g.729') || label.includes('g729')
}

function buildMediaKey(): string {
  // 32 hex chars (UUID without hyphens), matches backend validation.
  return crypto.randomUUID().replace(/-/g, '')
}

export default function TranscribePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { cases, refreshCases, enqueueTranscriptionJobs } = useDashboard()

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
  const [pageError, setPageError] = useState('')
  const [pageNotice, setPageNotice] = useState('')
  const [jailCallMode, setJailCallMode] = useState(false)
  const [jailCallDetected, setJailCallDetected] = useState(false)
  const [jailCallPromptDismissed, setJailCallPromptDismissed] = useState(false)

  const [showNewCaseModal, setShowNewCaseModal] = useState(false)
  const [newCaseName, setNewCaseName] = useState('')
  const [newCaseDescription, setNewCaseDescription] = useState('')
  const [creatingCase, setCreatingCase] = useState(false)

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueRef = useRef<QueueItem[]>([])

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    const caseIdParam = searchParams.get('case_id')
    if (caseIdParam) {
      setFormData((prev) => ({ ...prev, case_id: caseIdParam }))
    }
  }, [searchParams])

  const caseNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of cases) {
      map.set(c.case_id, c.name)
    }
    return map
  }, [cases])

  const inspectForJailCalls = useCallback(async (files: File[]) => {
    if (!files.length) return
    const checks = await Promise.allSettled(files.map((file) => detectCodec(file)))
    let seen = 0
    let g729Count = 0
    for (const check of checks) {
      if (check.status !== 'fulfilled') continue
      seen += 1
      if (isLikelyG729Codec(check.value)) {
        g729Count += 1
      }
    }
    if (!seen) return
    if (g729Count / seen > 0.5) {
      setJailCallDetected(true)
      setJailCallPromptDismissed(false)
    }
  }, [])

  const updateQueueItem = useCallback((itemId: string, updater: Partial<QueueItem> | ((current: QueueItem) => QueueItem)) => {
    setQueue((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item
        if (typeof updater === 'function') return updater(item)
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
      speaker_names: '',
      speakers_expected: '',
      channel_label_1: '',
      channel_label_2: '',
      case_target: CASE_USE_BATCH,
    }
  }, [])

  const addFilesToQueue = useCallback(
    (incoming: File[]) => {
      if (!incoming.length) return

      setPageError('')
      setPageNotice('')

      const baseQueue = queueRef.current
      const existingSignatures = new Set(baseQueue.map((item) => buildFileSignature(item.file)))
      let duplicateCount = 0

      const remainingSlots = Math.max(MAX_BATCH_FILES - baseQueue.length, 0)
      if (remainingSlots <= 0) {
        setPageError(`Batch limit reached. Maximum ${MAX_BATCH_FILES} files per run.`)
        return
      }

      const accepted = incoming.slice(0, remainingSlots)
      const dropped = incoming.length - accepted.length

      const nextItems: QueueItem[] = []
      for (const file of accepted) {
        const signature = buildFileSignature(file)
        if (existingSignatures.has(signature)) {
          duplicateCount += 1
        }
        existingSignatures.add(signature)
        nextItems.push(createQueueItem(file))
      }

      setQueue([...baseQueue, ...nextItems])
      void inspectForJailCalls(accepted)

      if (duplicateCount > 0) {
        setPageNotice(`${duplicateCount} duplicate file(s) were added. Duplicates are allowed and will be processed.`)
      }
      if (dropped > 0) {
        setPageError(`Added ${accepted.length} file(s). ${dropped} file(s) were not added because of the ${MAX_BATCH_FILES}-file limit.`)
      }
    },
    [createQueueItem, inspectForJailCalls],
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

      const baseQueue = queueRef.current
      const remainingSlots = Math.max(MAX_BATCH_FILES - baseQueue.length, 0)
      if (remainingSlots <= 0) {
        setPageError(`Batch limit reached. Maximum ${MAX_BATCH_FILES} files per run.`)
        return
      }

      const accepted = handles.slice(0, remainingSlots)
      const dropped = handles.length - accepted.length

      const nextItems: QueueItem[] = []
      const acceptedFiles: File[] = []
      for (const handle of accepted) {
        const file = await handle.getFile()
        acceptedFiles.push(file)
        nextItems.push(createQueueItem(file, handle))
      }
      setQueue([...baseQueue, ...nextItems])
      void inspectForJailCalls(acceptedFiles)

      if (dropped > 0) {
        setPageError(`Added ${accepted.length} file(s). ${dropped} file(s) were not added because of the ${MAX_BATCH_FILES}-file limit.`)
      }
    } catch {
      // User cancelled the file picker
    }
  }, [createQueueItem, inspectForJailCalls])

  const handleCreateCase = async () => {
    if (!newCaseName.trim()) return
    setCreatingCase(true)
    setPageError('')

    try {
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
      if (item.case_target === CASE_USE_BATCH) return formData.case_id
      if (item.case_target === CASE_UNCATEGORIZED) return ''
      return item.case_target
    },
    [formData.case_id],
  )

  const renderCaseTargetLabel = useCallback(
    (item: QueueItem) => {
      const effective = getEffectiveCaseId(item)
      if (!effective) return 'Uncategorized'
      return caseNameById.get(effective) || 'Assigned Case'
    },
    [caseNameById, getEffectiveCaseId],
  )

  const setFileCaseTarget = (itemId: string, value: string) => {
    updateQueueItem(itemId, { case_target: value })
  }
  const setFileSpeakerNames = (itemId: string, value: string) => {
    updateQueueItem(itemId, { speaker_names: value })
  }
  const setFileSpeakersExpected = (itemId: string, value: string) => {
    updateQueueItem(itemId, { speakers_expected: value })
  }
  const setFileChannelLabel1 = (itemId: string, value: string) => {
    updateQueueItem(itemId, { channel_label_1: value })
  }
  const setFileChannelLabel2 = (itemId: string, value: string) => {
    updateQueueItem(itemId, { channel_label_2: value })
  }

  const setTranscriptionMode = (nextMode: 'standard' | 'jail') => {
    const jailMode = nextMode === 'jail'
    setJailCallMode(jailMode)
    if (jailMode) {
      setFormData((prev) => ({ ...prev, transcription_model: 'assemblyai' }))
      setJailCallPromptDismissed(true)
      setPageNotice('')
    }
  }

  const isBatchSelection = queue.length > 1
  const hasQueue = queue.length > 0
  const canProceedToConfig = hasQueue
  const canProceedToStart = hasQueue
  const showStickyActionBar = (step === 'upload' && canProceedToConfig) || (step === 'configure' && hasQueue)
  const currentStepIndex = wizardSteps.findIndex((wizardStep) => wizardStep.key === step)

  const canNavigateToStep = (targetStep: WizardStep) => {
    if (targetStep === 'upload') return true
    if (targetStep === 'configure') return canProceedToConfig
    return false
  }

  const handleStart = useCallback(() => {
    if (!queue.length) {
      setPageError('Please add at least one file.')
      return
    }

    setPageError('')
    setPageNotice('')

    const inputs: TranscriptionJobInput[] = queue.map((item) => {
      const effectiveCaseId = getEffectiveCaseId(item)
      const speakersExpectedNum = Number(item.speakers_expected)
      const speakersExpected =
        Number.isInteger(speakersExpectedNum) && speakersExpectedNum > 0 ? speakersExpectedNum : null
      const channelLabels: Record<number, string> = {}
      if (jailCallMode) {
        const channelOne = item.channel_label_1.trim()
        const channelTwo = item.channel_label_2.trim()
        if (channelOne) channelLabels[1] = channelOne
        if (channelTwo) channelLabels[2] = channelTwo
      }

      return {
        file: item.file,
        fileHandle: item.fileHandle ?? null,
        originalFileName: item.originalFileName || item.file.name,
        mediaKey: buildMediaKey(),
        transcriptionModel: jailCallMode ? 'assemblyai' : formData.transcription_model,
        caseId: effectiveCaseId ? effectiveCaseId : null,
        case_name: formData.case_name,
        case_number: formData.case_number,
        firm_name: formData.firm_name,
        input_date: formData.input_date,
        location: formData.location,
        speakers_expected: jailCallMode ? null : speakersExpected,
        speaker_names: jailCallMode ? '' : item.speaker_names,
        multichannel: jailCallMode,
        channelLabels: Object.keys(channelLabels).length > 0 ? channelLabels : undefined,
      }
    })

    enqueueTranscriptionJobs(inputs)
    setQueue([])
    setStep('upload')
    setPageNotice(`Queued ${inputs.length} transcription job(s). Track progress in Jobs.`)
    guardedPush(router, routes.jobs())
  }, [enqueueTranscriptionJobs, formData, getEffectiveCaseId, jailCallMode, queue, router])

  return (
    <div className={`p-8 max-w-6xl mx-auto ${showStickyActionBar ? 'pb-36 sm:pb-32' : ''}`}>
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">New Transcript</h1>
          <p className="text-gray-600 mt-1">
            {isBatchSelection
              ? `Upload up to ${MAX_BATCH_FILES} files and submit them as jobs.`
              : 'Upload one file to transcribe, or add more files to submit a batch.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={routes.jobs()} className="btn-outline px-4 py-2">
            View Jobs
          </Link>
          <Link href={routes.converter()} className="btn-outline px-4 py-2">
            Converter
          </Link>
        </div>
      </div>

      <div className="flex items-center mb-8">
        {wizardSteps.map((wizardStep, i) => (
          <div key={wizardStep.key} className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (canNavigateToStep(wizardStep.key)) setStep(wizardStep.key)
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
              <div className={`w-12 h-0.5 mx-2 ${currentStepIndex > i ? 'bg-primary-600' : 'bg-gray-200'}`} />
            )}
          </div>
        ))}
      </div>

      {(pageError || pageNotice) && (
        <div className="space-y-3 mb-6">
          {pageError ? <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{pageError}</div> : null}
          {pageNotice ? <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">{pageNotice}</div> : null}
        </div>
      )}

      {jailCallDetected && !jailCallMode && !jailCallPromptDismissed && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            G.729 jail call recordings detected. Switch to Jail Call mode for optimized channel-based speaker separation?
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-primary px-4 py-2 text-sm"
              onClick={() => setTranscriptionMode('jail')}
            >
              Switch to Jail Call Mode
            </button>
            <button
              type="button"
              className="btn-outline px-4 py-2 text-sm"
              onClick={() => setJailCallPromptDismissed(true)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Transcription Mode</h2>
            <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-gray-50">
              <button
                type="button"
                onClick={() => setTranscriptionMode('standard')}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                  !jailCallMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Standard Transcription
              </button>
              <button
                type="button"
                onClick={() => setTranscriptionMode('jail')}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                  jailCallMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Jail Call Mode
              </button>
            </div>
            {jailCallMode ? (
              <p className="mt-3 text-sm text-amber-700">
                Jail Call mode uses AssemblyAI multichannel transcription and stereo-preserving preprocessing.
              </p>
            ) : null}
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
              Upload Media {isBatchSelection ? 'Files' : 'File'}
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              {isBatchSelection
                ? `Choose up to ${MAX_BATCH_FILES} files. Drag to reorder before submitting.`
                : `Choose one or more audio/video files. Select multiple files to submit a batch (up to ${MAX_BATCH_FILES}).`}
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

            <button
              type="button"
              onClick={handleOpenFilePicker}
              className="mt-3 w-full py-2.5 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 transition-colors"
            >
              Browse Files (preserves file access for playback)
            </button>
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
                <button
                  type="button"
                  onClick={() => setQueue([])}
                  className="btn-outline text-sm px-3 py-1"
                >
                  Clear
                </button>
              </div>
              <div className="divide-y divide-gray-100">
                {queue.map((item, index) => (
                  <div
                    key={item.id}
                    draggable
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
                    <button
                      type="button"
                      onClick={() => {
                        setQueue((prev) => prev.filter((entry) => entry.id !== item.id))
                      }}
                      className="text-gray-400 hover:text-red-600 transition-colors"
                      title="Remove"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
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
              className="btn-primary px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
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
                <option value="">No case (uncategorized)</option>
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

          {/* TODO: Re-enable Gemini model option later
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
              disabled={jailCallMode}
              className="input-field"
            >
              <option value="assemblyai">AssemblyAI (Recommended)</option>
              <option value="gemini">Gemini 3.0 Pro</option>
            </select>
            {jailCallMode ? (
              <p className="mt-2 text-xs text-amber-700">
                Jail Call mode requires AssemblyAI multichannel and cannot use Gemini.
              </p>
            ) : null}
          </div>
          */}

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">{isBatchSelection ? 'Per-File Overrides' : 'Transcript Options'}</h2>
              <p className="text-sm text-gray-500 mt-1">
                {jailCallMode
                  ? 'Set optional channel labels and case override per file.'
                  : isBatchSelection
                    ? 'Set optional speaker hints and case override per file.'
                    : 'Set optional speaker hints for this transcript.'}
              </p>
              {jailCallMode ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Each audio channel is treated as a separate speaker. Channel 1 = Speaker A, Channel 2 = Speaker B.
                </div>
              ) : null}
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

                    {jailCallMode ? (
                      <>
                        <div className={isBatchSelection ? '' : 'lg:col-span-1'}>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                            Channel 1 Label (Optional)
                          </label>
                          <input
                            type="text"
                            value={item.channel_label_1}
                            onChange={(event) => setFileChannelLabel1(item.id, event.target.value)}
                            className="input-field text-sm"
                            placeholder="e.g., Inmate"
                          />
                        </div>
                        <div className={isBatchSelection ? '' : 'lg:col-span-1'}>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                            Channel 2 Label (Optional)
                          </label>
                          <input
                            type="text"
                            value={item.channel_label_2}
                            onChange={(event) => setFileChannelLabel2(item.id, event.target.value)}
                            className="input-field text-sm"
                            placeholder="e.g., Outside Party"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className={isBatchSelection ? 'lg:col-span-2' : ''}>
                          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                            Speaker Names (Optional)
                          </label>
                          <input
                            type="text"
                            value={item.speaker_names}
                            onChange={(event) => setFileSpeakerNames(item.id, event.target.value)}
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
                            className="input-field text-sm"
                            placeholder="e.g., 2"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-900 text-sm">
            In-app navigation is safe while jobs run. Refreshing or closing the tab will interrupt active work.
          </div>

          <div className="flex justify-between">
            <button type="button" onClick={() => setStep('upload')} className="btn-outline px-6 py-3">
              Back
            </button>
            <button
              type="button"
              onClick={handleStart}
              disabled={!canProceedToStart}
              className="btn-primary px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBatchSelection ? 'Submit Jobs' : 'Submit Job'}
            </button>
          </div>
        </div>
      )}

      {showStickyActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-40">
          <div className="mx-auto max-w-6xl px-4 pb-4 sm:px-6 lg:px-8">
            <div className="rounded-xl border border-gray-200 bg-white shadow-xl">
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {queue.length} file{queue.length !== 1 ? 's' : ''} queued
                  </p>
                  <p className="text-xs text-gray-600">
                    {step === 'upload'
                      ? 'Continue to configure case details and per-file options.'
                      : 'Ready to submit this batch to Jobs.'}
                  </p>
                </div>
                <div className="flex gap-2 sm:flex-nowrap">
                  {step === 'configure' && (
                    <button type="button" onClick={() => setStep('upload')} className="btn-outline px-4 py-2">
                      Back
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={step === 'upload' ? () => setStep('configure') : handleStart}
                    disabled={step === 'upload' ? !canProceedToConfig : !canProceedToStart}
                    className="btn-primary px-5 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {step === 'upload' ? 'Continue' : isBatchSelection ? 'Submit Jobs' : 'Submit Job'}
                  </button>
                </div>
              </div>
            </div>
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
