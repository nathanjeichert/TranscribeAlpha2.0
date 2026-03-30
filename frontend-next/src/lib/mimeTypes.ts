export const MEDIA_MIME_MAP: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
  ogg: 'audio/ogg', aac: 'audio/aac', wma: 'audio/x-ms-wma', webm: 'video/webm',
}

export function mimeForFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return MEDIA_MIME_MAP[ext] || 'application/octet-stream'
}
