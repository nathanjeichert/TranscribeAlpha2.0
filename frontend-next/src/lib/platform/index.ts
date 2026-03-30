import type { PlatformFS, PlatformMedia } from './types'

let _fs: PlatformFS | null = null
let _media: PlatformMedia | null = null

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

/**
 * Whether the platform supports a native file picker dialog
 * (Tauri native dialog or File System Access API).
 * Falls back to `<input type="file">` when false.
 */
export function hasNativeFilePicker(): boolean {
  return isTauri() || (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function')
}

/**
 * Returns the platform-specific media adapter.
 * Web: File System Access API pickers + anchor downloads.
 * Tauri: native dialog + plugin-fs.
 */
export async function getPlatformMedia(): Promise<PlatformMedia> {
  if (_media) return _media
  if (isTauri()) {
    const mod = await import('./tauriMedia')
    _media = mod.tauriMediaAdapter
  } else {
    const mod = await import('./webMedia')
    _media = mod.webMediaAdapter
  }
  return _media
}

// Re-export types for convenience
export type { PlatformFS, PlatformMedia, WorkspaceInitResult, WorkspaceInitStatus } from './types'
