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
  media_blob_name?: string
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

// ─── Constants ──────────────────────────────────────────────────────

const IDB_KEY_WORKSPACE = 'workspace-dir-handle'
const MULTI_TAB_CHANNEL = 'ta-multi-tab'
const CONFIG_FILENAME = 'config.json'

// ─── Module State ───────────────────────────────────────────────────

let workspaceHandle: FileSystemDirectoryHandle | null = null
let multiTabChannel: BroadcastChannel | null = null

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

export async function initWorkspace(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB()
    const handle: FileSystemDirectoryHandle | undefined = await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readonly')
      const store = tx.objectStore('workspace')
      const request = store.get(IDB_KEY_WORKSPACE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    if (!handle) return null

    // Request permission
    const permission = await (handle as any).requestPermission({ mode: 'readwrite' })
    if (permission !== 'granted') return null

    // Verify workspace structure
    await ensureWorkspaceStructure(handle)
    workspaceHandle = handle
    return handle
  } catch {
    return null
  }
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
    await writeJSONToHandle(handle, CONFIG_FILENAME, {
      version: 1,
      created_at: new Date().toISOString(),
      preferences: {
        lines_per_page: 25,
        auto_save_interval_seconds: 60,
        default_transcription_model: 'assemblyai',
      },
    })
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

  workspaceHandle = handle
  return { handle, isExisting }
}

async function ensureWorkspaceStructure(root: FileSystemDirectoryHandle): Promise<void> {
  await root.getDirectoryHandle('cases', { create: true })
  await root.getDirectoryHandle('uncategorized', { create: true })
  const cache = await root.getDirectoryHandle('cache', { create: true })
  await cache.getDirectoryHandle('converted', { create: true })
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
    title_label: titleData.CASE_NAME || titleData.FILE_NAME || data.media_key,
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
          title_label: titleData.CASE_NAME || titleData.FILE_NAME || data.media_key,
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
