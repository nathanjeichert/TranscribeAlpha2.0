import { useCallback, useEffect, useRef, useState } from 'react'
import { readJSON, writeJSON } from '@/lib/storage'
import { logger } from '@/utils/logger'

export interface ConversationRecord {
  id: string
  title: string
  created_at: string
  updated_at: string
  messages: Array<{ id: string; role: string; content: string; citations?: unknown[] }>
}

interface ChatHistoryData {
  conversations: ConversationRecord[]
}

function newConversationId() {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function historyPath(caseId: string) {
  return `cases/${caseId}/chat_history.json`
}

export function useChatHistory(caseId: string) {
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string>('')
  const loadedRef = useRef(false)

  // Load history from workspace (reset conversation state on case switch)
  useEffect(() => {
    if (!caseId) return
    loadedRef.current = false
    setActiveConversationId('')

    readJSON<ChatHistoryData>(historyPath(caseId))
      .then((data) => {
        if (data?.conversations) {
          setConversations(data.conversations)
        } else {
          setConversations([])
        }
        loadedRef.current = true
      })
      .catch((err) => {
        logger.warn('Failed to load chat history:', err)
        setConversations([])
        loadedRef.current = true
      })
  }, [caseId])

  // Create new conversation
  const createConversation = useCallback(() => {
    const id = newConversationId()
    setActiveConversationId(id)
    return id
  }, [])

  // Initialize with a new conversation if none active
  useEffect(() => {
    if (!activeConversationId) {
      createConversation()
    }
  }, [activeConversationId, createConversation])

  // Load a past conversation
  const loadConversation = useCallback(
    (convId: string) => {
      const conv = conversations.find((c) => c.id === convId)
      if (conv) {
        setActiveConversationId(conv.id)
        return conv
      }
      return null
    },
    [conversations],
  )

  // Save/update a conversation
  const saveConversation = useCallback(
    async (convId: string, messages: Array<{ id: string; role: string; content: string; citations?: unknown[] }>) => {
      if (!caseId || !convId || messages.length === 0) return

      const now = new Date().toISOString()
      const firstUserMsg = messages.find((m) => m.role === 'user')
      const title = firstUserMsg
        ? firstUserMsg.content.slice(0, 60) + (firstUserMsg.content.length > 60 ? '...' : '')
        : 'New conversation'

      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === convId)
        const record: ConversationRecord = {
          id: convId,
          title,
          created_at: idx >= 0 ? prev[idx].created_at : now,
          updated_at: now,
          messages,
        }

        let updated: ConversationRecord[]
        if (idx >= 0) {
          updated = [...prev]
          updated[idx] = record
        } else {
          updated = [record, ...prev]
        }

        // Sort by most recent
        updated.sort((a, b) => b.updated_at.localeCompare(a.updated_at))

        // Persist to disk (fire and forget)
        writeJSON(historyPath(caseId), { conversations: updated }).catch((err) =>
          logger.warn('Failed to save chat history:', err),
        )

        return updated
      })
    },
    [caseId],
  )

  // Delete a conversation
  const deleteConversation = useCallback(
    async (convId: string) => {
      setConversations((prev) => {
        const updated = prev.filter((c) => c.id !== convId)
        writeJSON(historyPath(caseId), { conversations: updated }).catch((err) =>
          logger.warn('Failed to save chat history:', err),
        )
        return updated
      })
    },
    [caseId],
  )

  return {
    conversations,
    activeConversationId,
    createConversation,
    loadConversation,
    saveConversation,
    deleteConversation,
  }
}
