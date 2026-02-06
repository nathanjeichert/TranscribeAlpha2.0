import { openDB } from './idb'

const IDB_STORE = 'media-handles'

export async function storeMediaHandle(
  handleId: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    const store = tx.objectStore(IDB_STORE)
    const request = store.put(handle, handleId)
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
        const tx = db.transaction(IDB_STORE, 'readonly')
        const store = tx.objectStore(IDB_STORE)
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

export async function removeMediaHandle(handleId: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      const store = tx.objectStore(IDB_STORE)
      const request = store.delete(handleId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch {
    // Ignore errors
  }
}

export async function getMediaFile(handleId: string): Promise<File | null> {
  const handle = await getMediaHandle(handleId)
  if (!handle) return null
  try {
    return await handle.getFile()
  } catch {
    return null
  }
}

export async function getMediaObjectURL(handleId: string): Promise<string | null> {
  const file = await getMediaFile(handleId)
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
