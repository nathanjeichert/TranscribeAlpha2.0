import { idbGet, idbPut, idbDelete } from './idb'
import { isTauri } from './platform'

const HANDLE_STORE = 'media-handles'
const BLOB_STORE = 'media-blobs'

interface StoredMediaBlobRecord {
  blob: Blob
  filename: string
  contentType: string
  saved_at: string
}

/** Tagged object stored in IDB in Tauri mode (file paths instead of FileSystemFileHandles). */
interface TauriPathRecord {
  __tauriPath: string
  filename: string
}

function isTauriPathRecord(value: unknown): value is TauriPathRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__tauriPath' in value &&
    typeof (value as TauriPathRecord).__tauriPath === 'string'
  )
}

interface MediaAccessOptions {
  requestPermission?: boolean
}

export type MediaHandlePermissionState = 'missing' | 'granted' | 'prompt' | 'denied'

// ─── Raw IDB helper ──────────────────────────────────────────────────────────

async function getRawMediaRef(handleId: string): Promise<unknown | undefined> {
  return idbGet<unknown>(HANDLE_STORE, handleId)
}

// ─── Store / retrieve media references ───────────────────────────────────────

export async function storeMediaHandle(
  handleId: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  await idbPut(HANDLE_STORE, handleId, handle)
}

/** Store a native file path (Tauri only) as a media reference. */
export async function storeMediaPath(
  handleId: string,
  filePath: string,
  filename: string,
): Promise<void> {
  const record: TauriPathRecord = { __tauriPath: filePath, filename }
  await idbPut(HANDLE_STORE, handleId, record)
}

export async function storeMediaBlob(
  sourceId: string,
  media: File | Blob,
  filename?: string,
  contentType?: string,
): Promise<void> {
  const record: StoredMediaBlobRecord = {
    blob: media,
    filename: filename || ((media instanceof File && media.name) ? media.name : `${sourceId}.bin`),
    contentType: contentType || media.type || 'application/octet-stream',
    saved_at: new Date().toISOString(),
  }
  await idbPut(BLOB_STORE, sourceId, record)
}

export async function getMediaHandle(
  handleId: string,
  options?: MediaAccessOptions,
): Promise<FileSystemFileHandle | null> {
  try {
    const ref = await getRawMediaRef(handleId)
    if (!ref) return null

    // In Tauri mode, we store paths — not handles. Return null for the handle API.
    if (isTauriPathRecord(ref)) return null

    const handle = ref as FileSystemFileHandle
    const shouldRequestPermission = Boolean(options?.requestPermission)
    let permission: PermissionState | string = 'prompt'
    try {
      permission = await handle.queryPermission({ mode: 'read' })
    } catch {
      // queryPermission may not be supported in all environments.
    }

    if (permission !== 'granted' && shouldRequestPermission) {
      try {
        permission = await handle.requestPermission({ mode: 'read' })
      } catch {
        return null
      }
    }

    if (permission !== 'granted') return null

    return handle
  } catch {
    return null
  }
}

export async function getMediaHandlePermissionState(handleId: string): Promise<MediaHandlePermissionState> {
  try {
    const ref = await getRawMediaRef(handleId)
    if (!ref) return 'missing'

    // Tauri: native FS has no permission model — always granted.
    if (isTauriPathRecord(ref)) return 'granted'

    const handle = ref as FileSystemFileHandle
    try {
      const permission = await handle.queryPermission({ mode: 'read' })
      if (permission === 'granted') return 'granted'
      if (permission === 'denied') return 'denied'
      return 'prompt'
    } catch {
      return 'prompt'
    }
  } catch {
    return 'missing'
  }
}

export async function getMediaBlob(sourceId: string): Promise<File | null> {
  try {
    const record = await idbGet<StoredMediaBlobRecord>(BLOB_STORE, sourceId)
    if (!record || !(record.blob instanceof Blob)) return null

    const name = record.filename || `${sourceId}.bin`
    const type = record.contentType || record.blob.type || 'application/octet-stream'
    return new File([record.blob], name, { type })
  } catch {
    return null
  }
}

