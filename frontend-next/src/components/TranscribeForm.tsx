'use client'

import { useState, useRef } from 'react'

interface FormData {
  case_name: string
  case_number: string
  firm_name: string
  input_date: string
  input_time: string
  location: string
  speaker_names: string
  include_timestamps: boolean
}

interface TranscriptResponse {
  transcript: string
  docx_base64: string
  oncue_xml_base64: string
}

export default function TranscribeForm() {
  const [formData, setFormData] = useState<FormData>({
    case_name: '',
    case_number: '',
    firm_name: '',
    input_date: '',
    input_time: '',
    location: '',
    speaker_names: '',
    include_timestamps: false
  })

  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<TranscriptResponse | null>(null)
  const [error, setError] = useState<string>('')
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>('')
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }))
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setSelectedFile(file)
    setError('')
    
    // Create preview URL for the selected file
    const previewUrl = URL.createObjectURL(file)
    setMediaPreviewUrl(previewUrl)
  }


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!selectedFile) {
      setError('Please select a file to transcribe')
      return
    }

    setIsLoading(true)
    setProgress(0)
    setError('')
    setResult(null)

    // Simulate progress
    const progressInterval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 90) return prev
        return prev + Math.random() * 15
      })
    }, 500)

    try {
      const submitFormData = new FormData()
      submitFormData.append('file', selectedFile)
      Object.entries(formData).forEach(([key, value]) => {
        if (key === 'include_timestamps') {
          submitFormData.append(key, value ? 'on' : '')
        } else {
          submitFormData.append(key, value.toString())
        }
      })

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: submitFormData
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown error occurred' }))
        throw new Error(errorData.detail || 'Transcription failed')
      }

      const data: TranscriptResponse = await response.json()
      setResult(data)
      setProgress(100)
    } catch (err: any) {
      console.error('Transcription error:', err)
      setError(err.message || 'Transcription failed')
    } finally {
      clearInterval(progressInterval)
      setIsLoading(false)
    }
  }

  const downloadFile = (base64Data: string, filename: string, mimeType: string) => {
    const byteCharacters = atob(base64Data)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    const byteArray = new Uint8Array(byteNumbers)
    const blob = new Blob([byteArray], { type: mimeType })
    
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
  }

  const generateFilename = (baseName: string, extension: string) => {
    let filename = ''
    
    if (formData.case_name.trim()) {
      const sanitizedCase = formData.case_name.trim()
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
      
      if (sanitizedCase) {
        filename += sanitizedCase + '-'
      }
    }
    
    filename += baseName
    
    if (formData.input_date) {
      filename += '-' + formData.input_date
    }
    
    return filename + extension
  }

  return (
    <div className="min-h-screen bg-primary-50">
      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="bg-gradient-to-r from-primary-900 to-primary-700 text-white rounded-2xl p-8 shadow-2xl">
            <h1 className="text-4xl font-light mb-4">
              TranscribeAlpha
            </h1>
            <p className="text-lg text-primary-100">
              Professional Legal Transcript Generator
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* File Upload */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-xl font-medium">Media Upload</h2>
            </div>
            <div className="card-body">
              <div 
                className="border-2 border-dashed border-primary-300 rounded-lg p-8 text-center hover:border-primary-500 hover:bg-primary-100 transition-all duration-200 cursor-pointer bg-primary-50"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="audio/*,video/*,.mp4,.avi,.mov,.mkv,.wav,.mp3,.m4a,.flac,.ogg"
                  className="hidden"
                />
                {selectedFile ? (
                  <div className="space-y-2">
                    <div className="text-2xl text-green-500">✅</div>
                    <div className="font-medium text-primary-900">{selectedFile.name}</div>
                    <div className="text-sm text-primary-600">
                      {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                    </div>
                    <div className="text-sm text-green-600">File selected successfully</div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="text-4xl text-primary-400">📁</div>
                    <div className="font-medium text-primary-900">
                      Click to select audio or video file
                    </div>
                    <div className="text-sm text-primary-600">
                      Supports MP4, AVI, MOV, WAV, MP3, FLAC and more
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>

          {/* Case Information */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-xl font-medium">Case Information</h2>
            </div>
            <div className="card-body">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-primary-700 mb-2">
                    Case Name
                  </label>
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
                  <label className="block text-sm font-medium text-primary-700 mb-2">
                    Case Number
                  </label>
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
                  <label className="block text-sm font-medium text-primary-700 mb-2">
                    Firm/Organization Name
                  </label>
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
                  <label className="block text-sm font-medium text-primary-700 mb-2">
                    Date
                  </label>
                  <input
                    type="date"
                    name="input_date"
                    value={formData.input_date}
                    onChange={handleInputChange}
                    className="input-field"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-primary-700 mb-2">
                    Time
                  </label>
                  <input
                    type="time"
                    name="input_time"
                    value={formData.input_time}
                    onChange={handleInputChange}
                    className="input-field"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-primary-700 mb-2">
                    Location
                  </label>
                  <input
                    type="text"
                    name="location"
                    value={formData.location}
                    onChange={handleInputChange}
                    className="input-field"
                    placeholder="e.g., Conference Room A, 123 Main St, City, State"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Transcription Settings */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-xl font-medium">Transcription Settings</h2>
            </div>
            <div className="card-body space-y-6">
              <div>
                <label className="block text-sm font-medium text-primary-700 mb-2">
                  Speaker Names (optional)
                </label>
                <input
                  type="text"
                  name="speaker_names"
                  value={formData.speaker_names}
                  onChange={handleInputChange}
                  className="input-field"
                  placeholder="e.g., John Smith, Jane Doe, Attorney Williams"
                />
                <p className="text-xs text-primary-600 mt-1">
                  Separate multiple speakers with commas. Leave blank for automatic detection.
                </p>
              </div>

              <div className="bg-primary-50 border border-primary-200 rounded-lg p-4">
                <div className="text-sm text-primary-700">
                  Transcriptions are processed with <span className="font-medium">AssemblyAI</span> to provide
                  millisecond-accurate word-level timestamps for OnCue synchronization.
                </div>
              </div>

              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="include_timestamps"
                    checked={formData.include_timestamps}
                    onChange={handleInputChange}
                    className="mr-3"
                  />
                  <span className="text-sm font-medium text-primary-700">
                    Include timestamps in transcript
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="bg-red-50 border border-red-300 rounded-lg p-4 shadow-sm">
              <div className="text-red-800 font-medium">{error}</div>
            </div>
          )}

          {/* Submit Button */}
          <div className="flex justify-center">
            <button
              type="submit"
              disabled={!selectedFile || isLoading}
              className="btn-primary text-lg px-12 py-4"
            >
              {isLoading ? `Processing... ${progress.toFixed(0)}%` : 'Generate Transcript'}
            </button>
          </div>

          {/* Progress Bar */}
          {isLoading && (
            <div className="w-full bg-primary-200 rounded-full h-3 shadow-inner">
              <div 
                className="bg-gradient-to-r from-primary-600 to-primary-500 h-3 rounded-full transition-all duration-300 shadow-sm"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
          )}
        </form>

        {/* Results */}
        {result && (
          <div className="mt-12 space-y-6">
            {/* Media Preview Section */}
            {selectedFile && mediaPreviewUrl && (
              <div className="card">
                <div className="card-header">
                  <h2 className="text-xl font-medium">Media Preview</h2>
                </div>
                <div className="card-body">
                  <div className="bg-primary-900 rounded-lg p-4">
                    {selectedFile.type.startsWith('video/') ? (
                      <video
                        ref={videoRef}
                        src={mediaPreviewUrl}
                        controls
                        className="w-full max-w-2xl mx-auto rounded"
                      >
                        Your browser does not support video playback.
                      </video>
                    ) : (
                      <audio
                        ref={audioRef}
                        src={mediaPreviewUrl}
                        controls
                        className="w-full max-w-2xl mx-auto"
                      >
                        Your browser does not support audio playback.
                      </audio>
                    )}
                  </div>
                  <div className="mt-4 text-center text-sm text-primary-600">
                    <span className="font-medium">{selectedFile.name}</span> • {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                  </div>
                </div>
              </div>
            )}
            
            {/* Transcript Results */}
            <div className="card">
              <div className="card-header">
                <h2 className="text-xl font-medium">Generated Files</h2>
              </div>
              <div className="card-body">
                <div className="space-y-4">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <div className="text-green-800 font-medium mb-2">✅ Transcription Complete!</div>
                    <div className="text-sm text-green-700">
                      Generated {result.transcript.split('\n\n').filter(line => line.trim()).length} transcript segments
                    </div>
                  </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <button
                    onClick={() => downloadFile(
                      result.docx_base64, 
                      generateFilename('transcript', '.docx'),
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    )}
                    className="btn-primary text-center py-3"
                  >
                    📄 Download DOCX
                  </button>

                  <button
                    onClick={() => downloadFile(
                      result.oncue_xml_base64,
                      generateFilename('transcript', '.xml'),
                      'application/xml'
                    )}
                    className="btn-primary text-center py-3"
                  >
                    📋 Download OnCue XML
                  </button>
                </div>

                {/* Preview transcript text */}
                <div className="mt-6">
                  <h3 className="font-medium text-primary-900 mb-3">Transcript Preview:</h3>
                  <div className="bg-primary-50 rounded-lg p-4 max-h-64 overflow-y-auto">
                    <pre className="whitespace-pre-wrap text-sm text-primary-800 font-mono">
                      {result.transcript.substring(0, 1000)}
                      {result.transcript.length > 1000 && '...'}
                    </pre>
                  </div>
                </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
