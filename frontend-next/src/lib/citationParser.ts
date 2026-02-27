/**
 * Parses [[CITE: media_key=... line_id=... snippet="..."]] markers
 * from agent text into structured citation objects and text segments.
 */

export interface ParsedCitation {
  media_key: string
  line_id: string
  snippet: string
}

export type TextSegment =
  | { type: 'text'; content: string }
  | { type: 'citation'; citation: ParsedCitation }

const CITE_REGEX = /\[\[CITE:\s*media_key=(\S+)\s+line_id=(\S+)\s+snippet="((?:[^"\\]|\\.)*)"\]\]/g

/**
 * Split agent text into alternating text and citation segments.
 */
export function splitTextAndCitations(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(CITE_REGEX)) {
    const matchIndex = match.index!
    // Add text before this citation
    if (matchIndex > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, matchIndex) })
    }

    segments.push({
      type: 'citation',
      citation: {
        media_key: match[1],
        line_id: match[2],
        snippet: match[3],
      },
    })

    lastIndex = matchIndex + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return segments
}
