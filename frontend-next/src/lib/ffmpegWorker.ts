import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { openDB } from './idb'
import { readBinaryFile, writeBinaryFile } from './storage'

export type CodecInfo = {
  isStandard: boolean
  formatCode?: number
  codecName?: string
  sampleRate?: number
  channels?: number
  needsConversion: boolean
  isCorrupted?: boolean
}

type ProgressCallback = (ratio: number) => void
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>
}

const STANDARD_WAV_FORMATS: Record<number, string> = {
  0x0001: 'PCM',
  0x0003: 'IEEE Float',
  0x0006: 'A-law',
  0x0007: 'mu-law',
  0x0055: 'MP3',
}

const KNOWN_PROPRIETARY_WAV_FORMATS: Record<number, string> = {
  0x2222: 'G.729',
  0x0131: 'GSM-AMR',
}

const STANDARD_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'])
const STANDARD_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])
const KNOWN_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'])
const KNOWN_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav', 'wma'])
const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  avi: 'video/x-msvideo',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  webm: 'video/webm',
  wma: 'audio/x-ms-wma',
}

const CACHE_DIR = 'cache/converted'
const CACHE_KEY_SAMPLE_BYTES = 64 * 1024
const CONVERTED_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
const WORKSPACE_IDB_KEY = 'workspace-dir-handle'

let ffmpegInstance: FFmpeg | null = null
let loadPromise: Promise<void> | null = null
let operationQueue: Promise<void> = Promise.resolve()
let activeProgressCallback: ProgressCallback | null = null
let terminatedByUser = false
let listenersAttached = false

const progressListener = ({ progress }: { progress: number }) => {
  if (!activeProgressCallback) return
  const ratio = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
  activeProgressCallback(ratio)
}

export class FFmpegCanceledError extends Error {
  constructor() {
    super('Conversion canceled')
    this.name = 'FFmpegCanceledError'
  }
}

function runSerial<T>(operation: () => Promise<T>): Promise<T> {
  const next = operationQueue.then(operation, operation)
  operationQueue = next.then(() => undefined, () => undefined)
  return next
}

function resetFFmpegRuntime(): void {
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate()
    } catch {
      // Ignore termination failures
    }
  }
  ffmpegInstance = null
  loadPromise = null
  listenersAttached = false
  activeProgressCallback = null
}

function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex === -1) return ''
  return filename.slice(dotIndex + 1).toLowerCase()
}

function replaceExtension(filename: string, extension: string): string {
  const dotIndex = filename.lastIndexOf('.')
  const base = dotIndex === -1 ? filename : filename.slice(0, dotIndex)
  return `${base}${extension}`
}

function getConvertedExtension(file: File): 'wav' | 'mp4' {
  return isLikelyVideoFile(file) ? 'mp4' : 'wav'
}

function getConvertedMimeType(file: File): string {
  return isLikelyVideoFile(file) ? 'video/mp4' : 'audio/wav'
}

function getConvertedFilename(file: File): string {
  const ext = getConvertedExtension(file)
  return replaceExtension(file.name, `_converted.${ext}`)
}

function getMimeTypeFromFilename(filename: string, fallbackFile: File): string {
  const extension = getFileExtension(filename)
  const byExtension = MIME_TYPE_BY_EXTENSION[extension]
  if (byExtension) return byExtension
  if (fallbackFile.type) return fallbackFile.type
  return isLikelyVideoFile(fallbackFile) ? 'video/mp4' : 'audio/wav'
}

function isLikelyVideoFile(file: File): boolean {
  if ((file.type || '').startsWith('video/')) return true
  const extension = getFileExtension(file.name)
  return KNOWN_VIDEO_EXTENSIONS.has(extension)
}

function isLikelyWavFile(file: File): boolean {
  const extension = getFileExtension(file.name)
  return extension === 'wav' || (file.type || '').toLowerCase().includes('wav')
}

function isKnownStandardByExtension(file: File): CodecInfo | null {
  const extension = getFileExtension(file.name)
  if (STANDARD_AUDIO_EXTENSIONS.has(extension)) {
    return {
      isStandard: true,
      codecName: extension.toUpperCase(),
      needsConversion: false,
    }
  }
  if (STANDARD_VIDEO_EXTENSIONS.has(extension)) {
    return {
      isStandard: true,
      codecName: extension.toUpperCase(),
      needsConversion: false,
    }
  }
  return null
}

