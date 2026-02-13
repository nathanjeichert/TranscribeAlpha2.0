import {
  deleteFile,
  getMediaCacheCapBytes,
  readJSON,
  writeBinaryFile,
  writeJSON,
} from './storage'

const MEDIA_CACHE_INDEX_PATH = 'cache/playback/index.json'
const MEDIA_CACHE_VERSION = 1

export interface MediaCacheEntry {
  media_key: string
  path: string
  size_bytes: number
  content_type: string
  created_at: string
  last_used_at: string
}

interface MediaCacheIndex {
  version: number
  updated_at: string
  entries: Record<string, MediaCacheEntry>
}

let indexMutationQueue: Promise<void> = Promise.resolve()

function nowIso(): string {
  return new Date().toISOString()
}

function getSafeFilenameExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function extensionFromMimeType(contentType: string): string {
  const normalized = (contentType || '').toLowerCase()
  if (normalized === 'audio/mpeg') return 'mp3'
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav'
  if (normalized === 'audio/mp4') return 'm4a'
  if (normalized === 'audio/ogg') return 'ogg'
  if (normalized === 'video/mp4') return 'mp4'
  if (normalized === 'video/quicktime') return 'mov'
  if (normalized === 'video/x-msvideo') return 'avi'
  if (normalized === 'video/x-matroska') return 'mkv'
  return ''
}

function chooseCacheExtension(filename: string, contentType: string): string {
  return getSafeFilenameExtension(filename) || extensionFromMimeType(contentType) || 'bin'
}

function normalizeIndex(raw: unknown): MediaCacheIndex {
  const record = (raw || {}) as Record<string, unknown>
  const rawEntries = (record.entries || {}) as Record<string, unknown>
  const entries: Record<string, MediaCacheEntry> = {}

  for (const [mediaKey, value] of Object.entries(rawEntries)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (!path) continue
    const sizeBytes = Number(entry.size_bytes)
    entries[mediaKey] = {
      media_key: typeof entry.media_key === 'string' && entry.media_key.trim()
        ? entry.media_key
        : mediaKey,
      path,
      size_bytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.floor(sizeBytes) : 0,
      content_type: typeof entry.content_type === 'string' && entry.content_type.trim()
        ? entry.content_type
        : 'application/octet-stream',
      created_at: typeof entry.created_at === 'string' && entry.created_at.trim()
        ? entry.created_at
        : nowIso(),
      last_used_at: typeof entry.last_used_at === 'string' && entry.last_used_at.trim()
        ? entry.last_used_at
        : nowIso(),
    }
  }

  return {
    version: MEDIA_CACHE_VERSION,
    updated_at: typeof record.updated_at === 'string' && record.updated_at.trim()
      ? record.updated_at
      : nowIso(),
    entries,
  }
}

async function readCacheIndex(): Promise<MediaCacheIndex> {
  const raw = await readJSON<MediaCacheIndex>(MEDIA_CACHE_INDEX_PATH)
  return normalizeIndex(raw)
}

async function writeCacheIndex(index: MediaCacheIndex): Promise<void> {
  const payload: MediaCacheIndex = {
    ...index,
    version: MEDIA_CACHE_VERSION,
    updated_at: nowIso(),
  }
  await writeJSON(MEDIA_CACHE_INDEX_PATH, payload)
}

async function withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = indexMutationQueue
  let release!: () => void
  indexMutationQueue = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

export async function getMediaCacheEntry(mediaKey: string): Promise<MediaCacheEntry | null> {
  const normalizedKey = String(mediaKey || '').trim()
  if (!normalizedKey) return null
  const index = await readCacheIndex()
  return index.entries[normalizedKey] || null
}

export async function touchMediaCacheEntry(mediaKey: string): Promise<void> {
  const normalizedKey = String(mediaKey || '').trim()
  if (!normalizedKey) return
  await withIndexLock(async () => {
    const index = await readCacheIndex()
    const existing = index.entries[normalizedKey]
    if (!existing) return
    index.entries[normalizedKey] = {
      ...existing,
      last_used_at: nowIso(),
    }
    await writeCacheIndex(index)
  })
}

