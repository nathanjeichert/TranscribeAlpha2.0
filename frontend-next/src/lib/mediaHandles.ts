import { idbGet, idbPut, idbDelete } from './idb'

const HANDLE_STORE = 'media-handles'
const BLOB_STORE = 'media-blobs'

interface StoredMediaBlobRecord {
  blob: Blob
  filename: string
  contentType: string
  saved_at: string
}

interface MediaAccessOptions {
  requestPermission?: boolean
}

export type MediaHandlePermissionState = 'missing' | 'granted' | 'prompt' | 'denied'

export async function storeMediaHandle(
  handleId: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  await idbPut(HANDLE_STORE, handleId, handle)
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
    const handle = await idbGet<FileSystemFileHandle>(HANDLE_STORE, handleId)
    if (!handle) return null

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
    const handle = await idbGet<FileSystemFileHandle>(HANDLE_STORE, handleId)
    if (!handle) return 'missing'

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

export async function getMediaFile(
  sourceId: string,
  options?: MediaAccessOptions,
): Promise<File | null> {
  // Prefer stored playable blob when available (e.g., converted media fallback).
  const blobMedia = await getMediaBlob(sourceId)
  if (blobMedia) return blobMedia

  const handle = await getMediaHandle(sourceId, options)
  if (!handle) return null
  try {
    return await handle.getFile()
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

export async function storeMediaFromPicker(): Promise<{
  handle: FileSystemFileHandle
  handleId: string
  filename: string
  contentType: string
} | null> {
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
