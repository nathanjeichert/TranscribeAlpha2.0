import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
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

const CACHE_DIR = 'cache/converted'

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
    message.includes('out of memory') ||
    message.includes('wasm')
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
  activeProgressCallback = null

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
    const ffmpeg = await getFFmpeg()
    const inputExt = getFileExtension(file.name) || (isLikelyVideoFile(file) ? 'mp4' : 'wav')
    const outputExt = getConvertedExtension(file)
    const inputName = `input.${inputExt}`
    const outputName = `output.${outputExt}`
    const sourceFile = await maybeRepairWav(file)

    activeProgressCallback = onProgress ?? null

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(sourceFile))
      const exitCode = await ffmpeg.exec(conversionArgs(file, inputName, outputName))
      if (exitCode !== 0) {
        throw new Error('FFmpeg conversion failed')
      }
      const outputData = await ffmpeg.readFile(outputName)
      const bytes = toUint8Array(outputData)
      return new File([toBlobBuffer(bytes)], getConvertedFilename(file), {
        type: getConvertedMimeType(file),
      })
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
    const inputExt = getFileExtension(file.name) || (isLikelyVideoFile(file) ? 'mp4' : 'wav')
    const inputName = `clip-input.${inputExt}`
    const copyOutputName = `clip-output.${inputExt}`
    const fallbackOutputName = isLikelyVideoFile(file) ? 'clip-output.mp4' : 'clip-output.wav'
    const duration = Math.max(0, endTime - startTime)

    activeProgressCallback = onProgress ?? null

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(file))

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

        const fallbackArgs = isLikelyVideoFile(file)
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
      const resultType = outputName.endsWith('.mp4') ? 'video/mp4' : (file.type || 'audio/wav')
      const extension = outputName.endsWith('.mp4') ? '.mp4' : '.wav'
      return new File([toBlobBuffer(bytes)], replaceExtension(file.name, `_clip${extension}`), {
        type: resultType,
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
    const ffmpeg = await getFFmpeg()
    const inputExt = getFileExtension(file.name) || (isLikelyVideoFile(file) ? 'mp4' : 'wav')
    const inputName = `audio-input.${inputExt}`
    const outputName = 'audio-output.mp3'

    activeProgressCallback = onProgress ?? null

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(file))
      const exitCode = await ffmpeg.exec([
        '-i', inputName,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-b:a', '96k',
        outputName,
      ])
      if (exitCode !== 0) {
        throw new Error('Audio extraction failed')
      }
      const outputData = await ffmpeg.readFile(outputName)
      const bytes = toUint8Array(outputData)
      return new File([toBlobBuffer(bytes)], replaceExtension(file.name, '_audio.mp3'), {
        type: 'audio/mpeg',
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
      await removeVirtualFile(ffmpeg, outputName)
    }
  })
}

export function cacheKey(file: File): string {
  const raw = `${file.name}|${file.size}|${file.lastModified}`
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export function getConvertedCachePath(file: File): string {
  const extension = getConvertedExtension(file)
  return `${CACHE_DIR}/${cacheKey(file)}.${extension}`
}

export async function readConvertedFromCache(file: File): Promise<File | null> {
  const path = getConvertedCachePath(file)
  const bytes = await readBinaryFile(path)
  if (!bytes) return null

  return new File([bytes], getConvertedFilename(file), {
    type: getConvertedMimeType(file),
    lastModified: Date.now(),
  })
}

export async function writeConvertedToCache(originalFile: File, convertedFile: File): Promise<void> {
  const path = getConvertedCachePath(originalFile)
  const data = await convertedFile.arrayBuffer()
  await writeBinaryFile(path, data)
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
  for (let i = 60; i < Math.min(buffer.byteLength, 120); i += 1) {
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
