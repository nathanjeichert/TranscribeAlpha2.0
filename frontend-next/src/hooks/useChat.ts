import { useCallback, useEffect, useRef, useState } from 'react'
import { streamChat, type ChatMessage, type ChatFilters, type CitationData, type SSEEvent } from '@/lib/chatApi'
import { getPlatformFS } from '@/lib/platform'

export interface ChatUIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Display-only content (e.g., without injected transcript context). Falls back to content. */
  displayContent?: string
  citations?: CitationData[]
  toolActivity?: string
  /** Compact summary of tools called during this turn (for multi-turn context). */
  toolHistory?: string[]
}

interface UseChatReturn {
  messages: ChatUIMessage[]
  isStreaming: boolean
  error: string | null
  tokenUsage: { input: number; output: number } | null
  sendMessage: (text: string, caseId: string, filters?: ChatFilters, displayText?: string) => void
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
  const apiMessagesRef = useRef<ChatMessage[]>([])
  // Keep a ref to messages so sendMessage can read latest without being in the dep array
  const messagesRef = useRef(messages)
  useEffect(() => { messagesRef.current = messages }, [messages])

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

  /** Helper to update the current assistant message fields. */
  const updateAssistant = (msgId: string, updates: Partial<ChatUIMessage>) =>
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, ...updates } : m)))

  /** Remove empty assistant placeholder and clear spinner. */
  const cleanupPlaceholder = (msgId: string) =>
    setMessages((prev) =>
      prev
        .filter((m) => m.id !== msgId || m.content !== '')
        .map((m) => (m.id === msgId ? { ...m, toolActivity: undefined } : m)),
    )

  const sendMessage = useCallback(
    async (text: string, caseId: string, filters?: ChatFilters, displayText?: string) => {
      if (!text.trim() || isStreaming) return

      setError(null)

      // Get workspace path
      const fs = await getPlatformFS()
      const workspacePath = fs.getWorkspaceBasePath()
      if (!workspacePath) {
        setError('No workspace configured. Please set up a workspace first.')
        return
      }

      // Add user message — displayContent shows only the user's question, content includes context
      const userMsg: ChatUIMessage = { id: nextId(), role: 'user', content: text, displayContent: displayText }
      const assistantMsg: ChatUIMessage = { id: nextId(), role: 'assistant', content: '', citations: [], toolActivity: undefined }

      // Build API messages from ref (avoids messages in dep array → no recreation on every token)
      const currentMessages = [...messagesRef.current, userMsg]
      apiMessagesRef.current = currentMessages
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map((m) => {
          if (m.role === 'assistant' && m.toolHistory?.length) {
            const toolNote = `\n\n[Previous tool calls: ${m.toolHistory.join(', ')}]`
            return { role: m.role, content: m.content + toolNote }
          }
          return { role: m.role, content: m.content }
        })

      setMessages((prev) => [...prev, userMsg, assistantMsg])
      setIsStreaming(true)

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const stream = streamChat(
          {
            messages: apiMessagesRef.current,
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
            case 'new_turn':
              // New agentic iteration after tool use — clear accumulated text
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: '', toolActivity: undefined }
                    : m,
                ),
              )
              break

            case 'token': {
              const text = (event.data.text as string) ?? ''
              if (!text) break
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + text, toolActivity: undefined }
                    : m,
                ),
              )
              break
            }

            case 'tool_use':
              updateAssistant(assistantMsg.id, { toolActivity: `Searching transcripts...` })
              break

            case 'citation':
              citations.push(event.data as unknown as CitationData)
              updateAssistant(assistantMsg.id, { citations: [...citations] })
              break

            case 'done': {
              setTokenUsage((prev) => ({
                input: (prev?.input || 0) + ((event.data.input_tokens as number) || 0),
                output: (prev?.output || 0) + ((event.data.output_tokens as number) || 0),
              }))
              const toolHist = event.data.tool_history as string[] | undefined
              if (toolHist?.length) {
                updateAssistant(assistantMsg.id, { toolHistory: toolHist })
              }
              break
            }

            case 'error':
              setError((event.data.message as string) || 'An error occurred')
              cleanupPlaceholder(assistantMsg.id)
              break
          }
        }

        // Clear tool activity on completion
        updateAssistant(assistantMsg.id, { toolActivity: undefined })
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message || 'Stream failed')
        }
        cleanupPlaceholder(assistantMsg.id)
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
