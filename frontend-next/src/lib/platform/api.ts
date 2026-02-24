// ─── Platform API Routing ────────────────────────────────────────────
//
// In web mode: API calls go to same-origin Cloud Run backend.
// In Tauri mode: API calls go to localhost Python sidecar (no auth).

import { isTauri } from './index'

const TAURI_SIDECAR_PORT = 18080

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
 * e.g., '/api/transcribe' → 'http://localhost:18080/api/transcribe' in Tauri.
 */
export function apiUrl(path: string): string {
  return getApiBase() + path
}
