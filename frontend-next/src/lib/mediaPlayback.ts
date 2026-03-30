import { touchMediaCacheEntry } from './mediaCache'
import {
  getFirstAvailableMediaFile,
  getMediaFile,
  getMediaHandlePermissionState,
} from './mediaHandles'
import { getPlatformMedia } from './platform'
import { readWorkspaceRelativeFile } from './storage'

export type MediaSourceKind = 'workspace-relative' | 'workspace-cache' | 'external-handle'

export interface MediaRecordShape {
  media_key?: string
  media_handle_id?: string | null
  media_workspace_relpath?: string | null
  media_absolute_path?: string | null
  media_storage_mode?: string | null
  playback_cache_path?: string | null
  playback_cache_content_type?: string | null
  media_filename?: string | null
  media_content_type?: string | null
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
  // Try platform-specific fast paths before the generic resolution pipeline.
  const media = await getPlatformMedia()
  const mediaKey = asText(record.media_key)

  // 1. Try direct playback URL via platform adapter (Tauri: zero-copy streaming).
  const handleCandidates = buildHandleCandidates(record)
  for (const candidate of handleCandidates) {
    try {
      const url = await media.getPlaybackURL(candidate)
      if (url) {
        if (mediaKey) await touchMediaCacheEntry(mediaKey)
        return { objectUrl: url, sourceKind: 'external-handle', reconnectRecommended: false }
      }
    } catch {
      // Fall through
    }
  }

  // 2. Try reading from stored absolute path via platform adapter.
  const absolutePath = asText(record.media_absolute_path)
  if (absolutePath) {
    const filename = asText(record.media_filename) || absolutePath.split(/[\\/]/).pop() || 'media'
    const objectUrl = await media.readAbsolutePathAsObjectURL(
      absolutePath, filename, asText(record.media_content_type),
    )
    if (objectUrl) {
      if (mediaKey) await touchMediaCacheEntry(mediaKey)
      return { objectUrl, sourceKind: 'external-handle', reconnectRecommended: false }
    }
  }

  // 3. IDB handle/path lookup fallback.
  for (const candidate of handleCandidates) {
    const file = await getMediaFile(candidate)
    if (file) {
      if (mediaKey) await touchMediaCacheEntry(mediaKey)
      return { objectUrl: URL.createObjectURL(file), sourceKind: 'external-handle', reconnectRecommended: false }
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

