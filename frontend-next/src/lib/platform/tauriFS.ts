// ─── Tauri Native Filesystem Adapter ─────────────────────────────────
//
// Implements PlatformFS using @tauri-apps/plugin-fs, @tauri-apps/plugin-dialog,
// and @tauri-apps/plugin-store for workspace path persistence.
// All paths are workspace-relative with forward slashes; this adapter
// converts them to OS-native paths at the boundary.

import type { PlatformFS, WorkspaceInitResult } from './types'

const CONFIG_FILENAME = 'config.json'
const STORE_KEY_WORKSPACE_PATH = 'workspace-path'

let workspacePath: string | null = null
let workspaceName: string | null = null

// ─── Lazy imports (loaded only when running in Tauri) ───────────────

async function getTauriFs() {
  return await import('@tauri-apps/plugin-fs')
}

async function getTauriDialog() {
  return await import('@tauri-apps/plugin-dialog')
}

async function getTauriStore() {
  const { LazyStore } = await import('@tauri-apps/plugin-store')
  return new LazyStore('settings.json')
}

// ─── Path helpers ───────────────────────────────────────────────────

async function getSep(): Promise<string> {
  const pathMod = await import('@tauri-apps/api/path')
  // sep may be a string constant or a function depending on the API version
  const s = typeof pathMod.sep === 'function' ? (pathMod.sep as () => string)() : pathMod.sep
  return String(s)
}

async function toNative(workspaceRelative: string): Promise<string> {
  const s = await getSep()
  const nativeParts = workspaceRelative.split('/').filter(Boolean)
  return workspacePath + s + nativeParts.join(s)
}

async function parentDir(nativePath: string): Promise<string> {
  const s = await getSep()
  const parts = nativePath.split(s)
  parts.pop()
  return parts.join(s)
}

// ─── Internal helpers ───────────────────────────────────────────────

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

async function ensureWorkspaceStructure(): Promise<void> {
  const fs = await getTauriFs()
  const s = await getSep()
  const dirs = [
    `${workspacePath}${s}cases`,
    `${workspacePath}${s}uncategorized`,
    `${workspacePath}${s}cache`,
    `${workspacePath}${s}cache${s}converted`,
    `${workspacePath}${s}cache${s}playback`,
  ]
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }
}

// ─── PlatformFS Implementation ──────────────────────────────────────