function getContainerKind(file: File): 'audio' | 'video' {
  if (isLikelyVideoFile(file)) return 'video'
  return 'audio'
}

function readAscii(view: DataView, offset: number, length: number): string {
  let text = ''
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i))
  }
  return text
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  throw new Error('Unexpected ffmpeg output data type')
}

function toBlobBuffer(bytes: Uint8Array): ArrayBuffer {
  // Ensure File/Blob always receives an ArrayBuffer-backed payload (not SharedArrayBuffer-backed).
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : 'Unknown FFmpeg error')
}

function isOutOfMemoryError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return (
    message.includes('memory') ||
    message.includes('cannot enlarge memory') ||
    message.includes('out of memory')
  )
}

async function canPlayNatively(file: File): Promise<boolean> {
  if (typeof document === 'undefined') return true
  const isVideo = getContainerKind(file) === 'video'
  const element = document.createElement(isVideo ? 'video' : 'audio')
  const url = URL.createObjectURL(file)

  return new Promise<boolean>((resolve) => {
    let done = false
    const cleanUp = () => {
      if (done) return
      done = true
      element.removeAttribute('src')
      element.load()
      URL.revokeObjectURL(url)
    }
    const finish = (result: boolean) => {
      cleanUp()
      resolve(result)
    }
    const timeout = window.setTimeout(() => finish(false), 2500)

    const onReady = () => {
      window.clearTimeout(timeout)
      finish(true)
    }
    const onError = () => {
      window.clearTimeout(timeout)
      finish(false)
    }

    element.addEventListener('canplay', onReady, { once: true })
    element.addEventListener('loadedmetadata', onReady, { once: true })
    element.addEventListener('error', onError, { once: true })
    element.preload = 'metadata'
    element.src = url
    element.load()
  })
}

async function parseWavHeader(file: File): Promise<CodecInfo | null> {
  const readSize = Math.min(file.size, 4096)
  if (readSize < 12) return null

  const buffer = await file.slice(0, readSize).arrayBuffer()
  const view = new DataView(buffer)

  let headerZeroed = true
  for (let i = 0; i < Math.min(60, view.byteLength); i += 1) {
    if (view.getUint8(i) !== 0) {
      headerZeroed = false
      break
    }
  }
  if (headerZeroed) {
    let hasData = false
    for (let i = 60; i < Math.min(view.byteLength, 1024); i += 1) {
      if (view.getUint8(i) !== 0) {
        hasData = true
        break
      }
    }
    if (hasData) {
      return {
        isStandard: false,
        codecName: 'Corrupted WAV header',
        needsConversion: true,
        isCorrupted: true,
      }
    }
  }

  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    return null
  }

  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const dataOffset = offset + 8

    if (chunkId === 'fmt ' && dataOffset + 16 <= view.byteLength) {
      const formatCode = view.getUint16(dataOffset, true)
      const channels = view.getUint16(dataOffset + 2, true)
      const sampleRate = view.getUint32(dataOffset + 4, true)

      let resolvedCode = formatCode
      let codecName: string | undefined

      if (formatCode === 0xfffe && dataOffset + 26 <= view.byteLength) {
        const subFormatCode = view.getUint16(dataOffset + 24, true)
        resolvedCode = subFormatCode
        codecName = STANDARD_WAV_FORMATS[subFormatCode] || KNOWN_PROPRIETARY_WAV_FORMATS[subFormatCode] || 'Extensible WAV'
      } else {
        codecName = STANDARD_WAV_FORMATS[formatCode] || KNOWN_PROPRIETARY_WAV_FORMATS[formatCode] || `Unknown (0x${formatCode.toString(16)})`
      }

      const isStandard = Boolean(STANDARD_WAV_FORMATS[resolvedCode])
      return {
        isStandard,
        formatCode: resolvedCode,
        codecName,
        sampleRate,
        channels,
        needsConversion: !isStandard,
      }
    }

    const paddedSize = chunkSize + (chunkSize % 2)
    offset = dataOffset + paddedSize
  }

  return {
    isStandard: false,
    codecName: 'Unknown WAV format',
    needsConversion: true,
    isCorrupted: true,
  }
}