export async function removeMediaCacheEntry(mediaKey: string): Promise<void> {
  const normalizedKey = String(mediaKey || '').trim()
  if (!normalizedKey) return
  await withIndexLock(async () => {
    const index = await readCacheIndex()
    const existing = index.entries[normalizedKey]
    if (!existing) return

    try {
      await deleteFile(existing.path)
    } catch {
      // File may already be gone.
    }

    delete index.entries[normalizedKey]
    await writeCacheIndex(index)
  })
}

async function evictMediaCacheToCapInPlace(
  index: MediaCacheIndex,
  options?: {
    capBytes?: number
    preserveMediaKeys?: string[]
  },
): Promise<void> {
  const preserve = new Set(
    (options?.preserveMediaKeys || [])
      .map((key) => String(key || '').trim())
      .filter(Boolean),
  )
  const capBytes = Number.isFinite(Number(options?.capBytes))
    ? Math.max(0, Math.floor(Number(options?.capBytes)))
    : await getMediaCacheCapBytes()

  const entries = Object.entries(index.entries)
  let totalBytes = entries.reduce((sum, [, entry]) => sum + Math.max(0, Number(entry.size_bytes || 0)), 0)
  if (totalBytes <= capBytes) return

  const evictionQueue = entries
    .filter(([mediaKey]) => !preserve.has(mediaKey))
    .sort((a, b) => {
      const parsedA = Date.parse(a[1].last_used_at || a[1].created_at || '')
      const parsedB = Date.parse(b[1].last_used_at || b[1].created_at || '')
      const aTime = Number.isFinite(parsedA) ? parsedA : 0
      const bTime = Number.isFinite(parsedB) ? parsedB : 0
      return aTime - bTime
    })

  for (const [mediaKey, entry] of evictionQueue) {
    if (totalBytes <= capBytes) break
    try {
      await deleteFile(entry.path)
    } catch {
      // Ignore individual file deletion errors during eviction.
    }
    totalBytes -= Math.max(0, Number(entry.size_bytes || 0))
    delete index.entries[mediaKey]
  }
}

export async function evictMediaCacheToCap(options?: {
  capBytes?: number
  preserveMediaKeys?: string[]
}): Promise<void> {
  await withIndexLock(async () => {
    const index = await readCacheIndex()
    await evictMediaCacheToCapInPlace(index, options)
    await writeCacheIndex(index)
  })
}

export async function cacheMediaForPlayback(
  mediaKey: string,
  file: File | Blob,
  options?: { filename?: string; contentType?: string; preserveMediaKeys?: string[] },
): Promise<{ path: string; contentType: string }> {
  const normalizedKey = String(mediaKey || '').trim()
  if (!normalizedKey) {
    throw new Error('Missing media key for playback cache')
  }

  const filename = options?.filename || (file instanceof File ? file.name : `${normalizedKey}.bin`)
  const resolvedContentType = options?.contentType || file.type || 'application/octet-stream'
  const ext = chooseCacheExtension(filename, resolvedContentType)
  const cachePath = `cache/playback/${normalizedKey}.${ext}`
  await withIndexLock(async () => {
    await writeBinaryFile(cachePath, file)

    const index = await readCacheIndex()
    const existing = index.entries[normalizedKey]
    if (existing && existing.path !== cachePath) {
      try {
        await deleteFile(existing.path)
      } catch {
        // Previous cache payload may have already been deleted.
      }
    }

    const timestamp = nowIso()
    index.entries[normalizedKey] = {
      media_key: normalizedKey,
      path: cachePath,
      size_bytes: file.size,
      content_type: resolvedContentType,
      created_at: existing?.created_at || timestamp,
      last_used_at: timestamp,
    }

    await evictMediaCacheToCapInPlace(index, {
      preserveMediaKeys: [normalizedKey, ...(options?.preserveMediaKeys || [])],
    })
    await writeCacheIndex(index)
  })

  return {
    path: cachePath,
    contentType: resolvedContentType,
  }
}
