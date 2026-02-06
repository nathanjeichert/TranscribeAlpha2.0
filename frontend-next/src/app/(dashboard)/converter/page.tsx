'use client'

import JSZip from 'jszip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDashboard } from '@/context/DashboardContext'
import {
  FFmpegCanceledError,
  cancelActiveFFmpegJob,
  convertToPlayable,
  detectCodec,
  readConvertedFromCache,
  writeConvertedToCache,
  type CodecInfo,
} from '@/lib/ffmpegWorker'

type ConverterStatus =
  | 'detecting'
  | 'ready'
  | 'already-playable'
  | 'skipped'
  | 'converting'
  | 'converted'
  | 'failed'

interface ConverterItem {
  id: string
  file: File
  codec: CodecInfo | null
  status: ConverterStatus
  progress: number
  error: string
  convertedFile: File | null
}

const buildId = () => `${Date.now()}_${Math.random().toString(16).slice(2)}`

function statusLabel(status: ConverterStatus): string {
  if (status === 'detecting') return 'Detecting'
  if (status === 'ready') return 'Ready'
  if (status === 'already-playable') return 'Already OK'
  if (status === 'skipped') return 'Skipped'
  if (status === 'converting') return 'Converting'
  if (status === 'converted') return 'Converted'
  return 'Failed'
}

