import { openDB } from './idb'

// ─── Types ──────────────────────────────────────────────────────────

export interface CaseMeta {
  case_id: string
  name: string
  case_number?: string
  description?: string
  created_at: string
  updated_at: string
}

export interface CaseDetail extends CaseMeta {
  transcript_count: number
  transcripts: TranscriptSummary[]
}

export interface TranscriptSummary {
  media_key: string
  title_label: string
  created_at?: string
  updated_at?: string | null
  audio_duration?: number
  line_count?: number
  case_id?: string | null
}

export interface TranscriptData {
  media_key: string
  created_at: string
  updated_at: string
  title_data: Record<string, string>
  audio_duration: number
  lines_per_page: number
  lines: unknown[]
  source_turns?: unknown[]
  pdf_base64?: string
  transcript_text?: string
  transcript?: string
  viewer_html_base64?: string
  oncue_xml_base64?: string
  media_filename?: string
  media_content_type?: string
  media_handle_id?: string
  media_workspace_relpath?: string
  media_storage_mode?: 'workspace-relative' | 'external-handle' | 'workspace-cache'
  media_blob_name?: string
  playback_cache_path?: string
  playback_cache_content_type?: string
  case_id?: string | null
  [key: string]: unknown
}

export interface SearchResult {
  media_key: string
  title_label: string
  matches: SearchMatch[]
}

export interface SearchMatch {
  line_id: string
  page: number
  line: number
  text: string
  speaker: string
  match_type: string
}

export interface WorkspacePreferences {
  lines_per_page: number
  auto_save_interval_seconds: number
  default_transcription_model: string
  media_cache_cap_bytes: number
}

export interface WorkspaceConfig {
  version: number
  created_at: string
  updated_at: string
  preferences: WorkspacePreferences
}

export const DEFAULT_MEDIA_CACHE_CAP_BYTES = 10 * 1024 * 1024 * 1024

// ─── Constants ──────────────────────────────────────────────────────

const IDB_KEY_WORKSPACE = 'workspace-dir-handle'
const MULTI_TAB_CHANNEL = 'ta-multi-tab'
const CONFIG_FILENAME = 'config.json'
const CONFIG_VERSION = 2

// ─── Module State ───────────────────────────────────────────────────

let workspaceHandle: FileSystemDirectoryHandle | null = null
let multiTabChannel: BroadcastChannel | null = null

function buildDefaultPreferences(overrides?: Partial<WorkspacePreferences>): WorkspacePreferences {
  return {
    lines_per_page: 25,
    auto_save_interval_seconds: 60,
    default_transcription_model: 'assemblyai',
    media_cache_cap_bytes: DEFAULT_MEDIA_CACHE_CAP_BYTES,
    ...overrides,
  }
}

function buildDefaultConfig(overrides?: Partial<WorkspaceConfig>): WorkspaceConfig {
  const now = new Date().toISOString()
  return {
    version: CONFIG_VERSION,
    created_at: now,
    updated_at: now,
    preferences: buildDefaultPreferences(),
    ...overrides,
  }
}

function normalizeWorkspaceConfig(raw: unknown): WorkspaceConfig {
  const record = (raw || {}) as Record<string, unknown>
  const preferencesRecord = (record.preferences || {}) as Record<string, unknown>
  const parsedCap = Number(preferencesRecord.media_cache_cap_bytes)
  const capBytes = Number.isFinite(parsedCap) && parsedCap > 0
    ? Math.floor(parsedCap)
    : DEFAULT_MEDIA_CACHE_CAP_BYTES

  const createdAt = typeof record.created_at === 'string' && record.created_at.trim()
    ? record.created_at
    : new Date().toISOString()
  const updatedAt = typeof record.updated_at === 'string' && record.updated_at.trim()
    ? record.updated_at
    : createdAt

  return {
    version: Number.isFinite(Number(record.version)) ? Number(record.version) : CONFIG_VERSION,
    created_at: createdAt,
    updated_at: updatedAt,
    preferences: buildDefaultPreferences({
      lines_per_page: Number.isFinite(Number(preferencesRecord.lines_per_page))
        ? Number(preferencesRecord.lines_per_page)
        : 25,
      auto_save_interval_seconds: Number.isFinite(Number(preferencesRecord.auto_save_interval_seconds))
        ? Number(preferencesRecord.auto_save_interval_seconds)
        : 60,
      default_transcription_model:
        typeof preferencesRecord.default_transcription_model === 'string' &&
        preferencesRecord.default_transcription_model.trim()
          ? preferencesRecord.default_transcription_model
          : 'assemblyai',
      media_cache_cap_bytes: capBytes,
    }),
  }
}

