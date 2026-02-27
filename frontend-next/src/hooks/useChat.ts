import { useCallback, useRef, useState } from 'react'
import { streamChat, type ChatMessage, type ChatFilters, type CitationData, type SSEEvent } from '@/lib/chatApi'
import { getPlatformFS } from '@/lib/platform'

export interface ChatUIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: CitationData[]
  toolActivity?: string
}

interface UseChatReturn {
  messages: ChatUIMessage[]
  isStreaming: boolean
  error: string | null
  tokenUsage: { input: number; output: number } | null
  sendMessage: (text: string, caseId: string, filters?: ChatFilters) => void
  cancelStream: () => void
  clearMessages: () => void
  setMessages: React.Dispatch<React.SetStateAction<ChatUIMessage[]>>
}

let msgIdCounter = 0
function nextId() {
  return `msg-${++msgIdCounter}-${Date.now()}`
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatUIMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const cancelStream = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    setError(null)
    setTokenUsage(null)
  }, [])

  const sendMessage = useCallback(
    async (text: string, caseId: string, filters?: ChatFilters) => {
      if (!text.trim() || isStreaming) return

      setError(null)

      // Get workspace path
      const fs = await getPlatformFS()
      const workspacePath = fs.getWorkspaceBasePath()
      if (!workspacePath) {
        setError('No workspace configured. Please set up a workspace first.')
        return
      }

      // Add user message
      const userMsg: ChatUIMessage = { id: nextId(), role: 'user', content: text }
      const assistantMsg: ChatUIMessage = { id: nextId(), role: 'assistant', content: '', citations: [], toolActivity: undefined }

      setMessages((prev) => [...prev, userMsg, assistantMsg])
      setIsStreaming(true)

      // Build API messages from history
      const apiMessages: ChatMessage[] = []
      // Include existing messages + the new user message
      setMessages((prev) => {
        for (const m of prev) {
          if (m.role === 'user' || (m.role === 'assistant' && m.content)) {
            apiMessages.push({ role: m.role, content: m.content })
          }
        }
        return prev
      })
      // Ensure the new user message is included
      if (!apiMessages.length || apiMessages[apiMessages.length - 1].content !== text) {
        apiMessages.push({ role: 'user', content: text })
      }

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const stream = streamChat(
          {
            messages: apiMessages,
            case_id: caseId,
            filters,
          },
          workspacePath,
          controller.signal,
        )

        const reader = stream.getReader()
        const citations: CitationData[] = []

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const event: SSEEvent = value

          switch (event.type) {
            case 'token':
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + (event.data.text as string), toolActivity: undefined }
                    : m,
                ),
              )
              break

            case 'tool_use':
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, toolActivity: `Using ${event.data.tool as string}...` }
                    : m,
                ),
              )
              break

            case 'citation':
              citations.push(event.data as unknown as CitationData)
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...m, citations: [...citations] } : m,
                ),
              )
              break

            case 'done':
              setTokenUsage({
                input: (event.data.input_tokens as number) || 0,
                output: (event.data.output_tokens as number) || 0,
              })
              break

            case 'error':
              setError((event.data.message as string) || 'An error occurred')
              break
          }
        }

        // Clear tool activity on completion
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, toolActivity: undefined } : m,
          ),
        )
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message || 'Stream failed')
        }
      } finally {
        setIsStreaming(false)
        abortRef.current = null
      }
    },
    [isStreaming],
  )

  return {
    messages,
    isStreaming,
    error,
    tokenUsage,
    sendMessage,
    cancelStream,
    clearMessages,
    setMessages,
  }
}