function statusClass(status: ConverterStatus): string {
  if (status === 'converted') return 'bg-green-100 text-green-700'
  if (status === 'ready') return 'bg-blue-100 text-blue-700'
  if (status === 'already-playable') return 'bg-gray-100 text-gray-700'
  if (status === 'converting') return 'bg-primary-100 text-primary-700'
  if (status === 'failed') return 'bg-red-100 text-red-700'
  return 'bg-amber-100 text-amber-800'
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
  const { appVariant } = useDashboard()
  const [items, setItems] = useState<ConverterItem[]>([])
  const [pageError, setPageError] = useState('')
  const [pageNotice, setPageNotice] = useState('')
  const [isConverting, setIsConverting] = useState(false)
  const [zipBusy, setZipBusy] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const stopRequestedRef = useRef(false)
  const itemsRef = useRef<ConverterItem[]>([])

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const updateItem = useCallback((id: string, updater: Partial<ConverterItem> | ((item: ConverterItem) => ConverterItem)) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        if (typeof updater === 'function') {
          return updater(item)
        }
        return { ...item, ...updater }
      }),
    )
  }, [])

  const detectForItem = useCallback(async (id: string, file: File) => {
    try {
      const codec = await detectCodec(file)
      if (codec.needsConversion) {
        updateItem(id, {
          codec,
          status: 'ready',
          error: '',
        })
        return
      }

      updateItem(id, {
        codec,
        status: 'already-playable',
        error: '',
      })
    } catch {
      updateItem(id, {
        codec: null,
        status: 'skipped',
        error: 'Could not detect format.',
      })
    }
  }, [updateItem])

  const addFiles = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return
    setPageError('')
    setPageNotice('')

    const newItems: ConverterItem[] = incoming.map((file) => ({
      id: buildId(),
      file,
      codec: null,
      status: 'detecting',
      progress: 0,
      error: '',
      convertedFile: null,
    }))

    setItems((prev) => [...prev, ...newItems])

    for (const item of newItems) {
      await detectForItem(item.id, item.file)
    }
  }, [detectForItem])

  const handleFileInputChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || !files.length) return
    await addFiles(Array.from(files))
    event.target.value = ''
  }, [addFiles])

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    const files = event.dataTransfer.files
    if (!files || !files.length) return
    await addFiles(Array.from(files))
  }, [addFiles])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
  }, [])

  const convertReadyFiles = useCallback(async () => {
    if (isConverting) return

    const readyItems = itemsRef.current.filter((item) => item.status === 'ready')
    if (!readyItems.length) {
      setPageError('No files are ready to convert.')
      return
    }

    stopRequestedRef.current = false
    setIsConverting(true)
    setPageError('')
    setPageNotice('')

    try {
      for (const item of readyItems) {
        if (stopRequestedRef.current) break

        updateItem(item.id, {
          status: 'converting',
          progress: 0,
          error: '',
        })

        try {
          const cached = await readConvertedFromCache(item.file)
          if (cached) {
            updateItem(item.id, {
              status: 'converted',
              convertedFile: cached,
              progress: 1,
            })
            continue
          }

          const converted = await convertToPlayable(item.file, (ratio) => {
            updateItem(item.id, {
              status: 'converting',
              progress: ratio,
            })
          })

          await writeConvertedToCache(item.file, converted)

          updateItem(item.id, {
            status: 'converted',
            convertedFile: converted,
            progress: 1,
          })
        } catch (error) {
          if (error instanceof FFmpegCanceledError || stopRequestedRef.current) {
            updateItem(item.id, {
              status: 'failed',
              error: 'Conversion canceled.',
            })
            break
          }

          const message = error instanceof Error ? error.message : 'Conversion failed.'
          updateItem(item.id, {
            status: 'failed',
            error: message,
          })
        }
      }
    } finally {
      setIsConverting(false)
      if (stopRequestedRef.current) {
        setPageNotice('Conversion stopped. Completed files were kept.')
      }
      stopRequestedRef.current = false
    }
  }, [isConverting, updateItem])

  const handleStop = useCallback(() => {
    stopRequestedRef.current = true
    cancelActiveFFmpegJob()
  }, [])

  const downloadAllZip = useCallback(async () => {
    const converted = itemsRef.current.filter((item) => item.convertedFile).map((item) => item.convertedFile as File)
    if (!converted.length) {
      setPageError('No converted files are available to download.')
      return
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
        zip.file(name, await file.arrayBuffer())
      }

      const blob = await zip.generateAsync({ type: 'blob' })
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
  }, [])

  const totals = useMemo(() => {
    const totalSize = items.reduce((sum, item) => sum + item.file.size, 0)
    const convertedCount = items.filter((item) => item.status === 'converted').length
    const readyCount = items.filter((item) => item.status === 'ready').length
    return { totalSize, convertedCount, readyCount }
  }, [items])

  if (appVariant !== 'criminal') {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Media Converter</h1>
          <p className="text-gray-600">The converter is available only in the criminal variant.</p>
        </div>
      </div>
    )
  }

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
          onDragOver={handleDragOver}
          className="block border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors border-gray-300 hover:border-primary-400 hover:bg-primary-50"
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
            <h2 className="font-semibold text-gray-900">Files ({items.length})</h2>
            <p className="text-sm text-gray-500">
              {formatBytes(totals.totalSize)} total, {totals.readyCount} ready, {totals.convertedCount} converted
            </p>
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
              onClick={() => {
                if (isConverting) return
                setItems([])
              }}
              disabled={isConverting || items.length === 0}
              className="btn-outline px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="divide-y divide-gray-100">
          {items.map((item) => (
            <div key={item.id} className="p-4 flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 truncate">{item.file.name}</p>
                <p className="text-sm text-gray-500">
                  {(item.codec?.codecName || 'Unknown')} • {formatBytes(item.file.size)}
                </p>
                {item.error && <p className="text-sm text-red-600 mt-1">{item.error}</p>}
              </div>

              {item.status === 'converting' ? (
                <div className="w-40">
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-primary-600 transition-all" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{Math.round(item.progress * 100)}%</p>
                </div>
              ) : (
                <div className="w-40" />
              )}

              <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusClass(item.status)}`}>
                {statusLabel(item.status)}
              </span>

              <button
                type="button"
                onClick={() => {
                  if (!item.convertedFile) return
                  downloadFile(item.convertedFile)
                }}
                disabled={!item.convertedFile}
                className="btn-outline px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Download
              </button>
            </div>
          ))}

          {items.length === 0 && (
            <div className="p-8 text-center text-gray-500">No files selected yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}
