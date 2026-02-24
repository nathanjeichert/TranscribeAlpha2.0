// ─── Web File System Access API Adapter ──────────────────────────────
//
// This is the existing storage.ts low-level code, extracted into the
// PlatformFS interface. No logic changes — just reorganized.

import { openDB } from '../idb'
import type { PlatformFS, WorkspaceInitResult } from './types'

const IDB_KEY_WORKSPACE = 'workspace-dir-handle'
const CONFIG_FILENAME = 'config.json'

let workspaceHandle: FileSystemDirectoryHandle | null = null

// ─── Internal Helpers ───────────────────────────────────────────────

async function navigateToDir(
  root: FileSystemDirectoryHandle,
  pathParts: string[],
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const part of pathParts) {
    if (!part) continue
    current = await current.getDirectoryHandle(part, { create })
  }
  return current
}

async function writeJSONToHandle(
  dir: FileSystemDirectoryHandle,
  filename: string,
  data: unknown,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(data, null, 2))
  await writable.close()
}

function requireHandle(): FileSystemDirectoryHandle {
  if (!workspaceHandle) {
    throw new Error('Workspace not initialized. Call initWorkspace() first.')
  }
  return workspaceHandle
}

async function ensureWorkspaceStructure(root: FileSystemDirectoryHandle): Promise<void> {
  await root.getDirectoryHandle('cases', { create: true })
  await root.getDirectoryHandle('uncategorized', { create: true })
  const cache = await root.getDirectoryHandle('cache', { create: true })
  await cache.getDirectoryHandle('converted', { create: true })
  await cache.getDirectoryHandle('playback', { create: true })
}

// ─── Default config helpers (needed for pickWorkspaceDirectory) ─────

function buildDefaultConfig() {
  const now = new Date().toISOString()
  return {
    version: 2,
    created_at: now,
    updated_at: now,
    preferences: {
      lines_per_page: 25,
      auto_save_interval_seconds: 60,
      default_transcription_model: 'assemblyai',
      media_cache_cap_bytes: 10 * 1024 * 1024 * 1024,
    },
  }
}

// ─── PlatformFS Implementation ──────────────────────────────────────

