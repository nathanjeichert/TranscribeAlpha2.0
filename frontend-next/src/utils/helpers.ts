export function nowIso(): string {
  return new Date().toISOString()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export async function downloadFileBlob(file: File): Promise<void> {
  const blob = new Blob([file], { type: file.type })
  await downloadBlob(blob, file.name)
}

export async function downloadBase64(base64Data: string, filename: string, mimeType: string): Promise<void> {
  const byteCharacters = atob(base64Data)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  const byteArray = new Uint8Array(byteNumbers)
  const blob = new Blob([byteArray], { type: mimeType })
  await downloadBlob(blob, filename)
}

export interface TranscriptListItem {
  media_key: string
  title_label: string
  updated_at?: string | null
  line_count?: number
  expires_at?: string | null
}

export function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString()
}

export function formatDuration(seconds?: number): string {
  if (!seconds) return '-'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const { getPlatformMedia } = await import('@/lib/platform')
  const media = await getPlatformMedia()
  await media.downloadFile(blob, filename)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...Array.from(chunk))
  }
  return btoa(binary)
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  return bytesToBase64(new Uint8Array(buffer))
}

export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
}
