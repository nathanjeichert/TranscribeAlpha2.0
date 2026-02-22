import { touchMediaCacheEntry } from './mediaCache'
import {
  getFirstAvailableMediaFile,
  getFirstAvailableMediaObjectURL,
  getMediaHandlePermissionState,
} from './mediaHandles'
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

export async function resolveMediaObjectURLForRecord(
  record: MediaRecordShape,
  options?: { requestPermission?: boolean },
): Promise<MediaResolution> {
  const mediaKey = asText(record.media_key)
  const workspacePath = asText(record.media_workspace_relpath)
  if (workspacePath) {
    const workspaceFile = await readWorkspaceRelativeFile(workspacePath)
    if (workspaceFile) {
      if (mediaKey) {
        await touchMediaCacheEntry(mediaKey)
      }
      return {
        objectUrl: URL.createObjectURL(workspaceFile),
        sourceKind: 'workspace-relative',
        reconnectRecommended: false,
      }
    }
  }

  const cachePath = asText(record.playback_cache_path)
  const cacheContentType = asText(record.playback_cache_content_type)
  if (cachePath) {
    const cachedFile = await readWorkspaceRelativeFile(cachePath)
    if (cachedFile) {
      if (mediaKey) {
        await touchMediaCacheEntry(mediaKey)
      }
      const playbackBlob = cacheContentType
        ? new Blob([cachedFile], { type: cacheContentType })
        : cachedFile
      return {
        objectUrl: URL.createObjectURL(playbackBlob),
        sourceKind: 'workspace-cache',
        reconnectRecommended: false,
      }
    }
  }

  const handleCandidates = buildHandleCandidates(record)
  const external = await getFirstAvailableMediaObjectURL(handleCandidates, {
    requestPermission: Boolean(options?.requestPermission),
  })
  if (external) {
    if (mediaKey) {
      await touchMediaCacheEntry(mediaKey)
    }
    return {
      objectUrl: external.objectUrl,
      sourceKind: 'external-handle',
      resolvedHandleId: external.sourceId,
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
  const mediaKey = asText(record.media_key)
  const workspacePath = asText(record.media_workspace_relpath)
  if (workspacePath) {
    const workspaceFile = await readWorkspaceRelativeFile(workspacePath)
    if (workspaceFile) {
      if (mediaKey) {
        await touchMediaCacheEntry(mediaKey)
      }
      return {
        file: workspaceFile,
        sourceKind: 'workspace-relative',
        reconnectRecommended: false,
      }
    }
  }

  if (!options?.skipCache) {
    const cachePath = asText(record.playback_cache_path)
    const cacheContentType = asText(record.playback_cache_content_type)
    if (cachePath) {
      const cachedFile = await readWorkspaceRelativeFile(cachePath)
      if (cachedFile) {
        if (mediaKey) {
          await touchMediaCacheEntry(mediaKey)
        }
        const playbackFile = !cachedFile.type && cacheContentType
          ? new File([cachedFile], cachedFile.name || (asText(record.media_filename) || `${mediaKey || 'media'}.bin`), {
              type: cacheContentType,
              lastModified: cachedFile.lastModified,
            })
          : cachedFile
        return {
          file: playbackFile,
          sourceKind: 'workspace-cache',
          reconnectRecommended: false,
        }
      }
    }
  }

  const handleCandidates = buildHandleCandidates(record)
  const external = await getFirstAvailableMediaFile(handleCandidates, {
    requestPermission: Boolean(options?.requestPermission),
  })
  if (external) {
    if (mediaKey) {
      await touchMediaCacheEntry(mediaKey)
    }
    return {
      file: external.file,
      sourceKind: 'external-handle',
      resolvedHandleId: external.sourceId,
      reconnectRecommended: false,
    }
  }

  const reconnectRecommended = await shouldRecommendReconnect(handleCandidates)
  return {
    file: null,
    sourceKind: null,
    reconnectRecommended,
    message: buildMissingMessage(record, reconnectRecommended),
  }
}
