import { apiUrl } from './platform/api'
import type { EvidenceType } from './storage'

// ─── Summarize ───────────────────────────────────────────────────────

export interface SummarizeResult {
  ai_summary: string
  evidence_type: EvidenceType
}

export async function summarizeTranscript(params: {
  media_key: string
  media_filename: string
  transcript_text: string
}): Promise<SummarizeResult> {
  const resp = await fetch(apiUrl('/api/summarize'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!resp.ok) {
    throw new Error(`Summarize failed: ${resp.status}`)
  }
  return resp.json()
}

// ─── Chat SSE ────────────────────────────────────────────────────────

export interface ChatFilters {
  evidence_types?: EvidenceType[]
  date_from?: string
  date_to?: string
  speakers?: string[]
  location?: string
  transcript_keys?: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  case_id: string
  filters?: ChatFilters
  conversation_id?: string
}

export interface CitationData {
  media_key: string
  line_id: string
  snippet: string
  title?: string
  date?: string
}

export type SSEEventType = 'token' | 'tool_use' | 'citation' | 'done' | 'error'

export interface SSEEvent {
  type: SSEEventType
  data: Record<string, unknown>
}

/**
 * Sends a chat request and returns a ReadableStream of SSE events.
 * The caller is responsible for consuming and closing the stream.
 */
export function streamChat(
  request: ChatRequest,
  workspacePath: string,
  signal?: AbortSignal,
): ReadableStream<SSEEvent> {
  return new ReadableStream<SSEEvent>({
    async start(controller) {
      try {
        const resp = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Workspace-Path': workspacePath,
          },
          body: JSON.stringify(request),
          signal,
        })

        if (!resp.ok) {
          const text = await resp.text().catch(() => resp.statusText)
          controller.enqueue({
            type: 'error',
            data: { message: `HTTP ${resp.status}: ${text}` },
          })
          controller.close()
          return
        }

        const reader = resp.body?.getReader()
        if (!reader) {
          controller.enqueue({ type: 'error', data: { message: 'No response body' } })
          controller.close()
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let currentEventType = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEventType = line.slice(7).trim()
            } else if (line.startsWith('data: ') && currentEventType) {
              try {
                const data = JSON.parse(line.slice(6))
                controller.enqueue({ type: currentEventType as SSEEventType, data })
              } catch {
                // skip malformed JSON
              }
              currentEventType = ''
            } else if (line === '') {
              currentEventType = ''
            }
          }
        }

        controller.close()
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          controller.close()
        } else {
          controller.enqueue({
            type: 'error',
            data: { message: (err as Error).message || 'Stream failed' },
          })
          controller.close()
        }
      }
    },
  })
}
