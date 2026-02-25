import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { idbGet } from './idb'
import { readBinaryFile, writeBinaryFile } from './storage'
import { getFileExtension } from '@/utils/helpers'
import { isTauri } from './platform'

export type CodecInfo = {
  isStandard: boolean
  formatCode?: number
  codecName?: string
  sampleRate?: number
  channels?: number
  needsConversion: boolean
  isCorrupted?: boolean
}

export type ClipBatchRequest = {
  id: string
  startTime: number
  endTime: number
  downloadStem?: string
}

export type ClipBatchProgress = {
  total: number
  completed: number
  currentId: string | null
  currentRatio: number
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
const RESET_RUNTIME_AFTER_EXTRACT_BYTES = 200 * 1024 * 1024
const RESET_RUNTIME_AFTER_CONVERT_BYTES = 750 * 1024 * 1024
const RESET_RUNTIME_AFTER_CONVERT_COUNT = 25
const WORKERFS_SIZE_THRESHOLD = 2 * 1024 * 1024 * 1024
const WORKSPACE_IDB_KEY = 'workspace-dir-handle'
const DEFAULT_MEMORY_LIMIT_MB = 1024
const TELEPHONY_FORMAT_CODES = new Set([0x2222, 0x0131, 0x0006, 0x0007])

let runtimeMemoryLimitMB = DEFAULT_MEMORY_LIMIT_MB

type EncoderSupport = {
  libopus: boolean
  libmp3lame: boolean
}

export class FFmpegCanceledError extends Error {
  constructor() {
    super('Conversion canceled')
    this.name = 'FFmpegCanceledError'
  }
}

// ---------------------------------------------------------------------------
// FFmpegWorkerSlot — encapsulates one FFmpeg WASM instance + its state
// ---------------------------------------------------------------------------

class FFmpegWorkerSlot {
  instance: FFmpeg | null = null
  loadPromise: Promise<void> | null = null
  operationQueue: Promise<void> = Promise.resolve()
  activeProgressCallback: ProgressCallback | null = null
  terminatedByUser = false
  cancelReject: (() => void) | null = null
  listenersAttached = false
  encoderSupportPromise: Promise<EncoderSupport> | null = null
  conversionsSinceReset = 0
  convertedBytesSinceReset = 0
  busy = false
  estimatedMemoryBytes = 0

  private progressListener = ({ progress }: { progress: number }) => {
    if (!this.activeProgressCallback) return
    const ratio = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
    this.activeProgressCallback(ratio)
  }

  async getFFmpeg(): Promise<FFmpeg> {
    if (this.instance?.loaded) return this.instance
    if (!this.instance) {
      this.instance = new FFmpeg()
      this.listenersAttached = false
    }

    if (!this.listenersAttached) {
      this.instance.on('progress', this.progressListener)
      this.listenersAttached = true
    }

    if (!this.loadPromise) {
      this.loadPromise = this.instance.load({
        coreURL: '/ffmpeg-core.js',
        wasmURL: '/ffmpeg-core.wasm',
      })
        .then(() => undefined)
        .catch((error) => {
          this.instance = null
          this.listenersAttached = false
          throw error
        })
        .finally(() => {
          this.loadPromise = null
        })
    }

    await this.loadPromise
    return this.instance
  }

  reset(): void {
    if (this.instance) {
      try {
        this.instance.terminate()
      } catch {
        // Ignore termination failures
      }
    }
    this.instance = null
    this.loadPromise = null
    this.listenersAttached = false
    this.activeProgressCallback = null
    this.conversionsSinceReset = 0
    this.convertedBytesSinceReset = 0
    this.encoderSupportPromise = null
  }

  runSerial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation)
    this.operationQueue = next.then(() => undefined, () => undefined)
    return next
  }
}

// ---------------------------------------------------------------------------
// Pool manager
// ---------------------------------------------------------------------------

const MAX_POOL_SLOTS = 8
const SLOT_OVERHEAD_BYTES = 35 * 1024 * 1024
const pool: FFmpegWorkerSlot[] = []

function getPoolBudgetBytes(): number {
  return Math.floor(clampMemoryLimitMB(runtimeMemoryLimitMB) * 0.8 * 1024 * 1024)
}

function getPoolUsedBytes(): number {
  return pool.reduce((sum, s) => sum + (s.busy ? s.estimatedMemoryBytes : 0), 0)
}

function estimateJobMemory(file: File): number {
  return SLOT_OVERHEAD_BYTES + Math.ceil(file.size * 2.5)
}

