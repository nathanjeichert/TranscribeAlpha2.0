export interface ViewerLinePayload {
  id: string
  speaker: string
  text: string
  rendered_text: string
  start: number
  end: number
  page_number: number
  line_number: number
  pgln?: number | null
  is_continuation: boolean
}

export interface ViewerPagePayload {
  page_number: number
  line_indexes: number[]
  pgln_start?: number | null
  pgln_end?: number | null
}

export interface ViewerPayload {
  meta?: {
    title?: Record<string, string>
    duration_seconds?: number
    lines_per_page?: number
    speakers?: string[]
  }
  media?: {
    filename?: string
    content_type?: string
    relative_path?: string
  }
  lines: ViewerLinePayload[]
  pages: ViewerPagePayload[]
  [key: string]: unknown
}
