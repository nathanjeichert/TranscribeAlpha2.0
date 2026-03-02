import { EditorLine } from './editorTypes'

export const AUTO_SHIFT_STORAGE_KEY = 'editor_auto_shift_next'
export const AUTO_SHIFT_PADDING_SECONDS = 0.01

export function secondsToLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00.000'
  }
  const wholeSeconds = Math.floor(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainingSeconds = wholeSeconds % 60
  const millis = Math.floor((seconds - wholeSeconds) * 1000)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${millis
    .toString()
    .padStart(3, '0')}`
}

export function buildRenderedText(line: Pick<EditorLine, 'speaker' | 'text' | 'is_continuation'>): string {
  const speaker = (line.speaker || '').trim().replace(/:+$/, '')
  const text = line.text || ''
  if (line.is_continuation) return text
  if (!speaker) return text
  const compact = text.trimStart().toUpperCase()
  if (compact.startsWith(`${speaker.toUpperCase()}:`)) {
    return text
  }
  return `          ${speaker}:   ${text}`
}

export function normalizeLineEntriesForArtifacts(lineEntries: EditorLine[], linesPerPage: number): EditorLine[] {
  const safeLinesPerPage = linesPerPage > 0 ? linesPerPage : 25
  return lineEntries.map((line, index) => {
    const pageNumber = Number.isFinite(line.page as number)
      ? Number(line.page)
      : Math.floor(index / safeLinesPerPage) + 1
    const lineNumber = Number.isFinite(line.line as number)
      ? Number(line.line)
      : (index % safeLinesPerPage) + 1
    const start = Number.isFinite(line.start) ? Number(line.start) : 0
    const rawEnd = Number.isFinite(line.end) ? Number(line.end) : start
    return {
      ...line,
      id: line.id || `line-${index}`,
      speaker: line.speaker || '',
      text: line.text || '',
      rendered_text: buildRenderedText(line),
      start,
      end: rawEnd >= start ? rawEnd : start,
      page: pageNumber,
      line: lineNumber,
      pgln: Number.isFinite(line.pgln as number) ? Number(line.pgln) : (pageNumber * 100) + lineNumber,
      is_continuation: Boolean(line.is_continuation),
    }
  })
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildOncueXmlFromLineEntries(
  lineEntries: EditorLine[],
  titleData: Record<string, string>,
  audioDuration: number,
  linesPerPage: number,
): string {
  const filename = (titleData.FILE_NAME || 'audio.mp3').trim() || 'audio.mp3'
  const mediaId =
    (titleData.MEDIA_ID || '').trim() ||
    filename.replace(/\.[^/.]+$/, '') ||
    'deposition'
  const dateAttr = titleData.DATE ? ` date="${escapeXmlAttribute(titleData.DATE)}"` : ''
  const sortedEntries = [...lineEntries].sort((a, b) => {
    const pageA = Number(a.page ?? 1)
    const pageB = Number(b.page ?? 1)
    if (pageA !== pageB) return pageA - pageB
    const lineA = Number(a.line ?? 1)
    const lineB = Number(b.line ?? 1)
    return lineA - lineB
  })
  const lastPgln = sortedEntries.length
    ? Number(sortedEntries[sortedEntries.length - 1].pgln ?? 101)
    : 101

  const parts: string[] = []
  parts.push('<onCue xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
  parts.push(
    `<deposition mediaId="${escapeXmlAttribute(mediaId)}" linesPerPage="${Math.max(1, linesPerPage)}"${dateAttr}>`,
  )
  parts.push(
    `<depoVideo ID="1" filename="${escapeXmlAttribute(filename)}" startTime="0" stopTime="${Math.round(
      Math.max(0, audioDuration),
    )}" firstPGLN="101" lastPGLN="${lastPgln}" startTuned="no" stopTuned="no">`,
  )

  for (const entry of sortedEntries) {
    const page = Number(entry.page ?? 1)
    const line = Number(entry.line ?? 1)
    const pgln = Number(entry.pgln ?? (page * 100) + line)
    const start = Number(entry.start ?? 0)
    const end = Number(entry.end ?? start)
    const rendered = entry.rendered_text || buildRenderedText(entry)
    parts.push(
      `<depoLine prefix="" text="${escapeXmlAttribute(rendered)}" page="${page}" line="${line}" pgLN="${pgln}" videoID="1" videoStart="${start.toFixed(
        2,
      )}" videoStop="${end.toFixed(2)}" isEdited="no" isSynched="yes" isRedacted="no" />`,
    )
  }

  parts.push('</depoVideo></deposition></onCue>')
  return parts.join('')
}
