import { touchMediaCacheEntry } from './mediaCache'
import {
  getFirstAvailableMediaFile,
  getFirstAvailableMediaObjectURL,
  getMediaHandlePermissionState,
} from './mediaHandles'
import { isTauri, getPlatformFS } from './platform'
import { readWorkspaceRelativeFile } from './storage'

export type MediaSourceKind = 'workspace-relative' | 'workspace-cache' | 'external-handle'

export interface MediaRecordShape {
  media_key?: string
  media_handle_id?: string | null
  media_workspace_relpath?: string | null
  media_storage_mode?: string | null
  playback_cache_path?: string | null
  playback_cache_content_type?: string | null
  media_filename?: string | null
}

export interface MediaResolution {
  objectUrl: string | null
  sourceKind: MediaSourceKind | null
  resolvedHandleId?: string | null
  reconnectRecommended: boolean
  message?: string
}

export interface MediaFileResolution {
  file: File | null
  sourceKind: MediaSourceKind | null
  resolvedHandleId?: string | null
  reconnectRecommended: boolean
  message?: string
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildHandleCandidates(record: MediaRecordShape): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const raw of [record.media_handle_id, record.media_key]) {
    const candidate = asText(raw)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    candidates.push(candidate)
  }
  return candidates
}

function buildMissingMessage(record: MediaRecordShape, reconnectRecommended: boolean): string {
  const storageMode = asText(record.media_storage_mode)
  if (storageMode === 'workspace-relative') {
    return 'This file was expected in your workspace folder, but we could not find it there.'
  }
  if (reconnectRecommended) {
    return 'This file is outside your workspace. Click Reconnect File Access to continue.'
  }
  return 'We could not find the media file. Click Locate File to relink it.'
}

async function shouldRecommendReconnect(handleIds: string[]): Promise<boolean> {
  for (const handleId of handleIds) {
    const permissionState = await getMediaHandlePermissionState(handleId)
    if (permissionState === 'prompt' || permissionState === 'denied') {
      return true
    }
  }
  return false
}

interface ResolvedSource {
  file: File
  sourceKind: MediaSourceKind
  resolvedHandleId?: string
  cacheContentType?: string
}

async function resolveMediaSource(
  record: MediaRecordShape,
  options?: { requestPermission?: boolean; skipCache?: boolean },
): Promise<ResolvedSource | null> {
  const mediaKey = asText(record.media_key)

  // 1. Try workspace-relative path
  const workspacePath = asText(record.media_workspace_relpath)
  if (workspacePath) {
    const workspaceFile = await readWorkspaceRelativeFile(workspacePath)
    if (workspaceFile) {
      if (mediaKey) await touchMediaCacheEntry(mediaKey)
      return { file: workspaceFile, sourceKind: 'workspace-relative' }
    }
  }

  // 2. Try playback cache
  if (!options?.skipCache) {
    const cachePath = asText(record.playback_cache_path)
    if (cachePath) {
      const cachedFile = await readWorkspaceRelativeFile(cachePath)
      if (cachedFile) {
        if (mediaKey) await touchMediaCacheEntry(mediaKey)
        return {
          file: cachedFile,
          sourceKind: 'workspace-cache',
          cacheContentType: asText(record.playback_cache_content_type),
        }
      }
    }
  }

  // 3. Try external handles
  const handleCandidates = buildHandleCandidates(record)
  const external = await getFirstAvailableMediaFile(handleCandidates, {
    requestPermission: Boolean(options?.requestPermission),
  })
  if (external) {
    if (mediaKey) await touchMediaCacheEntry(mediaKey)
    return {
      file: external.file,
      sourceKind: 'external-handle',
      resolvedHandleId: external.sourceId,
    }
  }

  return null
}

export async function resolveMediaObjectURLForRecord(
  record: MediaRecordShape,
  options?: { requestPermission?: boolean },
): Promise<MediaResolution> {
  // Tauri: try convertFileSrc for direct streaming (no JS memory copy).
  if (isTauri()) {
    const mediaKey = asText(record.media_key)
    const workspacePath = asText(record.media_workspace_relpath)
    if (workspacePath) {
      const url = await tauriConvertFileSrc(workspacePath)
      if (url) {
        if (mediaKey) await touchMediaCacheEntry(mediaKey)
        return { objectUrl: url, sourceKind: 'workspace-relative', reconnectRecommended: false }
      }
    }
    const cachePath = asText(record.playback_cache_path)
    if (cachePath) {
      const url = await tauriConvertFileSrc(cachePath)
      if (url) {
        if (mediaKey) await touchMediaCacheEntry(mediaKey)
        return { objectUrl: url, sourceKind: 'workspace-cache', reconnectRecommended: false }
      }
    }
  }

  const source = await resolveMediaSource(record, options)

  if (source) {
    // For cache hits with explicit content type, wrap in typed Blob
    const blobSource = source.cacheContentType
      ? new Blob([source.file], { type: source.cacheContentType })
      : source.file
    return {
      objectUrl: URL.createObjectURL(blobSource),
      sourceKind: source.sourceKind,
      resolvedHandleId: source.resolvedHandleId ?? null,
      reconnectRecommended: false,
    }
  }

  const handleCandidates = buildHandleCandidates(record)
  const reconnectRecommended = await shouldRecommendReconnect(handleCandidates)
  return {
    objectUrl: null,
    sourceKind: null,
    reconnectRecommended,
    message: buildMissingMessage(record, reconnectRecommended),
  }
}

export async function resolveMediaFileForRecord(
  record: MediaRecordShape,
  options?: { requestPermission?: boolean; skipCache?: boolean },
): Promise<MediaFileResolution> {
  const source = await resolveMediaSource(record, options)

  if (source) {
    // For cache hits, apply content type to file if missing
    let file = source.file
    if (source.sourceKind === 'workspace-cache' && !file.type && source.cacheContentType) {
      const mediaKey = asText(record.media_key)
      file = new File(
        [file],
        file.name || (asText(record.media_filename) || `${mediaKey || 'media'}.bin`),
        { type: source.cacheContentType, lastModified: file.lastModified },
      )
    }
    return {
      file,
      sourceKind: source.sourceKind,
      resolvedHandleId: source.resolvedHandleId ?? null,
      reconnectRecommended: false,
    }
  }

  const handleCandidates = buildHandleCandidates(record)
  const reconnectRecommended = await shouldRecommendReconnect(handleCandidates)
  return {
    file: null,
    sourceKind: null,
    reconnectRecommended,
    message: buildMissingMessage(record, reconnectRecommended),
  }
}

// ─── Tauri helper ─────────────────────────────────────────────────────────

/** Convert a workspace-relative path to an asset:// URL for direct streaming. */
async function tauriConvertFileSrc(workspaceRelPath: string): Promise<string | null> {
  try {
    const fs = await getPlatformFS()
    const basePath = fs.getWorkspaceBasePath()
    if (!basePath) return null

    const { sep } = await import('@tauri-apps/api/path')
    const s = typeof sep === 'function' ? (sep as () => string)() : sep
    const absolutePath = basePath + s + workspaceRelPath.split('/').filter(Boolean).join(s)

    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(absolutePath)
  } catch {
    return null
  }
}