export async function removeMediaHandle(handleId: string): Promise<void> {
  try {
    await idbDelete(HANDLE_STORE, handleId)
  } catch {
    // Ignore errors
  }
}

export async function removeMediaBlob(sourceId: string): Promise<void> {
  try {
    await idbDelete(BLOB_STORE, sourceId)
  } catch {
    // Ignore errors
  }
}

/** Read a file from a Tauri stored path via plugin-fs. */
async function readFileFromTauriPath(record: TauriPathRecord): Promise<File | null> {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const bytes = await readFile(record.__tauriPath)
    const ext = record.filename.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
      wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
      ogg: 'audio/ogg', aac: 'audio/aac', wma: 'audio/x-ms-wma', webm: 'video/webm',
    }
    const type = mimeMap[ext] || 'application/octet-stream'
    return new File([bytes], record.filename, { type })
  } catch {
    return null
  }
}

export async function getMediaFile(
  sourceId: string,
  options?: MediaAccessOptions,
): Promise<File | null> {
  // Prefer stored playable blob when available (e.g., converted media fallback).
  const blobMedia = await getMediaBlob(sourceId)
  if (blobMedia) return blobMedia

  // Tauri: try reading from stored native path.
  try {
    const ref = await getRawMediaRef(sourceId)
    if (ref && isTauriPathRecord(ref)) {
      return await readFileFromTauriPath(ref)
    }
  } catch {
    // Fall through to handle-based lookup.
  }

  const handle = await getMediaHandle(sourceId, options)
  if (!handle) return null
  try {
    return await handle.getFile()
  } catch {
    return null
  }
}

/**
 * In Tauri mode, try to get a direct playback URL via convertFileSrc
 * (streams from disk — no JS memory copy).
 */
export async function getMediaPlaybackURL(sourceId: string): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const ref = await getRawMediaRef(sourceId)
    if (!ref || !isTauriPathRecord(ref)) return null
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(ref.__tauriPath)
  } catch {
    return null
  }
}

export async function getFirstAvailableMediaFile(
  sourceIds: Array<string | null | undefined>,
  options?: MediaAccessOptions,
): Promise<{ sourceId: string; file: File } | null> {
  const seen = new Set<string>()
  for (const rawSourceId of sourceIds) {
    const sourceId = String(rawSourceId || '').trim()
    if (!sourceId || seen.has(sourceId)) continue
    seen.add(sourceId)
    const file = await getMediaFile(sourceId, options)
    if (file) {
      return { sourceId, file }
    }
  }
  return null
}

export async function getMediaObjectURL(
  sourceId: string,
  options?: MediaAccessOptions,
): Promise<string | null> {
  // In Tauri, prefer convertFileSrc for direct streaming without memory copy.
  const tauriUrl = await getMediaPlaybackURL(sourceId)
  if (tauriUrl) return tauriUrl

  const file = await getMediaFile(sourceId, options)
  if (!file) return null
  return URL.createObjectURL(file)
}

export async function getFirstAvailableMediaObjectURL(
  sourceIds: Array<string | null | undefined>,
  options?: MediaAccessOptions,
): Promise<{ sourceId: string; objectUrl: string } | null> {
  const seen = new Set<string>()
  for (const rawSourceId of sourceIds) {
    const sourceId = String(rawSourceId || '').trim()
    if (!sourceId || seen.has(sourceId)) continue
    seen.add(sourceId)
    const objectUrl = await getMediaObjectURL(sourceId, options)
    if (objectUrl) {
      return { sourceId, objectUrl }
    }
  }
  return null
}

export async function promptRelinkMedia(
  expectedFilename: string,
  preferredHandleId?: string,
): Promise<{
  handle: FileSystemFileHandle
  handleId: string
} | null> {
  if (isTauri()) {
    return promptRelinkMediaTauri(expectedFilename, preferredHandleId)
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      types: [
        {
          description: `Locate: ${expectedFilename}`,
          accept: {
            'audio/*': [],
            'video/*': [],
          },
        },
      ],
      multiple: false,
    })

    if (!handle) return null

    const handleId = String(preferredHandleId || '').trim() || crypto.randomUUID()
    await storeMediaHandle(handleId, handle)
    return { handle, handleId }
  } catch {
    // User cancelled or API not available
    return null
  }
}

