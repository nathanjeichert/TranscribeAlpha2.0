import { openDB } from './idb'

const HANDLE_STORE = 'media-handles'
const BLOB_STORE = 'media-blobs'

interface StoredMediaBlobRecord {
  blob: Blob
  filename: string
  contentType: string
  saved_at: string
}

export async function storeMediaHandle(
  handleId: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    const store = tx.objectStore(HANDLE_STORE)
    const request = store.put(handle, handleId)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function storeMediaBlob(
  sourceId: string,
  media: File | Blob,
  filename?: string,
  contentType?: string,
): Promise<void> {
  const db = await openDB()
  const record: StoredMediaBlobRecord = {
    blob: media,
    filename: filename || ((media instanceof File && media.name) ? media.name : `${sourceId}.bin`),
    contentType: contentType || media.type || 'application/octet-stream',
    saved_at: new Date().toISOString(),
  }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, 'readwrite')
    const store = tx.objectStore(BLOB_STORE)
    const request = store.put(record, sourceId)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function getMediaHandle(
  handleId: string,
): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDB()
    const handle: FileSystemFileHandle | undefined = await new Promise(
      (resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, 'readonly')
        const store = tx.objectStore(HANDLE_STORE)
        const request = store.get(handleId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      },
    )

    if (!handle) return null

    // Request read permission
    const permission = await (handle as any).requestPermission({ mode: 'read' })
    if (permission !== 'granted') return null

    return handle
  } catch {
    return null
  }
}

export async function getMediaBlob(sourceId: string): Promise<File | null> {
  try {
    const db = await openDB()
    const record: StoredMediaBlobRecord | undefined = await new Promise(
      (resolve, reject) => {
        const tx = db.transaction(BLOB_STORE, 'readonly')
        const store = tx.objectStore(BLOB_STORE)
        const request = store.get(sourceId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      },
    )

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
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      const store = tx.objectStore(HANDLE_STORE)
      const request = store.delete(handleId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch {
    // Ignore errors
  }
}

export async function removeMediaBlob(sourceId: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE, 'readwrite')
      const store = tx.objectStore(BLOB_STORE)
      const request = store.delete(sourceId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch {
    // Ignore errors
  }
}

export async function getMediaFile(sourceId: string): Promise<File | null> {
  // Prefer stored playable blob when available (e.g., converted media fallback).
  const blobMedia = await getMediaBlob(sourceId)
  if (blobMedia) return blobMedia

  const handle = await getMediaHandle(sourceId)
  if (!handle) return null
  try {
    return await handle.getFile()
  } catch {
    return null
  }
}

export async function getMediaObjectURL(sourceId: string): Promise<string | null> {
  const file = await getMediaFile(sourceId)
  if (!file) return null
  return URL.createObjectURL(file)
}

export async function promptRelinkMedia(
  expectedFilename: string,
): Promise<{
  handle: FileSystemFileHandle
  handleId: string
} | null> {
  try {
    const [handle] = await (window as any).showOpenFilePicker({
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

    const handleId = crypto.randomUUID()
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
    const [handle] = await (window as any).showOpenFilePicker({
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
