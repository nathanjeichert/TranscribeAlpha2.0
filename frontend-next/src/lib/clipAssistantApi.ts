import { apiUrl, getPlatformApiHeaders } from './platform/api'

export interface ClipAssistantLine {
  id: string
  page?: number | null
  line?: number | null
  pgln?: number | null
  start: number
  end: number
  speaker: string
  text: string
}

export interface ClipAssistantRequest {
  media_key: string
  case_id?: string | null
  transcript_title?: string
  media_duration: number
  selected_line_id?: string | null
  user_request: string
  lines: ClipAssistantLine[]
}

export type ClipAssistantResponse =
  | {
      status: 'draft'
      draft: {
        name: string
        start_line_id: string
        end_line_id: string
        rationale: string
        confidence: 'low' | 'medium' | 'high'
        warnings?: string[]
      }
    }
  | {
      status: 'needs_clarification'
      message: string
    }

export async function requestClipAssistant(params: ClipAssistantRequest): Promise<ClipAssistantResponse> {
  const headers = await getPlatformApiHeaders({ 'Content-Type': 'application/json' })
  const resp = await fetch(apiUrl('/api/clip-assistant'), {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })

  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}))
    throw new Error(detail?.detail || `Clip Assistant failed: ${resp.status}`)
  }

  return resp.json()
}