// ─── Multi-Tab Detection ────────────────────────────────────────────

export function setupMultiTabDetection(onConflict: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}

  multiTabChannel = new BroadcastChannel(MULTI_TAB_CHANNEL)

  // Announce presence
  multiTabChannel.postMessage({ type: 'tab-open', timestamp: Date.now() })

  multiTabChannel.onmessage = (event) => {
    if (event.data?.type === 'tab-open') {
      onConflict()
    }
  }

  return () => {
    multiTabChannel?.close()
    multiTabChannel = null
  }
}

// ─── Persistent Storage ────────────────────────────────────────────

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist()
    }
  } catch {
    console.warn('[storage] navigator.storage.persist() failed')
  }
  return false
}

export async function isPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted) {
      return await navigator.storage.persisted()
    }
  } catch {
    console.warn('[storage] navigator.storage.persisted() check failed')
  }
  return false
}

// ─── Workspace Initialization ───────────────────────────────────────

export async function isWorkspaceConfigured(): Promise<boolean> {
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
}

export type WorkspaceInitStatus = 'ok' | 'no-handle' | 'permission-denied' | 'permission-prompt' | 'error'

export interface WorkspaceInitResult {
  status: WorkspaceInitStatus
  handle: FileSystemDirectoryHandle | null
}

export async function initWorkspaceDetailed(): Promise<WorkspaceInitResult> {
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
      console.warn('[storage] No workspace handle found in IndexedDB')
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
      console.warn('[storage] requestPermission() threw — likely no user gesture')
      return { status: 'permission-prompt', handle: null }
    }

    if (permission === 'granted') {
      await ensureWorkspaceStructure(handle)
      workspaceHandle = handle
      return { status: 'ok', handle }
    }

    if (permission === 'denied') {
      console.warn('[storage] Permission denied for workspace handle')
      return { status: 'permission-denied', handle: null }
    }

    console.warn('[storage] Permission not granted (status: %s) — likely needs user gesture', permission)
    return { status: 'permission-prompt', handle: null }
  } catch (err) {
    console.warn('[storage] initWorkspaceDetailed error:', err)
    return { status: 'error', handle: null }
  }
}

export async function initWorkspace(): Promise<FileSystemDirectoryHandle | null> {
  const result = await initWorkspaceDetailed()
  return result.handle
}

export async function pickAndInitWorkspace(): Promise<{ handle: FileSystemDirectoryHandle; isExisting: boolean }> {
  const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })

  // Check if returning user
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
  await requestPersistentStorage()

  workspaceHandle = handle
  return { handle, isExisting }
}

async function ensureWorkspaceStructure(root: FileSystemDirectoryHandle): Promise<void> {
  await root.getDirectoryHandle('cases', { create: true })
  await root.getDirectoryHandle('uncategorized', { create: true })
  const cache = await root.getDirectoryHandle('cache', { create: true })
  await cache.getDirectoryHandle('converted', { create: true })
  await cache.getDirectoryHandle('playback', { create: true })
}

// ─── Low-Level File Operations ──────────────────────────────────────

function getWorkspaceHandle(): FileSystemDirectoryHandle {
  if (!workspaceHandle) {
    throw new Error('Workspace not initialized. Call initWorkspace() first.')
  }
  return workspaceHandle
}

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