async function maybeRepairWav(file: File): Promise<File> {
  if (!isLikelyWavFile(file)) return file
  const buffer = await file.arrayBuffer()
  const repaired = attemptWavHeaderRepair(buffer)
  if (!repaired) return file
  return new File([repaired], file.name, {
    type: file.type || 'audio/wav',
    lastModified: file.lastModified,
  })
}

async function removeVirtualFile(ffmpeg: FFmpeg, path: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    // Ignore file cleanup errors
  }
}

function conversionArgs(file: File, inputName: string, outputName: string): string[] {
  if (isLikelyVideoFile(file)) {
    return [
      '-i', inputName,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputName,
    ]
  }

  return [
    '-i', inputName,
    '-acodec', 'pcm_s16le',
    outputName,
  ]
}

function isLikelyG729Codec(codecInfo: CodecInfo | null): boolean {
  if (!codecInfo) return false
  if (codecInfo.formatCode === 0x2222) return true
  const label = (codecInfo.codecName || '').toLowerCase()
  return label.includes('g.729') || label.includes('g729')
}

type ConversionAttempt = {
  label: string
  args: string[]
}

function buildConversionAttempts(
  file: File,
  inputName: string,
  outputName: string,
  codecInfo: CodecInfo | null,
): ConversionAttempt[] {
  const attempts: ConversionAttempt[] = [
    {
      label: 'default',
      args: conversionArgs(file, inputName, outputName),
    },
  ]

  if (!isLikelyVideoFile(file) && isLikelyG729Codec(codecInfo)) {
    attempts.push({
      label: 'force-g729-decoder',
      args: [
        '-f', 'wav',
        '-c:a', 'g729',
        '-i', inputName,
        '-acodec', 'pcm_s16le',
        outputName,
      ],
    })
    attempts.push({
      label: 'force-g729-decoder-mono',
      args: [
        '-f', 'wav',
        '-ac', '1',
        '-c:a', 'g729',
        '-i', inputName,
        '-acodec', 'pcm_s16le',
        outputName,
      ],
    })
  }

  return attempts
}

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg()
    listenersAttached = false
  }

  if (!listenersAttached) {
    ffmpegInstance.on('progress', progressListener)
    listenersAttached = true
  }

  if (!loadPromise) {
    loadPromise = ffmpegInstance.load({
      coreURL: '/ffmpeg-core.js',
      wasmURL: '/ffmpeg-core.wasm',
    })
      .then(() => undefined)
      .catch((error) => {
        ffmpegInstance = null
        listenersAttached = false
        throw error
      })
      .finally(() => {
        loadPromise = null
      })
  }

  await loadPromise
  return ffmpegInstance
}

export function cancelActiveFFmpegJob(): void {
  terminatedByUser = true
  resetFFmpegRuntime()
}

export async function detectCodec(file: File): Promise<CodecInfo> {
  if (isLikelyWavFile(file)) {
    const wavInfo = await parseWavHeader(file)
    if (wavInfo) return wavInfo
    return {
      isStandard: false,
      codecName: 'Unknown WAV format',
      needsConversion: true,
      isCorrupted: true,
    }
  }

  const byExtension = isKnownStandardByExtension(file)
  if (byExtension) return byExtension

  const extension = getFileExtension(file.name)
  if (KNOWN_AUDIO_EXTENSIONS.has(extension) || KNOWN_VIDEO_EXTENSIONS.has(extension)) {
    const canPlay = await canPlayNatively(file)
    return {
      isStandard: canPlay,
      codecName: canPlay ? extension.toUpperCase() : `Unsupported ${extension.toUpperCase()}`,
      needsConversion: !canPlay,
    }
  }

  const canPlay = await canPlayNatively(file)
  return {
    isStandard: canPlay,
    codecName: canPlay ? 'Browser-supported' : 'Unknown',
    needsConversion: !canPlay,
  }
}