async function promptRelinkMediaTauri(
  expectedFilename: string,
  preferredHandleId?: string,
): Promise<any> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      title: `Locate: ${expectedFilename}`,
      filters: [
        { name: 'Audio/Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'webm'] },
      ],
      multiple: false,
    })
    if (!selected) return null
    const filePath = typeof selected === 'string' ? selected : (selected as any).path ?? String(selected)
    const filename = filePath.split(/[\\/]/).pop() || expectedFilename
    const handleId = String(preferredHandleId || '').trim() || crypto.randomUUID()
    await storeMediaPath(handleId, filePath, filename)
    return { handle: null, handleId }
  } catch {
    return null
  }
}

export async function storeMediaFromPicker(): Promise<{
  handle: FileSystemFileHandle
  handleId: string
  filename: string
  contentType: string
} | null> {
  if (isTauri()) {
    return storeMediaFromPickerTauri()
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      types: [
        {
          description: 'Audio or video files',
          accept: {
            'audio/*': [],
            'video/*': [],
          },
        },
      ],
      multiple: false,
    })

    if (!handle) return null

    const file = await handle.getFile()
    const handleId = crypto.randomUUID()
    await storeMediaHandle(handleId, handle)

    return {
      handle,
      handleId,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
    }
  } catch {
    // User cancelled or API not available
    return null
  }
}

async function storeMediaFromPickerTauri(): Promise<any> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      title: 'Choose audio or video file',
      filters: [
        { name: 'Audio/Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'webm'] },
      ],
      multiple: false,
    })
    if (!selected) return null
    const filePath = typeof selected === 'string' ? selected : (selected as any).path ?? String(selected)
    const filename = filePath.split(/[\\/]/).pop() || 'media.bin'
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
      wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
      ogg: 'audio/ogg', aac: 'audio/aac', wma: 'audio/x-ms-wma', webm: 'video/webm',
    }
    const contentType = mimeMap[ext] || 'application/octet-stream'
    const handleId = crypto.randomUUID()
    await storeMediaPath(handleId, filePath, filename)
    return { handle: null, handleId, filename, contentType }
  } catch {
    return null
  }
}

/**
 * Pick one or more media files using the Tauri dialog plugin.
 * Returns file objects + stored paths. Used by the transcribe page in Tauri mode.
 */
export async function pickMediaFilesTauri(): Promise<
  Array<{ file: File; filePath: string; handleId: string; filename: string }>
> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const selected = await open({
      title: 'Choose audio or video files',
      filters: [
        { name: 'Audio/Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'webm'] },
      ],
      multiple: true,
    })
    if (!selected) return []

    const paths = Array.isArray(selected) ? selected : [selected]
    const results: Array<{ file: File; filePath: string; handleId: string; filename: string }> = []

    for (const raw of paths) {
      const filePath = typeof raw === 'string' ? raw : (raw as any).path ?? String(raw)
      const filename = filePath.split(/[\\/]/).pop() || 'media.bin'
      const ext = filename.split('.').pop()?.toLowerCase() || ''
      const mimeMap: Record<string, string> = {
        mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
        wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
        ogg: 'audio/ogg', aac: 'audio/aac', wma: 'audio/x-ms-wma', webm: 'video/webm',
      }
      const contentType = mimeMap[ext] || 'application/octet-stream'
      const handleId = crypto.randomUUID()

      // Read file content for immediate use (e.g., codec detection, upload)
      const bytes = await readFile(filePath)
      const file = new File([bytes], filename, { type: contentType })

      await storeMediaPath(handleId, filePath, filename)
      results.push({ file, filePath, handleId, filename })
    }

    return results
  } catch {
    return []
  }
}