export const tauriFSAdapter: PlatformFS = {
  async pickWorkspaceDirectory(): Promise<{ isExisting: boolean }> {
    const dialog = await getTauriDialog()
    const selected = await dialog.open({ directory: true, title: 'Choose Workspace Folder' })
    if (!selected) throw new DOMException('User cancelled', 'AbortError')

    const pickedPath = typeof selected === 'string' ? selected : (selected as any).path ?? String(selected)
    const fs = await getTauriFs()
    const s = await getSep()

    let isExisting = false
    try {
      await fs.readTextFile(`${pickedPath}${s}${CONFIG_FILENAME}`)
      isExisting = true
    } catch {
      // New workspace
    }

    workspacePath = pickedPath
    workspaceName = pickedPath.split(s).pop() || pickedPath

    if (!isExisting) {
      await ensureWorkspaceStructure()
      await fs.writeTextFile(
        `${pickedPath}${s}${CONFIG_FILENAME}`,
        JSON.stringify(buildDefaultConfig(), null, 2),
      )
    }

    // Persist workspace path
    const store = await getTauriStore()
    await store.set(STORE_KEY_WORKSPACE_PATH, pickedPath)
    await store.save()

    return { isExisting }
  },

  async initWorkspace(): Promise<WorkspaceInitResult> {
    try {
      const store = await getTauriStore()
      const storedPath = await store.get<string>(STORE_KEY_WORKSPACE_PATH)
      if (!storedPath) {
        return { status: 'no-handle', handle: null }
      }

      const fs = await getTauriFs()
      const pathExists = await fs.exists(storedPath)
      if (!pathExists) {
        return { status: 'no-handle', handle: null }
      }

      workspacePath = storedPath
      const s = await getSep()
      workspaceName = storedPath.split(s).pop() || storedPath

      await ensureWorkspaceStructure()
      return { status: 'ok', handle: null }
    } catch (err) {
      console.warn('[tauriFS] initWorkspace error:', err)
      return { status: 'error', handle: null }
    }
  },

  async isWorkspaceConfigured(): Promise<boolean> {
    try {
      const store = await getTauriStore()
      const storedPath = await store.get<string>(STORE_KEY_WORKSPACE_PATH)
      return !!storedPath
    } catch {
      return false
    }
  },

  async clearWorkspace(): Promise<void> {
    const store = await getTauriStore()
    await store.delete(STORE_KEY_WORKSPACE_PATH)
    await store.save()
    workspacePath = null
    workspaceName = null
  },

  getWorkspaceName(): string | null {
    return workspaceName
  },

  async getStorageEstimate(): Promise<{ fileCount: number; totalSize: number }> {
    if (!workspacePath) return { fileCount: 0, totalSize: 0 }

    const fs = await getTauriFs()
    let fileCount = 0
    let totalSize = 0

    async function walk(dirPath: string) {
      try {
        const entries = await fs.readDir(dirPath)
        const s = dirPath.endsWith('/') || dirPath.endsWith('\\') ? '' : '/'
        for (const entry of entries) {
          const fullPath = dirPath + s + entry.name
          if (entry.isDirectory) {
            await walk(fullPath)
          } else if (entry.isFile) {
            fileCount++
            try {
              const stat = await fs.stat(fullPath)
              totalSize += stat.size
            } catch {
              // Skip inaccessible files
            }
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    await walk(workspacePath)
    return { fileCount, totalSize }
  },

  // ─── Low-Level File I/O ─────────────────────────────────────────

  async readJSON<T>(path: string): Promise<T | null> {
    try {
      const fs = await getTauriFs()
      const nativePath = await toNative(path)
      const text = await fs.readTextFile(nativePath)
      return JSON.parse(text) as T
    } catch {
      return null
    }
  },

  async writeJSON(path: string, data: unknown): Promise<void> {
    const fs = await getTauriFs()
    const nativePath = await toNative(path)
    const parent = await parentDir(nativePath)
    await fs.mkdir(parent, { recursive: true })
    await fs.writeTextFile(nativePath, JSON.stringify(data, null, 2))
  },

  async readBinaryFile(path: string): Promise<ArrayBuffer | null> {
    try {
      const fs = await getTauriFs()
      const nativePath = await toNative(path)
      const bytes = await fs.readFile(nativePath)
      return bytes.buffer as ArrayBuffer
    } catch {
      return null
    }
  },

  async writeBinaryFile(path: string, data: ArrayBuffer | Uint8Array | Blob): Promise<void> {
    const fs = await getTauriFs()
    const nativePath = await toNative(path)
    const parent = await parentDir(nativePath)
    await fs.mkdir(parent, { recursive: true })

    let bytes: Uint8Array
    if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer())
    } else if (data instanceof Uint8Array) {
      bytes = data
    } else {
      bytes = new Uint8Array(data)
    }
    await fs.writeFile(nativePath, bytes)
  },

  async deleteFile(path: string): Promise<void> {
    try {
      const fs = await getTauriFs()
      const nativePath = await toNative(path)
      await fs.remove(nativePath)
    } catch {
      // Ignore not-found
    }
  },

  async deleteDirectory(path: string): Promise<void> {
    try {
      const fs = await getTauriFs()
      const nativePath = await toNative(path)
      await fs.remove(nativePath, { recursive: true })
    } catch {
      // Ignore not-found
    }
  },

  async listDirectory(path: string): Promise<string[]> {
    try {
      const fs = await getTauriFs()
      const nativePath = await toNative(path)
      const entries = await fs.readDir(nativePath)
      return entries.map((e) => e.name)
    } catch {
      return []
    }
  },

  async fileExists(path: string): Promise<boolean> {
    try {
      const fs = await getTauriFs()
      const nativePath = await toNative(path)
      return await fs.exists(nativePath)
    } catch {
      return false
    }
  },

  async readFileAsFile(path: string): Promise<File | null> {
    try {
      const fs = await getTauriFs()
      const nativePath = await toNative(path)
      const bytes = await fs.readFile(nativePath)
      const s = await getSep()
      const filename = nativePath.split(s).pop() || 'file'
      return new File([bytes], filename)
    } catch {
      return null
    }
  },

  // ─── Platform-specific ──────────────────────────────────────────

  getWorkspaceBasePath(): string | null {
    return workspacePath
  },

  getWorkspaceHandle(): FileSystemDirectoryHandle | null {
    return null
  },

  async resolveWorkspaceRelativePathForHandle(): Promise<string | null> {
    return null
  },
}