export async function readJSON<T>(path: string): Promise<T | null> {
  try {
    const root = getWorkspaceHandle()
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
}

export async function writeJSON(path: string, data: unknown): Promise<void> {
  const root = getWorkspaceHandle()
  const parts = path.split('/')
  const filename = parts.pop()!
  const dir = await navigateToDir(root, parts, true)
  await writeJSONToHandle(dir, filename, data)
}

export async function deleteFile(path: string): Promise<void> {
  try {
    const root = getWorkspaceHandle()
    const parts = path.split('/')
    const filename = parts.pop()!
    const dir = await navigateToDir(root, parts)
    await dir.removeEntry(filename)
  } catch (err: any) {
    if (err?.name !== 'NotFoundError') throw err
  }
}

export async function deleteDirectory(path: string): Promise<void> {
  try {
    const root = getWorkspaceHandle()
    const parts = path.split('/')
    const dirname = parts.pop()!
    const parent = await navigateToDir(root, parts)
    await parent.removeEntry(dirname, { recursive: true })
  } catch (err: any) {
    if (err?.name !== 'NotFoundError') throw err
  }
}

export async function listDirectory(path: string): Promise<string[]> {
  try {
    const root = getWorkspaceHandle()
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
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const root = getWorkspaceHandle()
    const parts = path.split('/')
    const filename = parts.pop()!
    const dir = await navigateToDir(root, parts)
    await dir.getFileHandle(filename)
    return true
  } catch {
    return false
  }
}

export async function readWorkspaceRelativeFile(path: string): Promise<File | null> {
  try {
    const root = getWorkspaceHandle()
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
}

export async function resolveWorkspaceRelativePathForHandle(
  fileHandle: FileSystemFileHandle,
): Promise<string | null> {
  try {
    const root = getWorkspaceHandle()
    const pathParts = await (root as any).resolve(fileHandle) as string[] | null
    if (!Array.isArray(pathParts) || pathParts.length === 0) return null
    return pathParts.join('/')
  } catch {
    return null
  }
}

export async function getWorkspaceConfig(): Promise<WorkspaceConfig> {
  const current = await readJSON<WorkspaceConfig>(CONFIG_FILENAME)
  const normalized = normalizeWorkspaceConfig(current)

  const needsWrite =
    !current ||
    JSON.stringify(current.preferences || {}) !== JSON.stringify(normalized.preferences) ||
    Number(current.version || 0) < CONFIG_VERSION

  if (needsWrite) {
    const persisted: WorkspaceConfig = {
      ...normalized,
      version: CONFIG_VERSION,
      updated_at: new Date().toISOString(),
      created_at: normalized.created_at || new Date().toISOString(),
    }
    await writeJSON(CONFIG_FILENAME, persisted)
    return persisted
  }

  return normalized
}

export async function updateWorkspacePreferences(
  updates: Partial<WorkspacePreferences>,
): Promise<WorkspaceConfig> {
  const current = await getWorkspaceConfig()
  const nextPreferences = buildDefaultPreferences({
    ...current.preferences,
    ...updates,
  })
  const nextConfig: WorkspaceConfig = {
    ...current,
    version: CONFIG_VERSION,
    updated_at: new Date().toISOString(),
    preferences: nextPreferences,
  }
  await writeJSON(CONFIG_FILENAME, nextConfig)
  return nextConfig
}

export async function getMediaCacheCapBytes(): Promise<number> {
  const config = await getWorkspaceConfig()
  const capBytes = Number(config.preferences.media_cache_cap_bytes)
  if (!Number.isFinite(capBytes) || capBytes <= 0) return DEFAULT_MEDIA_CACHE_CAP_BYTES
  return Math.floor(capBytes)
}

// ─── Case Operations ────────────────────────────────────────────────

export async function listCases(): Promise<(CaseMeta & { transcript_count: number })[]> {
  const entries = await listDirectory('cases')
  const cases: (CaseMeta & { transcript_count: number })[] = []

  for (const name of entries) {
    try {
      const meta = await readJSON<CaseMeta>(`cases/${name}/meta.json`)
      if (meta) {
        const transcripts = await listDirectory(`cases/${name}/transcripts`)
        cases.push({
          ...meta,
          transcript_count: transcripts.filter((f) => f.endsWith('.json')).length,
        })
      }
    } catch {
      // Skip invalid case directories
    }
  }

  cases.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  return cases
}

export async function getCase(caseId: string): Promise<CaseDetail | null> {
  const meta = await readJSON<CaseMeta>(`cases/${caseId}/meta.json`)
  if (!meta) return null

  const transcripts = await listTranscriptsInCase(caseId)
  return {
    ...meta,
    transcript_count: transcripts.length,
    transcripts,
  }
}

export async function createCase(meta: CaseMeta): Promise<void> {
  const root = getWorkspaceHandle()
  const casesDir = await root.getDirectoryHandle('cases', { create: true })
  const caseDir = await casesDir.getDirectoryHandle(meta.case_id, { create: true })
  await caseDir.getDirectoryHandle('transcripts', { create: true })
  await caseDir.getDirectoryHandle('clips', { create: true })
  await caseDir.getDirectoryHandle('sequences', { create: true })
  await writeJSONToHandle(caseDir, 'meta.json', meta)
}

export async function updateCase(caseId: string, updates: Partial<CaseMeta>): Promise<CaseMeta> {
  const existing = await readJSON<CaseMeta>(`cases/${caseId}/meta.json`)
  if (!existing) throw new Error('Case not found')
  const updated: CaseMeta = {
    ...existing,
    ...updates,
    case_id: caseId,
    updated_at: new Date().toISOString(),
  }
  await writeJSON(`cases/${caseId}/meta.json`, updated)
  return updated
}

export async function deleteCase(caseId: string, deleteTranscripts = false): Promise<void> {
  if (!deleteTranscripts) {
    // Move transcripts to uncategorized -- write ALL copies first, then delete the case
    const transcripts = await listTranscriptsInCase(caseId)
    const failedCopies: string[] = []
    for (const t of transcripts) {
      try {
        const data = await readJSON<TranscriptData>(`cases/${caseId}/transcripts/${t.media_key}.json`)
        if (data) {
          data.case_id = null
          await writeJSON(`uncategorized/${t.media_key}.json`, data)
        }
      } catch {
        failedCopies.push(t.media_key)
      }
    }
    if (failedCopies.length > 0) {
      throw new Error(`Could not move ${failedCopies.length} transcript(s) to uncategorized. Case was not deleted.`)
    }
  }
  await deleteDirectory(`cases/${caseId}`)
}

// ─── Transcript Operations ──────────────────────────────────────────

function buildTranscriptSummary(data: TranscriptData, caseId?: string | null): TranscriptSummary {
  const titleData = data.title_data || {}
  return {
    media_key: data.media_key,
    title_label: titleData.FILE_NAME || titleData.CASE_NAME || data.media_key,
    created_at: data.created_at,
    updated_at: data.updated_at,
    audio_duration: data.audio_duration,
    line_count: Array.isArray(data.lines) ? data.lines.length : 0,
    case_id: caseId ?? data.case_id ?? null,
  }
}

export async function listTranscriptsInCase(caseId: string): Promise<TranscriptSummary[]> {
  const files = await listDirectory(`cases/${caseId}/transcripts`)
  const summaries: TranscriptSummary[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const data = await readJSON<TranscriptData>(`cases/${caseId}/transcripts/${file}`)
      if (data) {
        summaries.push(buildTranscriptSummary(data, caseId))
      }
    } catch {
      // Skip unreadable files
    }
  }

  summaries.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  return summaries
}

export async function listUncategorizedTranscripts(): Promise<TranscriptSummary[]> {
  const files = await listDirectory('uncategorized')
  const summaries: TranscriptSummary[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const data = await readJSON<TranscriptData>(`uncategorized/${file}`)
      if (data) {
        summaries.push(buildTranscriptSummary(data, null))
      }
    } catch {
      // Skip unreadable files
    }
  }

  summaries.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  return summaries
}