export async function convertToPlayable(
  file: File,
  onProgress?: ProgressCallback,
): Promise<File> {
  return runSerial(async () => {
    terminatedByUser = false
    const sourceFile = await maybeRepairWav(file)
    const ffmpeg = await getFFmpeg()
    const inputExt = getFileExtension(sourceFile.name) || (isLikelyVideoFile(sourceFile) ? 'mp4' : 'wav')
    const outputExt = getConvertedExtension(sourceFile)
    const inputName = `input.${inputExt}`
    const outputName = `output.${outputExt}`
    const sourceCodec = isLikelyWavFile(sourceFile) ? await parseWavHeader(sourceFile) : null

    activeProgressCallback = onProgress ?? null

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(sourceFile))

      let lastError: Error | null = null
      const attempts = buildConversionAttempts(sourceFile, inputName, outputName, sourceCodec)

      for (const attempt of attempts) {
        await removeVirtualFile(ffmpeg, outputName)
        try {
          const exitCode = await ffmpeg.exec(attempt.args)
          if (exitCode !== 0) {
            throw new Error(`FFmpeg conversion failed (${attempt.label})`)
          }

          const outputData = await ffmpeg.readFile(outputName)
          const bytes = toUint8Array(outputData)
          if (bytes.byteLength === 0) {
            throw new Error(`FFmpeg conversion produced an empty output file (${attempt.label})`)
          }

          return new File([toBlobBuffer(bytes)], getConvertedFilename(file), {
            type: getConvertedMimeType(file),
          })
        } catch (attemptError) {
          if (terminatedByUser) {
            terminatedByUser = false
            throw new FFmpegCanceledError()
          }
          lastError = normalizeError(attemptError)
        }
      }

      if (lastError) {
        if (isOutOfMemoryError(lastError)) {
          throw new Error('File too large for in-browser conversion. Consider desktop FFmpeg.')
        }
        if (isLikelyG729Codec(sourceCodec)) {
          throw new Error(
            'This G.729 file could not be decoded in-browser by the current FFmpeg build. ' +
            'Convert locally with desktop FFmpeg and re-import.',
          )
        }
        throw lastError
      }
      throw new Error('FFmpeg conversion failed')
    } catch (error) {
      if (terminatedByUser) {
        terminatedByUser = false
        throw new FFmpegCanceledError()
      }
      const normalized = normalizeError(error)
      if (isOutOfMemoryError(normalized)) {
        throw new Error('File too large for in-browser conversion. Consider desktop FFmpeg.')
      }
      throw normalized
    } finally {
      activeProgressCallback = null
      await removeVirtualFile(ffmpeg, inputName)
      await removeVirtualFile(ffmpeg, outputName)
    }
  })
}

export async function clipMedia(
  file: File,
  startTime: number,
  endTime: number,
  onProgress?: ProgressCallback,
): Promise<File> {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new Error('Invalid clip time range.')
  }

  return runSerial(async () => {
    terminatedByUser = false
    const ffmpeg = await getFFmpeg()
    const sourceFile = await maybeRepairWav(file)
    const inputExt = getFileExtension(sourceFile.name) || (isLikelyVideoFile(sourceFile) ? 'mp4' : 'wav')
    const inputName = `clip-input.${inputExt}`
    const copyOutputName = `clip-output.${inputExt}`
    const fallbackOutputName = isLikelyVideoFile(sourceFile) ? 'clip-output.mp4' : 'clip-output.wav'
    const duration = Math.max(0, endTime - startTime)

    activeProgressCallback = onProgress ?? null

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(sourceFile))

      let outputName = copyOutputName

      try {
        const copyExit = await ffmpeg.exec([
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-i', inputName,
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          outputName,
        ])
        if (copyExit !== 0) throw new Error('Stream copy failed')
      } catch {
        await removeVirtualFile(ffmpeg, copyOutputName)
        outputName = fallbackOutputName

        const fallbackArgs = isLikelyVideoFile(sourceFile)
          ? [
            '-ss', startTime.toString(),
            '-t', duration.toString(),
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-avoid_negative_ts', 'make_zero',
            outputName,
          ]
          : [
            '-ss', startTime.toString(),
            '-t', duration.toString(),
            '-i', inputName,
            '-acodec', 'pcm_s16le',
            outputName,
          ]

        const fallbackExit = await ffmpeg.exec(fallbackArgs)
        if (fallbackExit !== 0) {
          throw new Error('Clip export failed')
        }
      }

      const outputData = await ffmpeg.readFile(outputName)
      const bytes = toUint8Array(outputData)
      const outputExtension = getFileExtension(outputName)
      const outputFilename = outputExtension
        ? replaceExtension(file.name, `_clip.${outputExtension}`)
        : replaceExtension(file.name, '_clip')
      return new File([toBlobBuffer(bytes)], outputFilename, {
        type: getMimeTypeFromFilename(outputName, sourceFile),
      })
    } catch (error) {
      if (terminatedByUser) {
        terminatedByUser = false
        throw new FFmpegCanceledError()
      }
      throw normalizeError(error)
    } finally {
      activeProgressCallback = null
      await removeVirtualFile(ffmpeg, inputName)
      await removeVirtualFile(ffmpeg, copyOutputName)
      await removeVirtualFile(ffmpeg, fallbackOutputName)
    }
  })
}

