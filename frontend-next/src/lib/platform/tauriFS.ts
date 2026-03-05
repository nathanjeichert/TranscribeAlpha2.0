// ─── Tauri Native Filesystem Adapter ─────────────────────────────────
//
// Implements PlatformFS using @tauri-apps/plugin-fs.
// Uses Tauri's appDataDir for transcripts/config and appCacheDir for media cache.
// All paths from the storage layer are workspace-relative with forward slashes;
// this adapter converts them to OS-native paths at the boundary.

import type { PlatformFS, WorkspaceInitResult } from './types'

const CONFIG_FILENAME = 'config.json'

let dataPath: string | null = null   // ~/Library/Application Support/com.transcribealpha.app/
let cachePath: string | null = null  // ~/Library/Caches/com.transcribealpha.app/

// ─── Lazy imports (loaded only when running in Tauri) ───────────────

async function getTauriFs() {
  return await import('@tauri-apps/plugin-fs')
}

// ─── Path helpers ───────────────────────────────────────────────────

async function getSep(): Promise<string> {
  const pathMod = await import('@tauri-apps/api/path')
  const s = typeof pathMod.sep === 'function' ? (pathMod.sep as () => string)() : pathMod.sep
  return String(s)
}

async function toNative(workspaceRelative: string): Promise<string> {
  const s = await getSep()
  const parts = workspaceRelative.split('/').filter(Boolean)
  // Route cache/* paths to cachePath, everything else to dataPath
  const base = parts[0] === 'cache' ? cachePath : dataPath
  if (!base) throw new Error('tauriFS not initialized')
  return base + s + parts.join(s)
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

async function ensureDirectoryStructure(): Promise<void> {
  const fs = await getTauriFs()
  const s = await getSep()
  const dirs = [
    `${dataPath}${s}cases`,
    `${dataPath}${s}uncategorized`,
    `${cachePath}${s}cache`,
    `${cachePath}${s}cache${s}converted`,
    `${cachePath}${s}cache${s}playback`,
  ]
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }
}

// ─── PlatformFS Implementation ──────────────────────────────────────

export const tauriFSAdapter: PlatformFS = {
  async pickWorkspaceDirectory(): Promise<{ isExisting: boolean }> {
    // No-op in Tauri — app directories are auto-provisioned.
    return { isExisting: true }
  },

  async initWorkspace(): Promise<WorkspaceInitResult> {
    try {
      const pathMod = await import('@tauri-apps/api/path')
      dataPath = await pathMod.appDataDir()
      cachePath = await pathMod.appCacheDir()

      await ensureDirectoryStructure()

      // Write config.json if it doesn't exist
      const fs = await getTauriFs()
      const s = await getSep()
      const configPath = `${dataPath}${s}${CONFIG_FILENAME}`
      const exists = await fs.exists(configPath)
      if (!exists) {
        await fs.writeTextFile(configPath, JSON.stringify(buildDefaultConfig(), null, 2))
      }

      return { status: 'ok', handle: null }
    } catch (err) {
      console.warn('[tauriFS] initWorkspace error:', err)
      return { status: 'error', handle: null }
    }
  },

  async isWorkspaceConfigured(): Promise<boolean> {
    return true
  },

  async clearWorkspace(): Promise<void> {
    dataPath = null
    cachePath = null
  },

  getWorkspaceName(): string | null {
    return 'TranscribeAlpha'
  },

  async getStorageEstimate(): Promise<{ fileCount: number; totalSize: number }> {
    if (!dataPath) return { fileCount: 0, totalSize: 0 }

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

    await walk(dataPath)
    if (cachePath) await walk(cachePath)
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
    return dataPath
  },

  getWorkspaceHandle(): FileSystemDirectoryHandle | null {
    return null
  },

  async resolveWorkspaceRelativePathForHandle(): Promise<string | null> {
    return null
  },
}