export async function getTranscript(mediaKey: string): Promise<TranscriptData | null> {
  // Check uncategorized first
  const uncategorized = await readJSON<TranscriptData>(`uncategorized/${mediaKey}.json`)
  if (uncategorized) return uncategorized

  // Search cases
  const caseEntries = await listDirectory('cases')
  for (const caseId of caseEntries) {
    const data = await readJSON<TranscriptData>(`cases/${caseId}/transcripts/${mediaKey}.json`)
    if (data) return data
  }

  return null
}

export async function saveTranscript(
  mediaKey: string,
  data: TranscriptData | Record<string, unknown>,
  caseId?: string,
): Promise<void> {
  const record = data as Record<string, unknown>
  record.updated_at = new Date().toISOString()
  if (!record.created_at) {
    record.created_at = record.updated_at
  }

  if (caseId) {
    record.case_id = caseId
    // Ensure case transcripts directory exists
    const root = getWorkspaceHandle()
    const casesDir = await root.getDirectoryHandle('cases', { create: true })
    const caseDir = await casesDir.getDirectoryHandle(caseId, { create: true })
    await caseDir.getDirectoryHandle('transcripts', { create: true })
    await writeJSON(`cases/${caseId}/transcripts/${mediaKey}.json`, record)
  } else {
    record.case_id = null
    await writeJSON(`uncategorized/${mediaKey}.json`, record)
  }
}

