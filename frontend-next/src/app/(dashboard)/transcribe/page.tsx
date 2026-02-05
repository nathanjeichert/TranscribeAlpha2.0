'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authenticatedFetch, getAuthHeaders } from '@/utils/auth'
import { useDashboard } from '@/context/DashboardContext'
import { routes } from '@/utils/routes'

interface FormData {
  case_name: string
  case_number: string
  firm_name: string
  input_date: string
  input_time: string
  location: string
  speaker_names: string
  speakers_expected: string
  transcription_model: 'assemblyai' | 'gemini'
  case_id: string
}

type WizardStep = 'upload' | 'configure' | 'transcribe'

const wizardSteps: Array<{ key: WizardStep; label: string }> = [
  { key: 'upload', label: 'Upload File' },
  { key: 'configure', label: 'Optional Details' },
  { key: 'transcribe', label: 'Transcribe' },
]

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
    input_time: '',
    location: '',
    speaker_names: '',
    speakers_expected: '',
    transcription_model: 'assemblyai',
    case_id: '',
  })
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingStage, setLoadingStage] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [transcriptResult, setTranscriptResult] = useState<any>(null)
  const [showNewCaseModal, setShowNewCaseModal] = useState(false)
  const [newCaseName, setNewCaseName] = useState('')
  const [newCaseDescription, setNewCaseDescription] = useState('')
  const [creatingCase, setCreatingCase] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const stageTimerRef = useRef<number | null>(null)

  // Pre-select case_id from URL if provided
  useEffect(() => {
    const caseIdParam = searchParams.get('case_id')
    if (caseIdParam) {
      setFormData(prev => ({ ...prev, case_id: caseIdParam }))
    }
  }, [searchParams])

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = event.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setSelectedFile(file)
    setError('')
    setTranscriptResult(null)
  }

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (file) {
      setSelectedFile(file)
      setError('')
      setTranscriptResult(null)
    }
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
  }, [])

  const handleCreateCase = async () => {
    if (!newCaseName.trim()) return
    setCreatingCase(true)
    try {
      const response = await authenticatedFetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCaseName.trim(), description: newCaseDescription.trim() }),
      })
      if (!response.ok) throw new Error('Failed to create case')
      const data = await response.json()
      await refreshCases()
      setFormData(prev => ({ ...prev, case_id: data.case.case_id }))
      setShowNewCaseModal(false)
      setNewCaseName('')
      setNewCaseDescription('')
    } catch (err) {
      setError('Failed to create case')
    } finally {
      setCreatingCase(false)
    }
  }

  const handleSubmit = async () => {
    if (!selectedFile) {
      setError('Please select a file to transcribe')
      return
    }

    setIsLoading(true)
    setLoadingStage('Uploading media...')
    setError('')
    setTranscriptResult(null)

    const clearStageTimer = () => {
      if (stageTimerRef.current) {
        window.clearTimeout(stageTimerRef.current)
        stageTimerRef.current = null
      }
    }

    try {
      const submitFormData = new FormData()
      submitFormData.append('file', selectedFile)
      Object.entries(formData).forEach(([key, value]) => {
        if (value) submitFormData.append(key, value.toString())
      })

      const isVideoFile =
        (selectedFile.type || '').startsWith('video/') ||
        /\.(mp4|mov|avi|mkv)$/i.test(selectedFile.name)

      const data = await new Promise<any>((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open('POST', '/api/transcribe', true)
        const authHeaders = getAuthHeaders()
        Object.entries(authHeaders).forEach(([key, value]) => {
          request.setRequestHeader(key, String(value))
        })
        request.responseType = 'json'

        request.upload.onprogress = () => {
          setLoadingStage('Uploading media...')
        }

        request.upload.onload = () => {
          clearStageTimer()
          if (isVideoFile) {
            setLoadingStage('Converting to audio...')
            stageTimerRef.current = window.setTimeout(() => {
              setLoadingStage('Transcribing (this could take a few minutes)...')
              stageTimerRef.current = null
            }, 1200)
          } else {
            setLoadingStage('Transcribing (this could take a few minutes)...')
          }
        }

        request.onload = () => {
          clearStageTimer()
          const responseData = request.response ?? (() => {
            try { return JSON.parse(request.responseText) } catch { return null }
          })()

          if (request.status >= 200 && request.status < 300) {
            setLoadingStage('Producing transcript...')
            resolve(responseData)
            return
          }

          const detail = responseData?.detail || 'Transcription failed'
          reject(new Error(detail))
        }

        request.onerror = () => {
          clearStageTimer()
          reject(new Error('Upload failed. Please try again.'))
        }

        request.send(submitFormData)
      })

      setTranscriptResult(data)
      setActiveMediaKey(data.media_key)
      await refreshRecentTranscripts()
      if (formData.case_id) {
        await refreshCases()
      }
    } catch (err: any) {
      setError(err.message || 'Transcription failed')
    } finally {
      clearStageTimer()
      setIsLoading(false)
      setLoadingStage('')
    }
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

  const buildDownloadFilename = (extension: '.pdf' | '.xml' | '.html') => {
    const baseLabel = formData.case_name.trim() || selectedFile?.name?.replace(/\.[^.]+$/, '') || 'transcript'
    const sanitizedBase = baseLabel
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'transcript'
    const dateSuffix = formData.input_date ? `-${formData.input_date}` : ''
    return `${sanitizedBase}${dateSuffix}${extension}`
  }

  const canProceedToConfig = selectedFile !== null
  const canProceedToTranscribe = selectedFile !== null
  const currentStepIndex = wizardSteps.findIndex((wizardStep) => wizardStep.key === step)

  const canNavigateToStep = (targetStep: WizardStep) => {
    if (targetStep === 'upload') return true
    if (targetStep === 'configure') return canProceedToConfig
    return Boolean(transcriptResult)
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">New Transcript</h1>
        <p className="text-gray-600 mt-1">Step 1 is required. Step 2 is optional metadata.</p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center mb-8">
        {wizardSteps.map((wizardStep, i) => (
          <div key={wizardStep.key} className="flex items-center">
            <button
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
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-sm ${
                step === wizardStep.key ? 'bg-white text-primary-600' : 'bg-gray-200 text-gray-600'
              }`}>
                {i + 1}
              </span>
              <span>{wizardStep.label}</span>
            </button>
            {i < 2 && (
              <div className={`w-12 h-0.5 mx-2 ${
                currentStepIndex > i
                  ? 'bg-primary-600'
                  : 'bg-gray-200'
              }`} />
            )}
          </div>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Upload Media File (Required)</h2>
            <p className="text-sm text-gray-600 mb-4">Choose audio or video to begin the transcript.</p>
            <label
              htmlFor="media-upload"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className={`block border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
                selectedFile
                  ? 'border-green-300 bg-green-50'
                  : 'border-gray-300 hover:border-primary-400 hover:bg-primary-50'
              }`}
            >
              <input
                id="media-upload"
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="audio/*,video/*,.mp4,.avi,.mov,.mkv,.wav,.mp3,.m4a,.flac,.ogg"
                className="sr-only"
              />
              {selectedFile ? (
                <div className="space-y-3">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                    <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div className="font-medium text-gray-900">{selectedFile.name}</div>
                  <div className="text-sm text-gray-500">
                    {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                  </div>
                  <div className="text-sm text-green-600 font-medium">File selected successfully</div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto">
                    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <div className="font-medium text-gray-900">Drop your file here or click to browse</div>
                  <div className="text-sm text-gray-500">
                    Supports MP4, AVI, MOV, WAV, MP3, FLAC and more
                  </div>
                </div>
              )}
            </label>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={() => setStep('configure')}
              disabled={!canProceedToConfig}
              className="btn-primary px-8 py-3"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Configure */}
      {step === 'configure' && (
        <div className="space-y-6">
          {/* Case Selection */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Assign to Case (Recommended)</h2>
            <p className="text-sm text-gray-500 mb-4">
              Assign this transcript to a case for permanent storage. Unassigned transcripts expire after 30 days.
            </p>
            <div className="flex gap-3">
              <select
                name="case_id"
                value={formData.case_id}
                onChange={handleInputChange}
                className="input-field flex-1"
              >
                <option value="">No case (expires in 30 days)</option>
                {cases.map((c) => (
                  <option key={c.case_id} value={c.case_id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowNewCaseModal(true)}
                className="btn-outline whitespace-nowrap"
              >
                + New Case
              </button>
            </div>
          </div>

          {/* Case Information */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Optional Transcript Details</h2>
              <span className="text-sm text-gray-400">All fields optional</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Name</label>
                <input
                  type="text"
                  name="case_name"
                  value={formData.case_name}
                  onChange={handleInputChange}
                  className="input-field"
                  placeholder="e.g., Smith vs. Johnson"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Number</label>
                <input
                  type="text"
                  name="case_number"
                  value={formData.case_number}
                  onChange={handleInputChange}
                  className="input-field"
                  placeholder="e.g., CV-2023-001234"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Firm/Organization</label>
                <input
                  type="text"
                  name="firm_name"
                  value={formData.firm_name}
                  onChange={handleInputChange}
                  className="input-field"
                  placeholder="e.g., Legal Associates LLC"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input
                  type="date"
                  name="input_date"
                  value={formData.input_date}
                  onChange={handleInputChange}
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time</label>
                <input
                  type="time"
                  name="input_time"
                  value={formData.input_time}
                  onChange={handleInputChange}
                  className="input-field"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                <input
                  type="text"
                  name="location"
                  value={formData.location}
                  onChange={handleInputChange}
                  className="input-field"
                  placeholder="e.g., Conference Room A, 123 Main St"
                />
              </div>
            </div>
          </div>

          {/* Transcription Settings */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Transcription Options</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Transcription Model</label>
                <select
                  name="transcription_model"
                  value={formData.transcription_model}
                  onChange={handleInputChange}
                  className="input-field"
                >
                  <option value="assemblyai">AssemblyAI (Recommended)</option>
                  <option value="gemini">Gemini 3.0 Pro</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Speaker Names (optional)</label>
                <input
                  type="text"
                  name="speaker_names"
                  value={formData.speaker_names}
                  onChange={handleInputChange}
                  className="input-field"
                  placeholder="e.g., John Smith, Jane Doe, Attorney Williams"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Separate with commas. Leave blank for automatic detection.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Number of Speakers (optional)</label>
                <input
                  type="number"
                  name="speakers_expected"
                  value={formData.speakers_expected}
                  onChange={handleInputChange}
                  className="input-field"
                  min={1}
                  step={1}
                  placeholder="e.g., 2"
                />
                <p className="text-xs text-gray-500 mt-1">
                  If provided, this is passed as <code>speakers_expected</code> for AssemblyAI diarization.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-between">
            <button onClick={() => setStep('upload')} className="btn-outline px-6 py-3">
              Back
            </button>
            <button
              onClick={() => {
                handleSubmit()
                setStep('transcribe')
              }}
              disabled={!canProceedToTranscribe || isLoading}
              className="btn-primary px-8 py-3"
            >
              Start Transcription
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Transcribe */}
      {step === 'transcribe' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8">
            {isLoading ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 mx-auto mb-6 relative">
                  <div className="absolute inset-0 border-4 border-primary-200 rounded-full"></div>
                  <div className="absolute inset-0 border-4 border-primary-600 rounded-full border-t-transparent animate-spin"></div>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Processing...</h2>
                <p className="text-gray-500">{loadingStage}</p>
              </div>
            ) : transcriptResult ? (
              <div className="text-center py-8">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                  <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Transcription Complete!</h2>
                <p className="text-gray-500 mb-6">
                  Generated {transcriptResult.lines?.length || 0} transcript lines
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 max-w-xl mx-auto">
                  <button
                    onClick={() => {
                      const pdfData = transcriptResult.pdf_base64 ?? transcriptResult.docx_base64
                      if (pdfData) {
                        downloadBase64File(pdfData, buildDownloadFilename('.pdf'), 'application/pdf')
                      }
                    }}
                    disabled={!transcriptResult.pdf_base64 && !transcriptResult.docx_base64}
                    className="btn-primary px-5 py-3"
                  >
                    Download PDF
                  </button>
                  {appVariant === 'oncue' ? (
                    <button
                      onClick={() => {
                        if (transcriptResult.oncue_xml_base64) {
                          downloadBase64File(
                            transcriptResult.oncue_xml_base64,
                            buildDownloadFilename('.xml'),
                            'application/xml',
                          )
                        }
                      }}
                      disabled={!transcriptResult.oncue_xml_base64}
                      className="btn-primary px-5 py-3"
                    >
                      Download OnCue XML
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        if (transcriptResult.viewer_html_base64) {
                          downloadBase64File(
                            transcriptResult.viewer_html_base64,
                            buildDownloadFilename('.html'),
                            'text/html',
                          )
                        }
                      }}
                      disabled={!transcriptResult.viewer_html_base64}
                      className="btn-primary px-5 py-3"
                    >
                      Download HTML Viewer
                    </button>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row justify-center items-center gap-3">
                  <button
                    onClick={() => router.push(routes.editor(transcriptResult.media_key))}
                    className="btn-primary px-6 py-3"
                  >
                    Open in Editor
                  </button>
                  <button
                    onClick={() => {
                      setSelectedFile(null)
                      setTranscriptResult(null)
                      setFormData({
                        case_name: '',
                        case_number: '',
                        firm_name: '',
                        input_date: '',
                        input_time: '',
                        location: '',
                        speaker_names: '',
                        speakers_expected: '',
                        transcription_model: 'assemblyai',
                        case_id: formData.case_id,
                      })
                      setStep('upload')
                    }}
                    className="btn-outline px-6 py-3"
                  >
                    New Transcript
                  </button>
                </div>
              </div>
            ) : error ? (
              <div className="text-center py-8">
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
                  <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Transcription Failed</h2>
                <p className="text-gray-500 mb-6">{error}</p>
                <div className="flex justify-center gap-4">
                  <button onClick={() => setStep('configure')} className="btn-outline px-6 py-3">
                    Back to Configure
                  </button>
                  <button
                    onClick={() => {
                      setError('')
                      handleSubmit()
                    }}
                    className="btn-primary px-6 py-3"
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <p className="text-gray-500">Starting transcription...</p>
              </div>
            )}
          </div>

          {!isLoading && !transcriptResult && !error && (
            <div className="flex justify-start">
              <button onClick={() => setStep('configure')} className="btn-outline px-6 py-3">
                Back
              </button>
            </div>
          )}
        </div>
      )}

      {/* New Case Modal */}
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
                  onChange={(e) => setNewCaseName(e.target.value)}
                  className="input-field"
                  placeholder="e.g., Smith vs. Johnson"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea
                  value={newCaseDescription}
                  onChange={(e) => setNewCaseDescription(e.target.value)}
                  className="input-field"
                  rows={3}
                  placeholder="Brief description of the case..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
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
                onClick={handleCreateCase}
                disabled={!newCaseName.trim() || creatingCase}
                className="btn-primary px-4 py-2"
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
