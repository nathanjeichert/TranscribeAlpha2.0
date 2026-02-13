'use client'

import JSZip from 'jszip'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useDashboard, type JobRecord, type JobStatus } from '@/context/DashboardContext'

const LARGE_ZIP_WARNING_BYTES = 750 * 1024 * 1024

function statusLabel(job: JobRecord): string {
  if (job.status === 'queued') {
    if (!job.codec) return 'Detecting'
    if (job.needsConversion) return 'Ready'
    return 'Ready'
  }
  if (job.status === 'running') return 'Converting'
  if (job.status === 'succeeded' && job.needsConversion === false) return 'Already OK'
  if (job.status === 'succeeded') return 'Converted'
  if (job.status === 'canceled') return 'Canceled'
  if (job.status === 'failed') return 'Failed'
  if (job.status === 'finalizing') return 'Finalizing'
  return job.status
}

function statusClass(status: JobStatus, needsConversion?: boolean): string {
  if (status === 'succeeded' && needsConversion === false) return 'bg-gray-100 text-gray-700'
  if (status === 'succeeded') return 'bg-green-100 text-green-700'
  if (status === 'running') return 'bg-primary-100 text-primary-700'
  if (status === 'failed') return 'bg-red-100 text-red-700'
  if (status === 'canceled') return 'bg-amber-100 text-amber-800'
  if (status === 'queued') return 'bg-blue-100 text-blue-700'
  return 'bg-gray-100 text-gray-700'
}