export async function deleteTranscript(mediaKey: string): Promise<void> {
  // Try uncategorized
  if (await fileExists(`uncategorized/${mediaKey}.json`)) {
    await deleteFile(`uncategorized/${mediaKey}.json`)
    return
  }

  // Search cases
  const caseEntries = await listDirectory('cases')
  for (const caseId of caseEntries) {
    if (await fileExists(`cases/${caseId}/transcripts/${mediaKey}.json`)) {
      await deleteFile(`cases/${caseId}/transcripts/${mediaKey}.json`)
      return
    }
  }
}

export async function moveTranscriptToCase(mediaKey: string, targetCaseId: string): Promise<void> {
  // Find the transcript
  const data = await getTranscript(mediaKey)
  if (!data) throw new Error('Transcript not found')

  // Write to new location FIRST (so data is safe before we delete the old copy)
  if (targetCaseId === 'uncategorized' || !targetCaseId) {
    data.case_id = null
    await saveTranscript(mediaKey, data)
  } else {
    data.case_id = targetCaseId
    await saveTranscript(mediaKey, data, targetCaseId)
  }

  // Only delete from old location after write succeeded
  // Find old location (it's wherever getTranscript found it, excluding the new location)
  if (targetCaseId === 'uncategorized' || !targetCaseId) {
    // We wrote to uncategorized, so delete from any case
    const caseEntries = await listDirectory('cases')
    for (const caseId of caseEntries) {
      if (await fileExists(`cases/${caseId}/transcripts/${mediaKey}.json`)) {
        await deleteFile(`cases/${caseId}/transcripts/${mediaKey}.json`)
        return
      }
    }
  } else {
    // We wrote to a case, so delete from uncategorized or other cases
    if (await fileExists(`uncategorized/${mediaKey}.json`)) {
      await deleteFile(`uncategorized/${mediaKey}.json`)
      return
    }
    const caseEntries = await listDirectory('cases')
    for (const caseId of caseEntries) {
      if (caseId === targetCaseId) continue
      if (await fileExists(`cases/${caseId}/transcripts/${mediaKey}.json`)) {
        await deleteFile(`cases/${caseId}/transcripts/${mediaKey}.json`)
        return
      }
    }
  }
}

// ─── Search ─────────────────────────────────────────────────────────

