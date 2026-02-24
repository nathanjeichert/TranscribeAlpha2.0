import type { PlatformFS } from './types'

let _fs: PlatformFS | null = null

/**
 * Synchronous check for Tauri environment.
 * Safe to call at any time — returns false during SSR.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Returns the platform-specific filesystem adapter.
 * Web: File System Access API.  Tauri: @tauri-apps/plugin-fs.
 * Uses dynamic import so the unused adapter is tree-shaken from the bundle.
 */
export async function getPlatformFS(): Promise<PlatformFS> {
  if (_fs) return _fs
  if (isTauri()) {
    const mod = await import('./tauriFS')
    _fs = mod.tauriFSAdapter
  } else {
    const mod = await import('./webFS')
    _fs = mod.webFSAdapter
  }
  return _fs
}

// Re-export types for convenience
export type { PlatformFS, WorkspaceInitResult, WorkspaceInitStatus } from './types'