function downloadFile(file: File) {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export default function ConverterPage() {
  const {
    jobs,
    addConversionJobs,
    startConversionQueue,
    stopConversionQueue,
    retryJob,
    removeJob,
    getConvertedFile,
    resolveConvertedFile,
  } = useDashboard()

  const [pageError, setPageError] = useState('')
  const [pageNotice, setPageNotice] = useState('')
  const [zipBusy, setZipBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)

  const conversionJobs = useMemo(() => {
    return [...jobs]
      .filter((job) => job.kind === 'conversion')
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }, [jobs])

  const isConverting = useMemo(() => {
    return conversionJobs.some((job) => job.status === 'running')
  }, [conversionJobs])

  const runningJob = useMemo(() => conversionJobs.find((job) => job.status === 'running') ?? null, [conversionJobs])

  const totals = useMemo(() => {
    const totalSize = conversionJobs.reduce((sum, job) => sum + (job.fileSizeBytes || 0), 0)
    const readyCount = conversionJobs.filter((job) => job.status === 'queued' && job.needsConversion).length
    const convertedCount = conversionJobs.filter((job) => job.status === 'succeeded' && job.needsConversion).length
    const alreadyOkCount = conversionJobs.filter((job) => job.status === 'succeeded' && job.needsConversion === false).length
    return { totalSize, readyCount, convertedCount, alreadyOkCount }
  }, [conversionJobs])

  const failedCount = useMemo(() => {
    return conversionJobs.filter((job) => job.status === 'failed' || job.status === 'canceled').length
  }, [conversionJobs])

  const addFiles = useCallback(
    async (incoming: File[]) => {
      if (!incoming.length) return
      setPageError('')
      setPageNotice('')
      try {
        await addConversionJobs(incoming)
      } catch {
        setPageError('Failed to add files.')
      }
    },
    [addConversionJobs],
  )

  const handleFileInputChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || !files.length) return
    await addFiles(Array.from(files))
    event.target.value = ''
  }, [addFiles])

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    const files = event.dataTransfer.files
    if (!files || !files.length) return
    await addFiles(Array.from(files))
  }, [addFiles])

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragOver(true)
  }, [])

  const convertReadyFiles = useCallback(async () => {
    if (isConverting) return
    if (totals.readyCount === 0) {
      setPageError('No files are ready to convert.')
      return
    }
    try {
      await startConversionQueue({ promptLargeFiles: true })
    } finally {
      // Runner status is reflected via jobs; keep the page state minimal.
    }
  }, [isConverting, startConversionQueue, totals.readyCount])

  const handleStop = useCallback(() => {
    stopConversionQueue()
    setPageNotice('Stopping conversion...')
  }, [stopConversionQueue])

  const retryFailed = useCallback(async () => {
    if (isConverting) return
    const targets = conversionJobs.filter((job) => job.status === 'failed' || job.status === 'canceled')
    if (!targets.length) {
      setPageNotice('No failed conversions to retry.')
      return
    }

    setPageError('')
    setPageNotice('')
    for (const job of targets) {
      retryJob(job.id)
    }
    await startConversionQueue({ promptLargeFiles: true })
  }, [conversionJobs, isConverting, retryJob, startConversionQueue])

  const downloadAllZip = useCallback(async () => {
    const converted: File[] = []
    for (const job of conversionJobs) {
      if (job.status !== 'succeeded' || !job.needsConversion) continue
      const file = await resolveConvertedFile(job.id)
      if (file) converted.push(file)
    }
    if (!converted.length) {
      setPageError('No converted files are available to download.')
      return
    }

    const totalBytes = converted.reduce((sum, file) => sum + file.size, 0)
    if (totalBytes > LARGE_ZIP_WARNING_BYTES) {
      const shouldContinue = window.confirm(
        `This ZIP is very large (${formatBytes(totalBytes)} across ${converted.length} files). Building it in-browser may fail. Continue?`,
      )
      if (!shouldContinue) {
        return
      }
    }

    setZipBusy(true)
    setPageError('')
    try {
      const zip = new JSZip()
      const usedNames = new Set<string>()

      for (const file of converted) {
        let name = file.name
        let suffix = 2
        while (usedNames.has(name)) {
          const dot = file.name.lastIndexOf('.')
          const stem = dot > -1 ? file.name.slice(0, dot) : file.name
          const ext = dot > -1 ? file.name.slice(dot) : ''
          name = `${stem}-${suffix}${ext}`
          suffix += 1
        }
        usedNames.add(name)
        zip.file(name, file)
      }

      const blob = await zip.generateAsync({ type: 'blob', streamFiles: true })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `converted-media-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch {
      setPageError('Failed to generate ZIP file.')
    } finally {
      setZipBusy(false)
    }
  }, [conversionJobs, resolveConvertedFile])

  const clearAll = useCallback(() => {
    if (isConverting) return
    for (const job of conversionJobs) {
      removeJob(job.id)
    }
  }, [conversionJobs, isConverting, removeJob])

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Media Converter</h1>
        <p className="text-gray-600 mt-1">
          Convert proprietary audio/video files into browser-playable formats.
        </p>
      </div>

      {(pageError || pageNotice) && (
        <div className="space-y-3">
          {pageError && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{pageError}</div>}
          {pageNotice && <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">{pageNotice}</div>}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <label
          htmlFor="converter-file-picker"
          onDrop={handleDrop}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          className={`block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
            dragOver
              ? 'border-primary-500 bg-primary-50'
              : 'border-gray-300 hover:border-primary-400 hover:bg-primary-50'
          }`}
        >
          <input
            id="converter-file-picker"
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInputChange}
            accept="audio/*,video/*,.wav,.mp3,.m4a,.flac,.ogg,.aac,.wma,.mp4,.mov,.avi,.mkv,.webm"
            className="sr-only"
          />
          <div className="space-y-3">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="font-medium text-gray-900">Drop files here or click to browse</p>
            <p className="text-sm text-gray-500">Batch conversion is processed serially in-browser.</p>
          </div>
        </label>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">Files ({conversionJobs.length})</h2>
            <p className="text-sm text-gray-500">
              {formatBytes(totals.totalSize)} total, {totals.readyCount} ready, {totals.convertedCount} converted
              {totals.alreadyOkCount ? `, ${totals.alreadyOkCount} already OK` : ''}
            </p>
            {runningJob ? (
              <p className="text-sm font-medium text-primary-700 mt-1">
                Converting: {runningJob.title} {typeof runningJob.progress === 'number' ? `(${Math.round(runningJob.progress * 100)}%)` : ''}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={convertReadyFiles}
              disabled={isConverting || totals.readyCount === 0}
              className="btn-primary px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Convert All
            </button>
            <button
              type="button"
              onClick={retryFailed}
              disabled={isConverting || failedCount === 0}
              className="btn-outline px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Retry Failed ({failedCount})
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={!isConverting}
              className="btn-outline px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={downloadAllZip}
              disabled={zipBusy || totals.convertedCount === 0}
              className="btn-outline px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {zipBusy ? 'Building ZIP…' : 'Download Converted ZIP'}
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={isConverting || conversionJobs.length === 0}
              className="btn-outline px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="divide-y divide-gray-100">
          {conversionJobs.map((job) => {
            const convertedFile = job.needsConversion ? getConvertedFile(job.id) : null
            const hasPersistedOutput = Boolean(job.convertedCachePath)
            const downloadUnavailable =
              job.status === 'succeeded' && job.needsConversion && !convertedFile && !hasPersistedOutput

            return (
            <div key={job.id} className="p-4 flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 truncate">{job.title}</p>
                <p className="text-sm text-gray-500">
                  {(job.codec?.codecName || 'Unknown')} • {formatBytes(job.fileSizeBytes || 0)}
                </p>
                {job.error ? <p className="text-sm text-red-600 mt-1">{job.error}</p> : null}
                {downloadUnavailable ? (
                  <p className="text-xs text-amber-700 mt-1">
                    Download unavailable after refresh. Reconvert to regenerate the output.
                  </p>
                ) : null}
              </div>

              {job.status === 'running' ? (
                <div className="w-40">
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-primary-600 transition-all" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{Math.round((job.progress || 0) * 100)}%</p>
                </div>
              ) : (
                <div className="w-40" />
              )}

              <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusClass(job.status, job.needsConversion)}`}>
                {statusLabel(job)}
              </span>

              {(job.status === 'failed' || job.status === 'canceled' || downloadUnavailable) && (
                <button
                  type="button"
                  onClick={() => retryJob(job.id)}
                  disabled={isConverting || job.status === 'running'}
                  className="btn-outline px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {downloadUnavailable ? 'Reconvert' : 'Retry'}
                </button>
              )}

                <button
                  type="button"
                  onClick={async () => {
                    const file = convertedFile || (await resolveConvertedFile(job.id))
                    if (!file) {
                      setPageError('This converted file is no longer available. Please convert it again.')
                      return
                    }
                    downloadFile(file)
                  }}
                  disabled={!convertedFile && !hasPersistedOutput}
                  className="btn-outline px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Download
                </button>

              <button
                type="button"
                onClick={() => removeJob(job.id)}
                disabled={isConverting || job.status === 'running'}
                className="btn-outline px-3 py-1.5 text-sm text-red-700 border-red-300 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={`Remove ${job.title}`}
              >
                X
              </button>
            </div>
          )})}

          {conversionJobs.length === 0 && (
            <div className="p-8 text-center text-gray-500">No files selected yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}
