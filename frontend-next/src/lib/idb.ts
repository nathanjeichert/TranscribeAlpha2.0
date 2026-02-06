const DB_NAME = 'transcribealpha'
const DB_VERSION = 2

let dbPromise: Promise<IDBDatabase> | null = null

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('workspace')) {
        db.createObjectStore('workspace')
      }
      if (!db.objectStoreNames.contains('media-handles')) {
        db.createObjectStore('media-handles')
      }
      if (!db.objectStoreNames.contains('media-blobs')) {
        db.createObjectStore('media-blobs')
      }
    }

    request.onsuccess = () => resolve(request.result)

    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })

  return dbPromise
}
