// Platform API routing helpers.
//
// Web mode: API calls go to same-origin backend.
// Tauri mode: API calls go to the localhost Python sidecar and include
// a per-launch desktop session token.

import { isTauri } from './index'

const TAURI_SIDECAR_PORT = 18080
const DESKTOP_SESSION_HEADER = 'X-TranscribeAlpha-Session'

let desktopSessionTokenPromise: Promise<string | null> | null = null

/**
 * Returns the API base URL.
 * Web: empty string (same-origin). Tauri: localhost sidecar.
 */
export function getApiBase(): string {
  if (isTauri()) return `http://localhost:${TAURI_SIDECAR_PORT}`
  return ''
}

/**
 * Whether the current platform requires JWT authentication.
 */
export function needsAuth(): boolean {
  return !isTauri()
}

/**
 * Prefix a relative API path with the correct base URL.
 */
export function apiUrl(path: string): string {
  return getApiBase() + path
}

async function getDesktopSessionToken(): Promise<string | null> {
  if (!isTauri()) return null

  if (!desktopSessionTokenPromise) {
    desktopSessionTokenPromise = import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<string>('get_desktop_session_token'))
      .catch(() => null)
  }

  return desktopSessionTokenPromise
}

/**
 * Merge headers with the current platform-specific API headers.
 */
export async function getPlatformApiHeaders(headers?: HeadersInit): Promise<Record<string, string>> {
  const merged = new Headers(headers)

  const desktopSessionToken = await getDesktopSessionToken()
  if (desktopSessionToken) {
    merged.set(DESKTOP_SESSION_HEADER, desktopSessionToken)
  }

  return Object.fromEntries(merged.entries())
}