export async function searchCaseTranscripts(
  caseId: string,
  query: string,
): Promise<SearchResult[]> {
  const lowerQuery = query.toLowerCase()
  const files = await listDirectory(`cases/${caseId}/transcripts`)
  const results: SearchResult[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const data = await readJSON<TranscriptData>(`cases/${caseId}/transcripts/${file}`)
      if (!data || !Array.isArray(data.lines)) continue

      const matches: SearchMatch[] = []
      for (const line of data.lines as any[]) {
        const text = (line.text || '').toLowerCase()
        const speaker = (line.speaker || '').toLowerCase()
        if (text.includes(lowerQuery) || speaker.includes(lowerQuery)) {
          matches.push({
            line_id: line.id || '',
            page: line.page || 0,
            line: line.line || 0,
            text: line.text || '',
            speaker: line.speaker || '',
            match_type: text.includes(lowerQuery) ? 'text' : 'speaker',
          })
        }
      }

      if (matches.length > 0) {
        const titleData = data.title_data || {}
        results.push({
          media_key: data.media_key,
          title_label: titleData.FILE_NAME || titleData.CASE_NAME || data.media_key,
          matches,
        })
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results
}

// ─── Workspace Info ─────────────────────────────────────────────────

export function getWorkspaceName(): string | null {
  return workspaceHandle?.name ?? null
}

export async function getStorageEstimate(): Promise<{ fileCount: number; totalSize: number }> {
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
}

export async function clearWorkspace(): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('workspace', 'readwrite')
    const store = tx.objectStore('workspace')
    const request = store.delete(IDB_KEY_WORKSPACE)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
  workspaceHandle = null
}

// ─── Clip and Sequence Operations ──────────────────────────────────

export interface ClipRecord {
  clip_id: string
  name: string
  source_media_key: string
  start_time: number
  end_time: number
  start_pgln?: number | null
  end_pgln?: number | null
  start_page?: number | null
  start_line?: number | null
  end_page?: number | null
  end_line?: number | null
  created_at: string
  updated_at?: string
  order?: number
}

export interface ClipSequenceEntry {
  clip_id: string
  source_media_key: string
  order: number
}

export interface ClipSequenceRecord {
  sequence_id: string
  name: string
  created_at: string
  updated_at: string
  order?: number
  entries: ClipSequenceEntry[]
}

function sortByOrderThenCreatedAt<T extends { order?: number; created_at?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aOrder = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER
    const bOrder = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
}

function normalizeSequenceEntries(entries: ClipSequenceEntry[]): ClipSequenceEntry[] {
  return [...entries]
    .sort((a, b) => a.order - b.order)
    .map((entry, index) => ({
      clip_id: entry.clip_id,
      source_media_key: entry.source_media_key,
      order: Number.isFinite(entry.order) ? entry.order : index,
    }))
}

export async function listCaseClips(caseId: string): Promise<ClipRecord[]> {
  const files = await listDirectory(`cases/${caseId}/clips`)
  const clips: ClipRecord[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const clip = await readJSON<ClipRecord>(`cases/${caseId}/clips/${file}`)
    if (clip) clips.push(clip)
  }

  return sortByOrderThenCreatedAt(clips)
}

export async function listTranscriptClips(caseId: string, mediaKey: string): Promise<ClipRecord[]> {
  const allClips = await listCaseClips(caseId)
  return allClips.filter((clip) => clip.source_media_key === mediaKey)
}

export async function getClip(caseId: string, clipId: string): Promise<ClipRecord | null> {
  return readJSON<ClipRecord>(`cases/${caseId}/clips/${clipId}.json`)
}

export async function saveClip(caseId: string, clip: ClipRecord): Promise<void> {
  const now = new Date().toISOString()
  const record: ClipRecord = {
    ...clip,
    clip_id: clip.clip_id,
    created_at: clip.created_at || now,
    updated_at: now,
  }
  await writeJSON(`cases/${caseId}/clips/${record.clip_id}.json`, record)
}

export async function deleteClip(caseId: string, clipId: string): Promise<void> {
  await deleteFile(`cases/${caseId}/clips/${clipId}.json`)
}

export async function listCaseSequences(caseId: string): Promise<ClipSequenceRecord[]> {
  const files = await listDirectory(`cases/${caseId}/sequences`)
  const sequences: ClipSequenceRecord[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const sequence = await readJSON<ClipSequenceRecord>(`cases/${caseId}/sequences/${file}`)
    if (sequence) {
      sequences.push({
        ...sequence,
        entries: normalizeSequenceEntries(sequence.entries || []),
      })
    }
  }

  return sortByOrderThenCreatedAt(sequences)
}

export async function getSequence(caseId: string, sequenceId: string): Promise<ClipSequenceRecord | null> {
  const sequence = await readJSON<ClipSequenceRecord>(`cases/${caseId}/sequences/${sequenceId}.json`)
  if (!sequence) return null
  return {
    ...sequence,
    entries: normalizeSequenceEntries(sequence.entries || []),
  }
}

export async function saveSequence(caseId: string, sequence: ClipSequenceRecord): Promise<void> {
  const now = new Date().toISOString()
  const record: ClipSequenceRecord = {
    ...sequence,
    sequence_id: sequence.sequence_id,
    created_at: sequence.created_at || now,
    updated_at: now,
    entries: normalizeSequenceEntries(sequence.entries || []),
  }
  await writeJSON(`cases/${caseId}/sequences/${record.sequence_id}.json`, record)
}

export async function deleteSequence(caseId: string, sequenceId: string): Promise<void> {
  await deleteFile(`cases/${caseId}/sequences/${sequenceId}.json`)
}

// ─── Binary File Operations ────────────────────────────────────────

export async function writeBinaryFile(
  path: string,
  data: ArrayBuffer | Uint8Array | Blob,
): Promise<void> {
  const root = getWorkspaceHandle()
  const parts = path.split('/')
  const filename = parts.pop()!
  const dir = await navigateToDir(root, parts, true)
  const fileHandle = await dir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  let payload: ArrayBuffer | Blob
  if (data instanceof Uint8Array) {
    // Ensure the payload is ArrayBuffer-backed for File System Access typings.
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    payload = copy.buffer
  } else {
    payload = data
  }
  await writable.write(payload)
  await writable.close()
}

export async function readBinaryFile(path: string): Promise<ArrayBuffer | null> {
  try {
    const root = getWorkspaceHandle()
    const parts = path.split('/')
    const filename = parts.pop()!
    const dir = await navigateToDir(root, parts)
    const fileHandle = await dir.getFileHandle(filename)
    const file = await fileHandle.getFile()
    return await file.arrayBuffer()
  } catch {
    return null
  }
}