export async function extractAudio(
  file: File,
  onProgress?: ProgressCallback,
): Promise<File> {
  return runSerial(async () => {
    terminatedByUser = false
    const sourceFile = await maybeRepairWav(file)
    const inputExt = getFileExtension(sourceFile.name) || (isLikelyVideoFile(sourceFile) ? 'mp4' : 'wav')
    const inputName = `audio-input.${inputExt}`
    const outputName = 'audio-output.mp3'

    const runExtractionAttempt = async (): Promise<File> => {
      const ffmpeg = await getFFmpeg()
      activeProgressCallback = onProgress ?? null
      try {
        await ffmpeg.writeFile(inputName, await fetchFile(sourceFile))

        const attempts: Array<{ label: string; args: string[] }> = [
          {
            label: 'libmp3lame',
            args: [
              '-i', inputName,
              '-map', '0:a:0?',
              '-vn',
              '-sn',
              '-dn',
              '-ac', '1',
              '-ar', '16000',
              '-c:a', 'libmp3lame',
              '-b:a', '96k',
              outputName,
            ],
          },
          {
            label: 'default-mp3',
            args: [
              '-i', inputName,
              '-map', '0:a:0?',
              '-vn',
              '-sn',
              '-dn',
              '-ac', '1',
              '-ar', '16000',
              '-b:a', '96k',
              outputName,
            ],
          },
        ]

        let lastError: Error | null = null
        for (const attempt of attempts) {
          await removeVirtualFile(ffmpeg, outputName)
          try {
            const exitCode = await ffmpeg.exec(attempt.args)
            if (exitCode !== 0) {
              throw new Error(`Audio extraction failed (${attempt.label})`)
            }
            const outputData = await ffmpeg.readFile(outputName)
            const bytes = toUint8Array(outputData)
            if (bytes.byteLength === 0) {
              throw new Error(`Audio extraction produced empty output (${attempt.label})`)
            }
            return new File([toBlobBuffer(bytes)], replaceExtension(file.name, '_audio.mp3'), {
              type: 'audio/mpeg',
            })
          } catch (attemptError) {
            if (terminatedByUser) {
              terminatedByUser = false
              throw new FFmpegCanceledError()
            }
            lastError = normalizeError(attemptError)
          }
        }

        throw lastError ?? new Error('Audio extraction failed')
      } finally {
        activeProgressCallback = null
        await removeVirtualFile(ffmpeg, inputName)
        await removeVirtualFile(ffmpeg, outputName)
      }
    }

    try {
      return await runExtractionAttempt()
    } catch (firstError) {
      if (firstError instanceof FFmpegCanceledError) throw firstError
      const normalized = normalizeError(firstError)
      if (isOutOfMemoryError(normalized)) {
        throw new Error('File too large for in-browser audio extraction. Split the file or use desktop FFmpeg.')
      }

      resetFFmpegRuntime()

      try {
        return await runExtractionAttempt()
      } catch (secondError) {
        if (secondError instanceof FFmpegCanceledError) throw secondError
        const finalError = normalizeError(secondError)
        if (isOutOfMemoryError(finalError)) {
          throw new Error('File too large for in-browser audio extraction. Split the file or use desktop FFmpeg.')
        }
        throw finalError
      }
    }
  })
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

async function getWorkspaceHandleFromIndexedDB(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB()
    return await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
      const tx = db.transaction('workspace', 'readonly')
      const store = tx.objectStore('workspace')
      const request = store.get(WORKSPACE_IDB_KEY)
      request.onsuccess = () => {
        resolve((request.result as FileSystemDirectoryHandle | null) ?? null)
      }
      request.onerror = () => {
        resolve(null)
      }
    })
  } catch {
    return null
  }
}

