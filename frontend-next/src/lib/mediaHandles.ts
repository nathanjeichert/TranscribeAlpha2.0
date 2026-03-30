import { idbGet, idbPut, idbDelete } from './idb'
import { getPlatformMedia } from './platform'

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

/** Read a file from a stored path via the platform media adapter. */
async function readFileFromTauriPath(record: TauriPathRecord): Promise<File | null> {
  try {
    const media = await getPlatformMedia()
    return await media.readFileFromPath(record.__tauriPath, record.filename)
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
 * Try to get a direct playback URL (Tauri: streams from disk, Web: returns null).
 */
export async function getMediaPlaybackURL(sourceId: string): Promise<string | null> {
  try {
    const media = await getPlatformMedia()
    return await media.getPlaybackURL(sourceId)
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

export async function promptRelinkMedia(
  expectedFilename: string,
  preferredHandleId?: string,
): Promise<{
  handleId: string
} | null> {
  try {
    const media = await getPlatformMedia()
    return await media.promptRelinkMedia(expectedFilename, preferredHandleId)
  } catch {
    return null
  }
}