export const webFSAdapter: PlatformFS = {
  async pickWorkspaceDirectory(): Promise<{ isExisting: boolean }> {
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })

    let isExisting = false
    try {
      await handle.getFileHandle(CONFIG_FILENAME)
      isExisting = true
    } catch {
      // New workspace
    }

    if (!isExisting) {
      await ensureWorkspaceStructure(handle)
      await writeJSONToHandle(handle, CONFIG_FILENAME, buildDefaultConfig())
    }

    // Store handle in IndexedDB
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite')
      const store = tx.objectStore('workspace')
      const request = store.put(handle, IDB_KEY_WORKSPACE)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })

    // Request persistent storage (runs in user-gesture context from folder picker)
    try {
      if (navigator.storage?.persist) {
        await navigator.storage.persist()
      }
    } catch {
      // Non-critical
    }

    workspaceHandle = handle
    return { isExisting }
  },

  async initWorkspace(): Promise<WorkspaceInitResult> {
    try {
      const db = await openDB()
      const handle: FileSystemDirectoryHandle | undefined = await new Promise((resolve, reject) => {
        const tx = db.transaction('workspace', 'readonly')
        const store = tx.objectStore('workspace')
        const request = store.get(IDB_KEY_WORKSPACE)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      if (!handle) {
        return { status: 'no-handle', handle: null }
      }

      // Try queryPermission first (works without user gesture)
      let permission: PermissionState | string = 'prompt'
      try {
        permission = await (handle as any).queryPermission({ mode: 'readwrite' })
      } catch {
        // queryPermission may not be available in all browsers
      }

      if (permission === 'granted') {
        await ensureWorkspaceStructure(handle)
        workspaceHandle = handle
        return { status: 'ok', handle }
      }

      // Fall back to requestPermission (needs user gesture to succeed)
      try {
        permission = await (handle as any).requestPermission({ mode: 'readwrite' })
      } catch {
        return { status: 'permission-prompt', handle: null }
      }

      if (permission === 'granted') {
        await ensureWorkspaceStructure(handle)
        workspaceHandle = handle
        return { status: 'ok', handle }
      }

      if (permission === 'denied') {
        return { status: 'permission-denied', handle: null }
      }

      return { status: 'permission-prompt', handle: null }
    } catch (err) {
      console.warn('[webFS] initWorkspace error:', err)
      return { status: 'error', handle: null }
    }
  },

  async isWorkspaceConfigured(): Promise<boolean> {
    try {
      const db = await openDB()
      return new Promise((resolve) => {
        const tx = db.transaction('workspace', 'readonly')
        const store = tx.objectStore('workspace')
        const request = store.get(IDB_KEY_WORKSPACE)
        request.onsuccess = () => resolve(!!request.result)
        request.onerror = () => resolve(false)
      })
    } catch {
      return false
    }
  },

  async clearWorkspace(): Promise<void> {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite')
      const store = tx.objectStore('workspace')
      const request = store.delete(IDB_KEY_WORKSPACE)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    workspaceHandle = null
  },

  getWorkspaceName(): string | null {
    return workspaceHandle?.name ?? null
  },

  async getStorageEstimate(): Promise<{ fileCount: number; totalSize: number }> {
    let fileCount = 0
    let totalSize = 0

    async function walk(dir: FileSystemDirectoryHandle) {
      for await (const entry of (dir as any).values()) {
        if (entry.kind === 'file') {
          fileCount++
          try {
            const file = await (entry as FileSystemFileHandle).getFile()
            totalSize += file.size
          } catch {
            // Skip inaccessible files
          }
        } else if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle)
        }
      }
    }

    if (workspaceHandle) {
      await walk(workspaceHandle)
    }

    return { fileCount, totalSize }
  },

  // ─── Low-Level File I/O ─────────────────────────────────────────

  async readJSON<T>(path: string): Promise<T | null> {
    try {
      const root = requireHandle()
      const parts = path.split('/')
      const filename = parts.pop()!
      const dir = await navigateToDir(root, parts)
      const fileHandle = await dir.getFileHandle(filename)
      const file = await fileHandle.getFile()
      const text = await file.text()
      return JSON.parse(text) as T
    } catch {
      return null
    }
  },

  async writeJSON(path: string, data: unknown): Promise<void> {
    const root = requireHandle()
    const parts = path.split('/')
    const filename = parts.pop()!
    const dir = await navigateToDir(root, parts, true)
    await writeJSONToHandle(dir, filename, data)
  },

  async readBinaryFile(path: string): Promise<ArrayBuffer | null> {
    try {
      const root = requireHandle()
      const parts = path.split('/')
      const filename = parts.pop()!
      const dir = await navigateToDir(root, parts)
      const fileHandle = await dir.getFileHandle(filename)
      const file = await fileHandle.getFile()
      return await file.arrayBuffer()
    } catch {
      return null
    }
  },

  async writeBinaryFile(path: string, data: ArrayBuffer | Uint8Array | Blob): Promise<void> {
    const root = requireHandle()
    const parts = path.split('/')
    const filename = parts.pop()!
    const dir = await navigateToDir(root, parts, true)
    const fileHandle = await dir.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    let payload: ArrayBuffer | Blob
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(data.byteLength)
      copy.set(data)
      payload = copy.buffer
    } else {
      payload = data
    }
    await writable.write(payload)
    await writable.close()
  },

  async deleteFile(path: string): Promise<void> {
    try {
      const root = requireHandle()
      const parts = path.split('/')
      const filename = parts.pop()!
      const dir = await navigateToDir(root, parts)
      await dir.removeEntry(filename)
    } catch (err: any) {
      if (err?.name !== 'NotFoundError') throw err
    }
  },

  async deleteDirectory(path: string): Promise<void> {
    try {
      const root = requireHandle()
      const parts = path.split('/')
      const dirname = parts.pop()!
      const parent = await navigateToDir(root, parts)
      await parent.removeEntry(dirname, { recursive: true })
    } catch (err: any) {
      if (err?.name !== 'NotFoundError') throw err
    }
  },

  async listDirectory(path: string): Promise<string[]> {
    try {
      const root = requireHandle()
      const parts = path.split('/').filter(Boolean)
      const dir = await navigateToDir(root, parts)
      const entries: string[] = []
      for await (const name of (dir as any).keys()) {
        entries.push(name)
      }
      return entries
    } catch {
      return []
    }
  },

  async fileExists(path: string): Promise<boolean> {
    try {
      const root = requireHandle()
      const parts = path.split('/')
      const filename = parts.pop()!
      const dir = await navigateToDir(root, parts)
      await dir.getFileHandle(filename)
      return true
    } catch {
      return false
    }
  },

  async readFileAsFile(path: string): Promise<File | null> {
    try {
      const root = requireHandle()
      const normalizedPath = String(path || '').replace(/^\/+|\/+$/g, '')
      if (!normalizedPath) return null
      const parts = normalizedPath.split('/')
      const filename = parts.pop()
      if (!filename) return null
      const dir = await navigateToDir(root, parts)
      const handle = await dir.getFileHandle(filename)
      return await handle.getFile()
    } catch {
      return null
    }
  },

  // ─── Platform-specific ──────────────────────────────────────────

  getWorkspaceBasePath(): string | null {
    return null // Web has no native path
  },

  getWorkspaceHandle(): FileSystemDirectoryHandle | null {
    return workspaceHandle
  },

  async resolveWorkspaceRelativePathForHandle(
    fileHandle: FileSystemFileHandle,
  ): Promise<string | null> {
    try {
      const root = requireHandle()
      const pathParts = await (root as any).resolve(fileHandle) as string[] | null
      if (!Array.isArray(pathParts) || pathParts.length === 0) return null
      return pathParts.join('/')
    } catch {
      return null
    }
  },
}