function acquireSlot(file: File): FFmpegWorkerSlot | null {
  const estimate = estimateJobMemory(file)
  const used = getPoolUsedBytes()
  const budget = getPoolBudgetBytes()

  // If adding this job would exceed budget and something is already running, wait
  if (used + estimate > budget && pool.some((s) => s.busy)) return null

  // Find an idle slot
  const idle = pool.find((s) => !s.busy)
  if (idle) {
    idle.busy = true
    idle.estimatedMemoryBytes = estimate
    return idle
  }

  // Create a new slot if pool isn't full
  if (pool.length < MAX_POOL_SLOTS) {
    const slot = new FFmpegWorkerSlot()
    slot.busy = true
    slot.estimatedMemoryBytes = estimate
    pool.push(slot)
    return slot
  }

  return null
}

function releaseSlot(slot: FFmpegWorkerSlot): void {
  slot.busy = false
  slot.estimatedMemoryBytes = 0
}

async function waitForSlot(file: File): Promise<FFmpegWorkerSlot> {
  while (true) {
    const slot = acquireSlot(file)
    if (slot) return slot
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ---------------------------------------------------------------------------
// Legacy singleton access (used by getFFmpeg export for non-pool callers)
// ---------------------------------------------------------------------------

function getOrCreateDefaultSlot(): FFmpegWorkerSlot {
  if (pool.length === 0) {
    pool.push(new FFmpegWorkerSlot())
  }
  return pool[0]
}

function clampMemoryLimitMB(limitMb: number): number {
  if (!Number.isFinite(limitMb)) return DEFAULT_MEMORY_LIMIT_MB
  return Math.max(256, Math.min(4096, Math.floor(limitMb)))
}

function getResetAfterConvertBytes(): number {
  const scaled = Math.floor(clampMemoryLimitMB(runtimeMemoryLimitMB) * 0.5 * 1024 * 1024)
  return Math.max(64 * 1024 * 1024, Math.min(RESET_RUNTIME_AFTER_CONVERT_BYTES, scaled))
}

function getResetAfterExtractBytes(): number {
  const scaled = Math.floor(clampMemoryLimitMB(runtimeMemoryLimitMB) * 0.35 * 1024 * 1024)
  return Math.max(64 * 1024 * 1024, Math.min(RESET_RUNTIME_AFTER_EXTRACT_BYTES, scaled))
}

export function setFFmpegMemoryLimitMB(limitMb: number): void {
  runtimeMemoryLimitMB = clampMemoryLimitMB(limitMb)
}

// ---------------------------------------------------------------------------
// Shared operation runner & retry helpers
// ---------------------------------------------------------------------------

type OperationAttempt = {
  label: string
  args: string[]
  outputName: string
  /** Extra metadata the caller can attach and read back in buildResultFile. */
  [key: string]: unknown
}

type OperationConfig = {
  /** The source File (after any wav repair). */
  sourceFile: File
  /** Progress callback to wire up during the operation. */
  onProgress?: ProgressCallback | null
  /** Virtual-FS input filename (e.g. "input.wav"). */
  inputName: string
  /** Whether to use WORKERFS for large files. */
  useWorkerFS: boolean
  /** Mount point for WORKERFS. */
  workerFSMount: string
  /** Full path inside the WORKERFS mount. */
  workerFSInputPath: string
  /** Factory returning the ordered list of ffmpeg exec attempts.
   *  Called after ffmpeg is loaded and prepareAttempts (if any) has run. */
  getAttempts: () => OperationAttempt[]
  /** All output filenames that should be cleaned up in finally. */
  outputFilesToClean: string[]
  /** Builds the result File from the raw output bytes of a successful attempt. */
  buildResultFile: (bytes: Uint8Array, attempt: OperationAttempt) => File
  /** Optional: called to prepare state (e.g. fetch encoder support) before building attempts. Runs after ffmpeg is loaded. */
  prepareAttempts?: (ffmpeg: FFmpeg) => Promise<void>
  /** Optional: transforms the final aggregated error before throwing. */
  normalizeLastError?: (error: Error) => Error
  /** Pool slot to use for this operation. */
  slot: FFmpegWorkerSlot
}

/**
 * Runs an FFmpeg operation with shared input-mounting, attempt-loop,
 * progress-wiring, cancellation-checking, and cleanup logic.
 */
async function runFFmpegOperation(config: OperationConfig): Promise<File> {
  const slot = config.slot
  const ffmpeg = await slot.getFFmpeg()

  if (config.prepareAttempts) {
    await config.prepareAttempts(ffmpeg)
  }

  slot.activeProgressCallback = config.onProgress ?? null
  let mounted = false

  try {
    if (config.useWorkerFS) {
      await ffmpeg.mount('WORKERFS' as never, { files: [config.sourceFile] } as never, config.workerFSMount)
      mounted = true
    } else {
      await ffmpeg.writeFile(config.inputName, await fetchFile(config.sourceFile))
    }

    const attempts = config.getAttempts()
    let lastError: Error | null = null

    for (const attempt of attempts) {
      if (slot.terminatedByUser) {
        slot.terminatedByUser = false
        throw new FFmpegCanceledError()
      }
      await removeVirtualFile(ffmpeg, attempt.outputName)
      try {
        const exitCode = await new Promise<number>((resolve, reject) => {
          slot.cancelReject = () => reject(new FFmpegCanceledError())
          ffmpeg.exec(attempt.args).then(resolve, reject)
        }).finally(() => { slot.cancelReject = null })
        if (exitCode !== 0) {
          throw new Error(`Operation failed (${attempt.label})`)
        }
        const outputData = await ffmpeg.readFile(attempt.outputName)
        const bytes = toUint8Array(outputData)
        if (bytes.byteLength === 0) {
          throw new Error(`Operation produced empty output (${attempt.label})`)
        }
        return config.buildResultFile(bytes, attempt)
      } catch (attemptError) {
        if (slot.terminatedByUser) {
          slot.terminatedByUser = false
          throw new FFmpegCanceledError()
        }
        lastError = normalizeError(attemptError)
      }
    }

    if (lastError) {
      throw config.normalizeLastError ? config.normalizeLastError(lastError) : lastError
    }
    throw new Error('Operation failed.')
  } finally {
    slot.activeProgressCallback = null
    if (mounted) {
      try {
        await ffmpeg.unmount(config.workerFSMount)
      } catch {
        // Ignore unmount errors.
      }
    } else {
      await removeVirtualFile(ffmpeg, config.inputName)
    }
    for (const outputName of config.outputFilesToClean) {
      await removeVirtualFile(ffmpeg, outputName)
    }
  }
}

type RetryConfig<T> = {
  /** The operation to attempt (will be called up to 2 times). */
  operation: () => Promise<T>
  /** Called on success (both first attempt and retry). */
  onSuccess?: (result: T) => void
  /** Inspects an error before deciding whether to retry or re-throw.
   *  Throw inside this callback to abort immediately (e.g. for OOM).
   *  Return normally to proceed with retry / final-throw logic. */
  classifyError?: (error: Error) => void
  /** Transforms the final error before re-throwing on the last attempt.
   *  Only called when the retry also fails and classifyError did not throw. */
  normalizeLastError?: (error: Error) => Error
  /** Pool slot used for this operation. */
  slot: FFmpegWorkerSlot
}

/**
 * Wraps an FFmpeg operation with retry-on-failure + runtime-reset logic.
 * On first failure (that isn't a cancellation), resets the FFmpeg runtime
 * and retries once. On second failure, throws the (optionally normalized) error.
 */
async function withRetryAndReset<T>(config: RetryConfig<T>): Promise<T> {
  const slot = config.slot
  try {
    const result = await config.operation()
    config.onSuccess?.(result)
    return result
  } catch (firstError) {
    if (firstError instanceof FFmpegCanceledError) throw firstError
    if (slot.terminatedByUser) {
      slot.terminatedByUser = false
      throw new FFmpegCanceledError()
    }

    const normalized = normalizeError(firstError)
    // classifyError may throw to abort (e.g. for OOM), or return to proceed with retry
    config.classifyError?.(normalized)

    slot.reset()

    try {
      const result = await config.operation()
      config.onSuccess?.(result)
      return result
    } catch (secondError) {
      if (secondError instanceof FFmpegCanceledError) throw secondError
      if (slot.terminatedByUser) {
        slot.terminatedByUser = false
        throw new FFmpegCanceledError()
      }

      const finalError = normalizeError(secondError)
      config.classifyError?.(finalError)
      throw config.normalizeLastError ? config.normalizeLastError(finalError) : finalError
    }
  }
}

// ---------------------------------------------------------------------------

function replaceExtension(filename: string, extension: string): string {
  const dotIndex = filename.lastIndexOf('.')
  const base = dotIndex === -1 ? filename : filename.slice(0, dotIndex)
  return `${base}${extension}`
}

function getConvertedExtension(file: File, codecInfo: CodecInfo | null = null): 'wav' | 'mp4' | 'ogg' {
  if (isLikelyVideoFile(file)) return 'mp4'
  if (isTelephonyCodec(codecInfo)) return 'ogg'
  return 'wav'
}

function getConvertedMimeType(file: File, codecInfo: CodecInfo | null = null): string {
  if (isLikelyVideoFile(file)) return 'video/mp4'
  if (isTelephonyCodec(codecInfo)) return 'audio/ogg'
  return 'audio/wav'
}

function getConvertedFilename(file: File, extension?: string): string {
  const ext = extension || getConvertedExtension(file)
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

function isTelephonyCodec(codecInfo: CodecInfo | null): boolean {
  if (!codecInfo) return false
  if (typeof codecInfo.formatCode === 'number' && TELEPHONY_FORMAT_CODES.has(codecInfo.formatCode)) return true

  const label = (codecInfo.codecName || '').toLowerCase()
  if (!label) return false

  if (label.includes('g.729') || label.includes('g729')) return true
  if (label.includes('gsm') || label.includes('amr')) return true
  if (label.includes('g.711') || label.includes('g711')) return true
  if (label.includes('alaw') || label.includes('mu-law') || label.includes('mulaw')) return true
  return false
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

function sanitizeFilenameStem(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'clip'
}

function buildClipOutputFilename(
  sourceFile: File,
  outputName: string,
  request: ClipBatchRequest,
): string {
  const outputExtension = getFileExtension(outputName)
  const stem = request.downloadStem?.trim()
  if (stem) {
    return outputExtension ? `${sanitizeFilenameStem(stem)}.${outputExtension}` : sanitizeFilenameStem(stem)
  }

  if (outputExtension) {
    return replaceExtension(sourceFile.name, `_clip-${sanitizeFilenameStem(request.id)}.${outputExtension}`)
  }
  return replaceExtension(sourceFile.name, `_clip-${sanitizeFilenameStem(request.id)}`)
}

function normalizeClipExportError(error: unknown): Error {
  const normalized = normalizeError(error)
  if (isOutOfMemoryError(normalized)) {
    return new Error('This clip is too large to export in this tab. Try exporting fewer or shorter clips at once.')
  }
  return normalized
}

function validateClipRequest(request: ClipBatchRequest): void {
  if (!request.id) {
    throw new Error('Clip request id is required.')
  }
  if (!Number.isFinite(request.startTime) || !Number.isFinite(request.endTime) || request.endTime <= request.startTime) {
    throw new Error('Invalid clip time range.')
  }
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

type AudioOutputEncoder = 'libopus' | 'libmp3lame' | 'pcm'

function conversionArgs(
  file: File,
  inputName: string,
  outputName: string,
  codecInfo: CodecInfo | null = null,
  encoder: AudioOutputEncoder = 'pcm',
): string[] {
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

  if (isTelephonyCodec(codecInfo)) {
    if (encoder === 'libopus') {
      return [
        '-i', inputName,
        '-vn',
        '-sn',
        '-dn',
        '-c:a', 'libopus',
        '-b:a', '32k',
        outputName,
      ]
    }
    if (encoder === 'libmp3lame') {
      return [
        '-i', inputName,
        '-vn',
        '-sn',
        '-dn',
        '-c:a', 'libmp3lame',
        '-b:a', '64k',
        outputName,
      ]
    }
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
  outputName: string
  outputExtension: string
  outputMimeType: string
}

function buildConversionAttempts(
  file: File,
  inputName: string,
  codecInfo: CodecInfo | null,
  encoderSupport: EncoderSupport,
): ConversionAttempt[] {
  const isVideo = isLikelyVideoFile(file)
  const baseOutputExt = isVideo ? 'mp4' : isTelephonyCodec(codecInfo) ? (encoderSupport.libopus ? 'ogg' : 'mp3') : 'wav'
  const baseOutputName = `output.${baseOutputExt}`
  const baseOutputMime = getMimeTypeFromFilename(baseOutputName, file)
  const attempts: ConversionAttempt[] = []

  if (isVideo) {
    attempts.push({
      label: 'default',
      args: conversionArgs(file, inputName, baseOutputName, codecInfo),
      outputName: baseOutputName,
      outputExtension: baseOutputExt,
      outputMimeType: baseOutputMime,
    })
    return attempts
  }

  if (isTelephonyCodec(codecInfo)) {
    if (encoderSupport.libopus) {
      attempts.push({
        label: 'compressed-opus',
        args: conversionArgs(file, inputName, 'output.ogg', codecInfo, 'libopus'),
        outputName: 'output.ogg',
        outputExtension: 'ogg',
        outputMimeType: 'audio/ogg',
      })
    }
    if (encoderSupport.libmp3lame) {
      attempts.push({
        label: 'compressed-mp3',
        args: conversionArgs(file, inputName, 'output.mp3', codecInfo, 'libmp3lame'),
        outputName: 'output.mp3',
        outputExtension: 'mp3',
        outputMimeType: 'audio/mpeg',
      })
    }
  }

  attempts.push({
    label: 'default',
    args: conversionArgs(file, inputName, baseOutputName, codecInfo),
    outputName: baseOutputName,
    outputExtension: baseOutputExt,
    outputMimeType: baseOutputMime,
  })

  if (!isLikelyVideoFile(file) && isLikelyG729Codec(codecInfo)) {
    const g729OutputName = encoderSupport.libopus ? 'output-g729.ogg' : encoderSupport.libmp3lame ? 'output-g729.mp3' : 'output-g729.wav'
    const g729OutputExt = g729OutputName.split('.').pop() || 'wav'
    const g729MimeType = getMimeTypeFromFilename(g729OutputName, file)
    const g729CodecArgs = encoderSupport.libopus
      ? ['-c:a', 'libopus', '-b:a', '32k']
      : encoderSupport.libmp3lame
        ? ['-c:a', 'libmp3lame', '-b:a', '64k']
        : ['-acodec', 'pcm_s16le']

    attempts.push({
      label: 'force-g729-decoder',
      args: [
        '-f', 'wav',
        '-c:a', 'g729',
        '-i', inputName,
        ...g729CodecArgs,
        g729OutputName,
      ],
      outputName: g729OutputName,
      outputExtension: g729OutputExt,
      outputMimeType: g729MimeType,
    })
    attempts.push({
      label: 'force-g729-decoder-mono',
      args: [
        '-f', 'wav',
        '-ac', '1',
        '-c:a', 'g729',
        '-i', inputName,
        ...g729CodecArgs,
        g729OutputName,
      ],
      outputName: g729OutputName,
      outputExtension: g729OutputExt,
      outputMimeType: g729MimeType,
    })
  }

  return attempts
}

function maybeRecycleAfterConversion(slot: FFmpegWorkerSlot, sourceBytes: number): void {
  slot.conversionsSinceReset += 1
  slot.convertedBytesSinceReset += sourceBytes
  if (
    slot.conversionsSinceReset >= RESET_RUNTIME_AFTER_CONVERT_COUNT ||
    slot.convertedBytesSinceReset >= getResetAfterConvertBytes()
  ) {
    slot.reset()
  }
}

function normalizeConversionError(error: Error, sourceCodec: CodecInfo | null): Error {
  if (isOutOfMemoryError(error)) {
    return new Error(
      'This tab ran out of memory while converting. Try converting fewer files at a time and download completed files before continuing.',
    )
  }
  if (isLikelyG729Codec(sourceCodec)) {
    return new Error(
      'This recording format is not supported by the browser converter yet. Please use the desktop converter for this file.',
    )
  }
  if (error.message.toLowerCase().includes('empty output')) {
    return new Error('The converted file came out empty. Please try this file again.')
  }
  if (error.message.toLowerCase().includes('conversion failed')) {
    return new Error('We could not convert this file. Please try again.')
  }
  return error
}

export async function getFFmpeg(): Promise<FFmpeg> {
  const slot = getOrCreateDefaultSlot()
  return slot.getFFmpeg()
}

async function isEncoderSupported(ffmpeg: FFmpeg, encoder: string): Promise<boolean> {
  try {
    const exitCode = await ffmpeg.exec(['-hide_banner', '-h', `encoder=${encoder}`])
    return exitCode === 0
  } catch {
    return false
  }
}

function getEncoderSupport(slot: FFmpegWorkerSlot, ffmpeg: FFmpeg): Promise<EncoderSupport> {
  if (!slot.encoderSupportPromise) {
    slot.encoderSupportPromise = (async () => {
      const [libopus, libmp3lame] = await Promise.all([
        isEncoderSupported(ffmpeg, 'libopus'),
        isEncoderSupported(ffmpeg, 'libmp3lame'),
      ])
      return { libopus, libmp3lame }
    })()
  }
  return slot.encoderSupportPromise
}

export function cancelActiveFFmpegJob(): void {
  if (isTauri()) {
    import('./platform/nativeFFmpeg').then((m) => m.cancelNativeFFmpeg()).catch(() => {})
  }
  for (const slot of pool) {
    slot.terminatedByUser = true
    slot.reset()
    if (slot.cancelReject) {
      slot.cancelReject()
      slot.cancelReject = null
    }
  }
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
  if (isTauri()) {
    const { nativeConvertToPlayable } = await import('./platform/nativeFFmpeg')
    return nativeConvertToPlayable(file, onProgress)
  }
  const slot = await waitForSlot(file)
  try {
    return await slot.runSerial(async () => {
      slot.terminatedByUser = false
      const sourceFile = await maybeRepairWav(file)
      const inputExt = getFileExtension(sourceFile.name) || (isLikelyVideoFile(sourceFile) ? 'mp4' : 'wav')
      const sourceCodec = isLikelyWavFile(sourceFile) ? await parseWavHeader(sourceFile) : null
      const useWorkerFS = sourceFile.size >= WORKERFS_SIZE_THRESHOLD
      const workerFSMount = '/convert-input'
      const workerFSInputPath = `${workerFSMount}/${sourceFile.name}`
      const inputName = `input.${inputExt}`
      const effectiveInput = useWorkerFS ? workerFSInputPath : inputName

      let encoderSupport: EncoderSupport = { libopus: false, libmp3lame: false }

      return withRetryAndReset<File>({
        slot,
        operation: () =>
          runFFmpegOperation({
            slot,
            sourceFile,
            onProgress,
            inputName,
            useWorkerFS,
            workerFSMount,
            workerFSInputPath,
            prepareAttempts: async (ffmpeg) => {
              encoderSupport = await getEncoderSupport(slot, ffmpeg)
            },
            getAttempts: () =>
              buildConversionAttempts(sourceFile, effectiveInput, sourceCodec, encoderSupport),
            outputFilesToClean: [
              'output.wav', 'output.mp4', 'output.ogg', 'output.mp3',
              'output-g729.ogg', 'output-g729.mp3', 'output-g729.wav',
            ],
            buildResultFile: (bytes, attempt) =>
              new File(
                [toBlobBuffer(bytes)],
                getConvertedFilename(file, (attempt as ConversionAttempt).outputExtension),
                {
                  type:
                    (attempt as ConversionAttempt).outputMimeType ||
                    getMimeTypeFromFilename(attempt.outputName, file),
                },
              ),
            normalizeLastError: (error) => normalizeConversionError(error, sourceCodec),
          }),
        onSuccess: () => maybeRecycleAfterConversion(slot, sourceFile.size),
        normalizeLastError: (error) => normalizeConversionError(error, sourceCodec),
      })
    })
  } finally {
    releaseSlot(slot)
  }
}

export async function clipMedia(
  file: File,
  startTime: number,
  endTime: number,
  onProgress?: ProgressCallback,
): Promise<File> {
  if (isTauri()) {
    const { nativeClipMedia } = await import('./platform/nativeFFmpeg')
    return nativeClipMedia(file, startTime, endTime, replaceExtension(file.name, '_clip'), onProgress)
  }
  const requestId = 'clip-single'
  const defaultStem = replaceExtension(file.name, '_clip')
  const outputById = await clipMediaBatch(
    file,
    [{ id: requestId, startTime, endTime, downloadStem: defaultStem }],
    onProgress
      ? (progress) => {
        onProgress(progress.currentRatio)
      }
      : undefined,
  )
  const clipped = outputById.get(requestId)
  if (!clipped) {
    throw new Error('Clip export failed')
  }
  return clipped
}

export async function clipMediaBatch(
  file: File,
  requests: ClipBatchRequest[],
  onProgress?: (progress: ClipBatchProgress) => void,
): Promise<Map<string, File>> {
  const seenIds = new Set<string>()
  const validatedRequests = requests.map((request) => {
    validateClipRequest(request)
    if (seenIds.has(request.id)) {
      throw new Error(`Duplicate clip request id: ${request.id}`)
    }
    seenIds.add(request.id)
    return request
  })

  if (!validatedRequests.length) {
    return new Map<string, File>()
  }

  const slot = await waitForSlot(file)
  try {
  return await slot.runSerial(async () => {
    slot.terminatedByUser = false
    const ffmpeg = await slot.getFFmpeg()
    const sourceFile = await maybeRepairWav(file)
    const inputExt = getFileExtension(sourceFile.name) || (isLikelyVideoFile(sourceFile) ? 'mp4' : 'wav')
    const inputName = `clip-input.${inputExt}`
    const useWorkerFS = sourceFile.size >= WORKERFS_SIZE_THRESHOLD
    const workerFSMount = '/clip-input'
    const workerFSInputPath = `${workerFSMount}/${sourceFile.name}`
    const outputById = new Map<string, File>()
    const total = validatedRequests.length
    let completed = 0
    let mounted = false

    const emitProgress = (currentId: string | null, currentRatio: number) => {
      if (!onProgress) return
      onProgress({
        total,
        completed,
        currentId,
        currentRatio: Math.max(0, Math.min(1, currentRatio)),
      })
    }

    slot.activeProgressCallback = (ratio: number) => {
      const currentRequest = validatedRequests[Math.min(completed, total - 1)]
      emitProgress(currentRequest?.id || null, ratio)
    }

    emitProgress(validatedRequests[0]?.id || null, 0)

    try {
      if (useWorkerFS) {
        await ffmpeg.mount('WORKERFS' as never, { files: [sourceFile] } as never, workerFSMount)
        mounted = true
      } else {
        await ffmpeg.writeFile(inputName, await fetchFile(sourceFile))
      }

      const effectiveInput = useWorkerFS ? workerFSInputPath : inputName

      for (let index = 0; index < validatedRequests.length; index += 1) {
        const request = validatedRequests[index]
        const duration = Math.max(0, request.endTime - request.startTime)
        const copyOutputName = `clip-output-${index}.${inputExt}`
        const fallbackOutputName = isLikelyVideoFile(sourceFile)
          ? `clip-output-${index}.mp4`
          : `clip-output-${index}.wav`

        try {
          emitProgress(request.id, 0)

          let outputName = copyOutputName
          try {
            const copyExit = await ffmpeg.exec([
              '-ss', request.startTime.toString(),
              '-t', duration.toString(),
              '-i', effectiveInput,
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
                '-ss', request.startTime.toString(),
                '-t', duration.toString(),
                '-i', effectiveInput,
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '18',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-avoid_negative_ts', 'make_zero',
                outputName,
              ]
              : [
                '-ss', request.startTime.toString(),
                '-t', duration.toString(),
                '-i', effectiveInput,
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
          if (bytes.byteLength === 0) {
            throw new Error('Clip export produced an empty output file')
          }

          outputById.set(
            request.id,
            new File([toBlobBuffer(bytes)], buildClipOutputFilename(sourceFile, outputName, request), {
              type: getMimeTypeFromFilename(outputName, sourceFile),
            }),
          )

          completed += 1
          emitProgress(request.id, 1)
        } finally {
          await removeVirtualFile(ffmpeg, copyOutputName)
          await removeVirtualFile(ffmpeg, fallbackOutputName)
        }
      }

      emitProgress(null, 1)
      return outputById
    } catch (error) {
      if (slot.terminatedByUser) {
        slot.terminatedByUser = false
        throw new FFmpegCanceledError()
      }
      throw normalizeClipExportError(error)
    } finally {
      slot.activeProgressCallback = null
      if (mounted) {
        try { await ffmpeg.unmount(workerFSMount) } catch { /* ignore unmount errors */ }
      } else {
        await removeVirtualFile(ffmpeg, inputName)
      }
    }
  })
  } finally {
    releaseSlot(slot)
  }
}

export async function extractAudio(
  file: File,
  onProgress?: ProgressCallback,
): Promise<File> {
  if (isTauri()) {
    const { nativeExtractAudio } = await import('./platform/nativeFFmpeg')
    return nativeExtractAudio(file, onProgress)
  }
  const slot = await waitForSlot(file)
  try {
    return await slot.runSerial(async () => {
      slot.terminatedByUser = false
      const sourceFile = await maybeRepairWav(file)
      const inputExt = getFileExtension(sourceFile.name) || (isLikelyVideoFile(sourceFile) ? 'mp4' : 'wav')
      const inputName = `audio-input.${inputExt}`
      const outputName = 'audio-output.mp3'
      const useWorkerFS = sourceFile.size >= WORKERFS_SIZE_THRESHOLD
      const workerFSMount = '/input'
      const workerFSInputPath = `${workerFSMount}/${sourceFile.name}`
      const effectiveInput = useWorkerFS ? workerFSInputPath : inputName

      return withRetryAndReset<File>({
        slot,
        operation: () =>
          runFFmpegOperation({
            slot,
            sourceFile,
            onProgress,
            inputName,
            useWorkerFS,
            workerFSMount,
            workerFSInputPath,
            getAttempts: () => [
              {
                label: 'libmp3lame',
                outputName,
                args: [
                  '-i', effectiveInput,
                  '-map', '0:a:0?',
                  '-vn', '-sn', '-dn',
                  '-ac', '1',
                  '-ar', '16000',
                  '-c:a', 'libmp3lame',
                  '-b:a', '96k',
                  outputName,
                ],
              },
              {
                label: 'default-mp3',
                outputName,
                args: [
                  '-i', effectiveInput,
                  '-map', '0:a:0?',
                  '-vn', '-sn', '-dn',
                  '-ac', '1',
                  '-ar', '16000',
                  '-b:a', '96k',
                  outputName,
                ],
              },
            ],
            outputFilesToClean: [outputName],
            buildResultFile: (bytes) =>
              new File([toBlobBuffer(bytes)], replaceExtension(file.name, '_audio.mp3'), {
                type: 'audio/mpeg',
              }),
          }),
        onSuccess: () => {
          if (sourceFile.size >= getResetAfterExtractBytes()) {
            slot.reset()
          }
        },
        classifyError: (error) => {
          if (isOutOfMemoryError(error)) {
            throw new Error('This file is too large to prepare in this browser tab. Try a shorter file or convert it first.')
          }
        },
      })
    })
  } finally {
    releaseSlot(slot)
  }
}

export async function extractAudioStereo(
  file: File,
  onProgress?: ProgressCallback,
): Promise<File> {
  if (isTauri()) {
    const { nativeExtractAudioStereo } = await import('./platform/nativeFFmpeg')
    return nativeExtractAudioStereo(file, onProgress)
  }
  const slot = await waitForSlot(file)
  try {
    return await slot.runSerial(async () => {
      slot.terminatedByUser = false
      const sourceFile = await maybeRepairWav(file)
      const inputExt = getFileExtension(sourceFile.name) || (isLikelyVideoFile(sourceFile) ? 'mp4' : 'wav')
      const inputName = `audio-stereo-input.${inputExt}`
      const useWorkerFS = sourceFile.size >= WORKERFS_SIZE_THRESHOLD
      const workerFSMount = '/input-stereo'
      const workerFSInputPath = `${workerFSMount}/${sourceFile.name}`
      const effectiveInput = useWorkerFS ? workerFSInputPath : inputName

      let encoderSupport: EncoderSupport = { libopus: false, libmp3lame: false }

      return withRetryAndReset<File>({
        slot,
        operation: () =>
          runFFmpegOperation({
            slot,
            sourceFile,
            onProgress,
            inputName,
            useWorkerFS,
            workerFSMount,
            workerFSInputPath,
            prepareAttempts: async (ffmpeg) => {
              encoderSupport = await getEncoderSupport(slot, ffmpeg)
            },
            getAttempts: () => {
              const attempts: OperationAttempt[] = []
              if (encoderSupport.libopus) {
                attempts.push({
                  label: 'stereo-opus',
                  outputName: 'audio-stereo-output.ogg',
                  outputType: 'audio/ogg',
                  args: [
                    '-i', effectiveInput,
                    '-map', '0:a:0?',
                    '-vn', '-sn', '-dn',
                    '-c:a', 'libopus',
                    '-b:a', '32k',
                    '-ar', '8000',
                    'audio-stereo-output.ogg',
                  ],
                })
              }
              if (encoderSupport.libmp3lame) {
                attempts.push({
                  label: 'stereo-mp3',
                  outputName: 'audio-stereo-output.mp3',
                  outputType: 'audio/mpeg',
                  args: [
                    '-i', effectiveInput,
                    '-map', '0:a:0?',
                    '-vn', '-sn', '-dn',
                    '-c:a', 'libmp3lame',
                    '-b:a', '64k',
                    '-ar', '8000',
                    'audio-stereo-output.mp3',
                  ],
                })
              }
              attempts.push({
                label: 'stereo-pcm-fallback',
                outputName: 'audio-stereo-output.wav',
                outputType: 'audio/wav',
                args: [
                  '-i', effectiveInput,
                  '-map', '0:a:0?',
                  '-vn', '-sn', '-dn',
                  '-acodec', 'pcm_s16le',
                  '-ar', '8000',
                  'audio-stereo-output.wav',
                ],
              })
              return attempts
            },
            outputFilesToClean: [
              'audio-stereo-output.ogg', 'audio-stereo-output.mp3', 'audio-stereo-output.wav',
            ],
            buildResultFile: (bytes, attempt) => {
              const ext = attempt.outputName.split('.').pop() || 'ogg'
              return new File(
                [toBlobBuffer(bytes)],
                replaceExtension(file.name, `_audio_stereo.${ext}`),
                { type: (attempt.outputType as string) || 'audio/ogg' },
              )
            },
          }),
        onSuccess: () => {
          if (sourceFile.size >= getResetAfterExtractBytes()) {
            slot.reset()
          }
        },
        classifyError: (error) => {
          if (isOutOfMemoryError(error)) {
            throw new Error('This file is too large to prepare in this browser tab. Try a shorter file or convert it first.')
          }
        },
      })
    })
  } finally {
    releaseSlot(slot)
  }
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
    return (await idbGet<FileSystemDirectoryHandle>('workspace', WORKSPACE_IDB_KEY)) ?? null
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

  for await (const [name, handle] of cacheDir.entries()) {
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

async function getCodecForCacheDecisions(file: File): Promise<CodecInfo | null> {
  if (!isLikelyWavFile(file)) return null
  try {
    return await parseWavHeader(file)
  } catch {
    return null
  }
}

export async function getConvertedCachePath(file: File, extensionOverride?: string): Promise<string> {
  const codecInfo = await getCodecForCacheDecisions(file)
  const extension = extensionOverride || getConvertedExtension(file, codecInfo)
  const key = await cacheKey(file)
  return `${CACHE_DIR}/${key}.${extension}`
}

export async function readConvertedFromCache(file: File): Promise<File | null> {
  const codecInfo = await getCodecForCacheDecisions(file)
  const primaryExtension = getConvertedExtension(file, codecInfo)
  const candidateExtensions = Array.from(
    new Set(
      isTelephonyCodec(codecInfo)
        ? [primaryExtension, 'ogg', 'mp3', 'wav']
        : [primaryExtension],
    ),
  )

  for (const extension of candidateExtensions) {
    const path = await getConvertedCachePath(file, extension)
    const bytes = await readBinaryFile(path)
    if (!bytes) continue

    const filename = getConvertedFilename(file, extension)
    const contentType = getMimeTypeFromFilename(filename, file)
    return new File([bytes], filename, {
      type: contentType,
      lastModified: Date.now(),
    })
  }
  return null
}

export async function writeConvertedToCache(originalFile: File, convertedFile: File): Promise<void> {
  const extension = getFileExtension(convertedFile.name) || 'wav'
  const path = await getConvertedCachePath(originalFile, extension)
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
