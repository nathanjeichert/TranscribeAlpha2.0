import { mimeForFilename } from '../mimeTypes'
import { storeMediaPath } from '../mediaHandles'
import type { PlatformMedia } from './types'

export const tauriMediaAdapter: PlatformMedia = {
  async pickMediaFiles() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { stat, open: fsOpen } = await import('@tauri-apps/plugin-fs')
    const selected = await open({
      title: 'Choose audio or video files',
      filters: [
        { name: 'Audio/Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'webm'] },
      ],
      multiple: true,
    })
    if (!selected) return []

    const paths = Array.isArray(selected) ? selected : [selected]
    const results: Array<{ file: File; handleId: string; filename: string; fileSizeBytes: number }> = []

    for (const raw of paths) {
      const filePath = typeof raw === 'string' ? raw : (raw as any).path ?? String(raw)
      const filename = filePath.split(/[\\/]/).pop() || 'media.bin'
      const contentType = mimeForFilename(filename)
      const handleId = crypto.randomUUID()

      const fileStat = await stat(filePath)
      const fileSizeBytes = fileStat.size
      const HEADER_BYTES = 4096
      let headerData: Uint8Array<ArrayBuffer>
      try {
        const fh = await fsOpen(filePath, { read: true })
        const buf = new Uint8Array(HEADER_BYTES)
        const bytesRead = await fh.read(buf)
        headerData = bytesRead !== null && bytesRead !== undefined ? buf.slice(0, Number(bytesRead)) as Uint8Array<ArrayBuffer> : buf
        await fh.close()
      } catch {
        headerData = new Uint8Array(0) as Uint8Array<ArrayBuffer>
      }
      const file = new File([headerData], filename, { type: contentType })

      await storeMediaPath(handleId, filePath, filename)
      results.push({ file, handleId, filename, fileSizeBytes })
    }

    return results
  },

  async promptRelinkMedia(expectedFilename, preferredHandleId) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      title: `Locate: ${expectedFilename}`,
      filters: [
        { name: 'Audio/Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'webm'] },
      ],
      multiple: false,
    })
    if (!selected) return null
    const filePath = typeof selected === 'string' ? selected : (selected as any).path ?? String(selected)
    const filename = filePath.split(/[\\/]/).pop() || expectedFilename
    const handleId = String(preferredHandleId || '').trim() || crypto.randomUUID()
    await storeMediaPath(handleId, filePath, filename)
    return { handleId }
  },

  async getPlaybackURL(sourceId) {
    const { idbGet } = await import('../idb')
    const ref = await idbGet<any>('media-handles', sourceId)
    if (!ref || typeof ref !== 'object' || !('__tauriPath' in ref)) return null
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(ref.__tauriPath)
  },

  async readFileFromPath(absolutePath, filename) {
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(absolutePath)
      const type = mimeForFilename(filename)
      return new File([bytes], filename, { type })
    } catch {
      return null
    }
  },

  async readAbsolutePathAsObjectURL(absolutePath, filename, fallbackContentType) {
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(absolutePath)
      const mime = mimeForFilename(filename)
      const type = mime !== 'application/octet-stream' ? mime : fallbackContentType || 'application/octet-stream'
      const blob = new Blob([bytes], { type })
      return URL.createObjectURL(blob)
    } catch {
      return null
    }
  },

  async downloadFile(blob, filename) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeFile } = await import('@tauri-apps/plugin-fs')

    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : ''
    const filters = ext
      ? [{ name: ext.toUpperCase(), extensions: [ext] }]
      : []

    const path = await save({ defaultPath: filename, filters })
    if (!path) return

    const bytes = new Uint8Array(await blob.arrayBuffer())
    await writeFile(path, bytes)
  },
}
