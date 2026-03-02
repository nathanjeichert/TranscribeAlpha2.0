import type { TranscriptData } from '@/lib/storage'

export const SEARCH_TOLERANCE = 0.05
export const SPEAKER_LINE_PATTERN = /^(\s*)([A-Z][A-Z0-9 .,'"&/()-]*:)(\s*)(.*)$/

export interface ViewerLine {
  id: string
  speaker: string
  text: string
  rendered_text?: string
  start: number
  end: number
  page?: number | null
  line?: number | null
  pgln?: number | null
  is_continuation?: boolean
}

export interface ViewerTranscript extends TranscriptData {
  media_key: string
  title_data: Record<string, string>
  lines: ViewerLine[]
  audio_duration: number
  lines_per_page: number
  case_id?: string | null
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function formatRange(start: number, end: number): string {
  return `${formatClock(start)} - ${formatClock(end)}`
}

export function parseTimeInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const parts = trimmed.split(':').map((part) => part.trim())
  if (parts.some((part) => !part.length)) return null

  const numeric = parts.map((part) => Number(part))
  if (numeric.some((part) => Number.isNaN(part))) return null

  if (numeric.length === 1) return numeric[0]
  if (numeric.length === 2) return numeric[0] * 60 + numeric[1]
  if (numeric.length === 3) return numeric[0] * 3600 + numeric[1] * 60 + numeric[2]
  return null
}

export function escapeScriptBoundary(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script')
}

export function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  return cleaned || 'item'
}

export function sanitizeDownloadStem(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'transcript'
}

export function normalizeSpeakerToken(speaker: string): string {
  return speaker.trim().replace(/:+$/, '').toUpperCase()
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function buildLineText(line: ViewerLine): string {
  const rendered = typeof line.rendered_text === 'string' ? line.rendered_text : ''
  if (rendered.trim()) return rendered

  const base = typeof line.text === 'string' ? line.text : ''
  const speaker = normalizeSpeakerToken(line.speaker || '')
  if (!line.is_continuation && speaker && base.trim()) {
    const compact = collapseWhitespace(base).toUpperCase()
    if (!compact.startsWith(`${speaker}:`)) {
      return `          ${speaker}:   ${base}`
    }
  }
  return base
}

export function splitSpeakerPrefix(line: ViewerLine): {
  lineText: string
  leading: string
  speakerLabel: string | null
  trailing: string
} {
  const lineText = buildLineText(line)
  if (!lineText) return { lineText, leading: '', speakerLabel: null, trailing: '' }
  if (line.is_continuation) return { lineText, leading: '', speakerLabel: null, trailing: '' }
  const match = lineText.match(SPEAKER_LINE_PATTERN)
  if (!match) return { lineText, leading: '', speakerLabel: null, trailing: '' }
  return {
    lineText,
    leading: match[1] || '',
    speakerLabel: match[2] || null,
    trailing: `${match[3] || ''}${match[4] || ''}`,
  }
}

export function captionTextForLine(line: ViewerLine | null | undefined): string {
  if (!line) return ''
  const baseText = collapseWhitespace(line.text || line.rendered_text || '')
  if (!baseText) return ''

  const speaker = normalizeSpeakerToken(line.speaker || '')
  if (!line.is_continuation && speaker) {
    if (baseText.toUpperCase().startsWith(`${speaker}:`)) return baseText
    return `${speaker}: ${baseText}`
  }

  return baseText
}

export function normalizeViewerTranscript(raw: TranscriptData, fallbackMediaKey: string): ViewerTranscript {
  const rawLines = Array.isArray(raw.lines) ? raw.lines : []
  const lines: ViewerLine[] = rawLines
    .map((entry, index) => {
      const lineObj = (entry || {}) as Record<string, unknown>
      const start = Number(lineObj.start)
      const end = Number(lineObj.end)
      const page = Number(lineObj.page)
      const lineNum = Number(lineObj.line)
      const pgln = Number(lineObj.pgln)
      return {
        id: String(lineObj.id || `line-${index}`),
        speaker: String(lineObj.speaker || ''),
        text: String(lineObj.text || ''),
        rendered_text: typeof lineObj.rendered_text === 'string' ? lineObj.rendered_text : undefined,
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : Number.isFinite(start) ? start : 0,
        page: Number.isFinite(page) ? page : null,
        line: Number.isFinite(lineNum) ? lineNum : null,
        pgln: Number.isFinite(pgln) ? pgln : null,
        is_continuation: Boolean(lineObj.is_continuation),
      }
    })
    .sort((a, b) => a.start - b.start)

  return {
    ...raw,
    media_key: String(raw.media_key || fallbackMediaKey),
    title_data: raw.title_data || {},
    lines,
    audio_duration: Number(raw.audio_duration || 0),
    lines_per_page: Number(raw.lines_per_page || 25),
  }
}

export interface ViewerPayloadLine {
  id: string
  speaker: string
  text: string
  rendered_text: string
  start: number
  end: number
  page_number: number
  line_number: number
  pgln: number
  is_continuation: boolean
}

export interface ViewerPayloadPage {
  page_number: number
  line_indexes: number[]
  pgln_start: number
  pgln_end: number
}

export interface ViewerPayload {
  meta: {
    title: Record<string, string>
    duration_seconds: number
    lines_per_page: number
    speakers: string[]
  }
  media: {
    filename: string
    content_type: string
    relative_path: string
  }
  lines: ViewerPayloadLine[]
  pages: ViewerPayloadPage[]
}

export interface ViewerPayloadInput {
  lines: Array<{
    id: string
    speaker: string
    text: string
    rendered_text?: string | null
    start: number
    end: number
    page?: number | null
    line?: number | null
    pgln?: number | null
    is_continuation?: boolean
  }>
  title_data: Record<string, string>
  audio_duration: number
  lines_per_page: number
  media_filename?: string | null
  media_content_type?: string | null
}

export function buildViewerPayload(input: ViewerPayloadInput): ViewerPayload {
  const { lines, title_data, audio_duration, lines_per_page, media_filename, media_content_type } = input
  const safeLinesPerPage = lines_per_page > 0 ? lines_per_page : 25

  const speakers = Array.from(
    new Set(
      lines
        .map((line) => line.speaker)
        .filter((speaker): speaker is string => Boolean(speaker && speaker.trim().length > 0)),
    ),
  )

  const normalizedLines: ViewerPayloadLine[] = lines.map((line, index) => {
    const pageRaw = Number(line.page)
    const lineRaw = Number(line.line)
    const pglnRaw = Number(line.pgln)
    const page_number = Number.isFinite(pageRaw) && pageRaw > 0
      ? pageRaw
      : Math.floor(index / safeLinesPerPage) + 1
    const line_number = Number.isFinite(lineRaw) && lineRaw > 0
      ? lineRaw
      : (index % safeLinesPerPage) + 1
    const pgln = Number.isFinite(pglnRaw) && pglnRaw > 0
      ? pglnRaw
      : (page_number * 100) + line_number
    const startVal = Number.isFinite(line.start) ? line.start : 0
    return {
      id: line.id,
      speaker: line.speaker || '',
      text: line.text || '',
      rendered_text: line.rendered_text || line.text || '',
      start: startVal,
      end: Number.isFinite(line.end) ? line.end : startVal,
      page_number,
      line_number,
      pgln,
      is_continuation: Boolean(line.is_continuation),
    }
  })

  const pageMap = new Map<number, number[]>()
  normalizedLines.forEach((line, idx) => {
    if (!pageMap.has(line.page_number)) pageMap.set(line.page_number, [])
    pageMap.get(line.page_number)?.push(idx)
  })

  const pages: ViewerPayloadPage[] = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([pageNum, lineIndexes]) => ({
      page_number: pageNum,
      line_indexes: lineIndexes,
      pgln_start: lineIndexes.length ? normalizedLines[lineIndexes[0]].pgln : 101,
      pgln_end: lineIndexes.length ? normalizedLines[lineIndexes[lineIndexes.length - 1]].pgln : 101,
    }))

  const filename = media_filename || title_data?.FILE_NAME || 'media.mp4'

  return {
    meta: {
      title: title_data || {},
      duration_seconds: Number.isFinite(audio_duration) ? audio_duration : 0,
      lines_per_page: safeLinesPerPage,
      speakers,
    },
    media: {
      filename,
      content_type: media_content_type || 'video/mp4',
      relative_path: filename,
    },
    lines: normalizedLines,
    pages,
  }
}