async function getConvertedCacheDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const workspace = await getWorkspaceHandleFromIndexedDB()
  if (!workspace) return null

  try {
    const cache = await workspace.getDirectoryHandle('cache', { create })
    return await cache.getDirectoryHandle('converted', { create })
  } catch {
    return null
  }
}

async function pruneConvertedCache(maxBytes = CONVERTED_CACHE_MAX_BYTES): Promise<void> {
  const cacheDir = await getConvertedCacheDirectory(false)
  if (!cacheDir) return

  const entries: Array<{ name: string; size: number; lastModified: number }> = []

  for await (const [name, handle] of (cacheDir as IterableDirectoryHandle).entries()) {
    if (handle.kind !== 'file') continue
    try {
      const file = await (handle as FileSystemFileHandle).getFile()
      entries.push({
        name,
        size: file.size,
        lastModified: file.lastModified,
      })
    } catch {
      // Skip inaccessible cache entries.
    }
  }

  let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (totalSize <= maxBytes) return

  entries.sort((a, b) => a.lastModified - b.lastModified)

  for (const entry of entries) {
    if (totalSize <= maxBytes) break
    try {
      await cacheDir.removeEntry(entry.name)
      totalSize -= entry.size
    } catch {
      // Ignore deletion failures and continue pruning the remaining entries.
    }
  }
}

export async function cacheKey(file: File): Promise<string> {
  const sampleSize = Math.min(file.size, CACHE_KEY_SAMPLE_BYTES)
  const sample = await file.slice(0, sampleSize).arrayBuffer()
  const metadata = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}|`)
  const payload = new Uint8Array(metadata.byteLength + sample.byteLength)
  payload.set(metadata, 0)
  payload.set(new Uint8Array(sample), metadata.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', payload)
  return bytesToHex(new Uint8Array(digest)).slice(0, 16)
}

export async function getConvertedCachePath(file: File): Promise<string> {
  const extension = getConvertedExtension(file)
  const key = await cacheKey(file)
  return `${CACHE_DIR}/${key}.${extension}`
}

export async function readConvertedFromCache(file: File): Promise<File | null> {
  const path = await getConvertedCachePath(file)
  const bytes = await readBinaryFile(path)
  if (!bytes) return null

  return new File([bytes], getConvertedFilename(file), {
    type: getConvertedMimeType(file),
    lastModified: Date.now(),
  })
}

export async function writeConvertedToCache(originalFile: File, convertedFile: File): Promise<void> {
  const path = await getConvertedCachePath(originalFile)
  const data = await convertedFile.arrayBuffer()
  await writeBinaryFile(path, data)
  await pruneConvertedCache().catch(() => undefined)
}

export function attemptWavHeaderRepair(buffer: ArrayBuffer): ArrayBuffer | null {
  const view = new DataView(buffer)
  if (buffer.byteLength < 60) return null

  let headerZeroed = true
  for (let i = 0; i < 60; i += 1) {
    if (view.getUint8(i) !== 0) {
      headerZeroed = false
      break
    }
  }
  if (!headerZeroed) return null

  let hasData = false
  for (let i = 60; i < Math.min(buffer.byteLength, 1024); i += 1) {
    if (view.getUint8(i) !== 0) {
      hasData = true
      break
    }
  }
  if (!hasData) return null

  const dataSize = buffer.byteLength - 60
  const header = new ArrayBuffer(60)
  const hv = new DataView(header)

  writeString(hv, 0, 'RIFF')
  hv.setUint32(4, dataSize + 52, true)
  writeString(hv, 8, 'WAVE')

  writeString(hv, 12, 'fmt ')
  hv.setUint32(16, 20, true)
  hv.setUint16(20, 0x2222, true)
  hv.setUint16(22, 2, true)
  hv.setUint32(24, 8000, true)
  hv.setUint32(28, 2000, true)
  hv.setUint16(32, 20, true)
  hv.setUint16(34, 1, true)
  hv.setUint16(36, 2, true)
  hv.setUint16(38, 1, true)

  writeString(hv, 40, 'fact')
  hv.setUint32(44, 4, true)
  hv.setUint32(48, 0, true)

  writeString(hv, 52, 'data')
  hv.setUint32(56, dataSize, true)

  const result = new ArrayBuffer(60 + dataSize)
  new Uint8Array(result).set(new Uint8Array(header))
  new Uint8Array(result).set(new Uint8Array(buffer, 60), 60)
  return result
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
