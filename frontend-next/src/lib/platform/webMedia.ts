import { storeMediaHandle } from '../mediaHandles'
import type { PlatformMedia } from './types'

export const webMediaAdapter: PlatformMedia = {
  async pickMediaFiles() {
    const handles: FileSystemFileHandle[] = await window.showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: 'Audio/Video files',
          accept: {
            'audio/*': ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac', '.wma'],
            'video/*': ['.mp4', '.mov', '.avi', '.mkv'],
          },
        },
      ],
    })
    if (!handles.length) return []

    const results: Array<{ file: File; handleId: string; filename: string; fileSizeBytes: number; fileHandle: FileSystemFileHandle }> = []
    for (const handle of handles) {
      const file = await handle.getFile()
      const handleId = crypto.randomUUID()
      await storeMediaHandle(handleId, handle)
      results.push({ file, handleId, filename: file.name, fileSizeBytes: file.size, fileHandle: handle })
    }
    return results
  },

  async promptRelinkMedia(expectedFilename, preferredHandleId) {
    const [handle] = await window.showOpenFilePicker({
      types: [
        {
          description: `Locate: ${expectedFilename}`,
          accept: {
            'audio/*': [],
            'video/*': [],
          },
        },
      ],
      multiple: false,
    })
    if (!handle) return null
    const handleId = String(preferredHandleId || '').trim() || crypto.randomUUID()
    await storeMediaHandle(handleId, handle)
    return { handleId }
  },

  async getPlaybackURL() {
    return null
  },

  async readAbsolutePathAsObjectURL() {
    return null
  },

  async readFileFromPath() {
    return null
  },

  async downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  },
}
