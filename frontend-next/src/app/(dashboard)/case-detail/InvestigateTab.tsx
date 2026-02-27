'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { routes } from '@/utils/routes'
import { useChat, type ChatUIMessage } from '@/hooks/useChat'
import { useChatHistory } from '@/hooks/useChatHistory'
import { useInvestigateFilters } from '@/hooks/useInvestigateFilters'
import type { ChatFilters } from '@/lib/chatApi'
import type { EvidenceType } from '@/lib/storage'
import ChatMessage from './ChatMessage'
import InvestigateFilterBar from './InvestigateFilterBar'

interface InvestigateTabProps {
  caseId: string
  transcripts: Array<{
    media_key: string
    title_label: string
    evidence_type?: EvidenceType
    ai_summary?: string
    updated_at?: string | null
    speakers?: string[]
    location?: string
  }>
}

const STARTER_QUESTIONS = [
  'What are the key facts across all transcripts in this case?',
  'Are there any contradictions between different witnesses?',
  'Summarize what each speaker said about the incident.',
  'What timeline of events can be established from the transcripts?',
]

export default function InvestigateTab({ caseId, transcripts }: InvestigateTabProps) {
  const {
    messages, isStreaming, error, tokenUsage,
    sendMessage, cancelStream, clearMessages, setMessages,
  } = useChat()

  const {
    conversations, activeConversationId,
    createConversation, loadConversation, saveConversation, deleteConversation,
  } = useChatHistory(caseId)

  const {
    filters, availableEvidenceTypes, availableSpeakers, availableLocations,
    setEvidenceTypes, setDateFrom, setDateTo, setSpeakers, setLocation,
    clearFilters, hasActiveFilters,
  } = useInvestigateFilters(transcripts)

  const [input, setInput] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)

  // Cancel stream on unmount to prevent state updates on unmounted component
  useEffect(() => () => cancelStream(), [cancelStream])

  // Close history dropdown on outside click
  useEffect(() => {
    if (!showHistory) return
    const handleClick = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showHistory])

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Save conversation after assistant response completes
  useEffect(() => {
    if (!isStreaming && messages.length > 0) {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg.role === 'assistant' && lastMsg.content) {
        saveConversation(activeConversationId, messages)
      }
    }
  }, [isStreaming, messages, activeConversationId, saveConversation])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text) return
    setInput('')

    const chatFilters: ChatFilters = {}
    if (filters.evidenceTypes.length > 0) chatFilters.evidence_types = filters.evidenceTypes
    if (filters.dateFrom) chatFilters.date_from = filters.dateFrom
    if (filters.dateTo) chatFilters.date_to = filters.dateTo
    if (filters.speakers.length > 0) chatFilters.speakers = filters.speakers
    if (filters.location) chatFilters.location = filters.location

    sendMessage(text, caseId, Object.keys(chatFilters).length > 0 ? chatFilters : undefined)
  }, [input, caseId, filters, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleNewConversation = () => {
    clearMessages()
    createConversation()
    setShowHistory(false)
  }

  const handleLoadConversation = (convId: string) => {
    const conv = loadConversation(convId)
    if (conv) {
      setMessages(conv.messages as ChatUIMessage[])
    }
    setShowHistory(false)
  }

  const handleDeleteConversation = (convId: string) => {
    deleteConversation(convId)
    if (convId === activeConversationId) {
      clearMessages()
      createConversation()
    }
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-[calc(100vh-16rem)]">
      {/* Header with history + new conversation */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-900">Investigate</h2>
          {tokenUsage && (
            <span className="text-xs text-gray-400">
              {tokenUsage.input + tokenUsage.output} tokens used
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative" ref={historyRef}>
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="btn-outline text-sm px-3 py-1.5"
            >
              History
            </button>
            {showHistory && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-64 overflow-y-auto">
                <div className="p-2 border-b border-gray-100">
                  <button
                    onClick={handleNewConversation}
                    className="w-full text-left px-3 py-2 text-sm font-medium text-primary-600 hover:bg-primary-50 rounded"
                  >
                    + New conversation
                  </button>
                </div>
                {conversations.length === 0 ? (
                  <p className="p-3 text-sm text-gray-400">No past conversations</p>
                ) : (
                  conversations.map((conv) => (
                    <div key={conv.id} className="flex items-center justify-between px-3 py-2 hover:bg-gray-50">
                      <button
                        onClick={() => handleLoadConversation(conv.id)}
                        className={`flex-1 text-left text-sm truncate ${
                          conv.id === activeConversationId ? 'text-primary-600 font-medium' : 'text-gray-700'
                        }`}
                      >
                        {conv.title}
                      </button>
                      <button
                        onClick={() => handleDeleteConversation(conv.id)}
                        className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <InvestigateFilterBar
        filters={filters}
        availableEvidenceTypes={availableEvidenceTypes}
        availableSpeakers={availableSpeakers}
        availableLocations={availableLocations}
        onSetEvidenceTypes={setEvidenceTypes}
        onSetDateFrom={setDateFrom}
        onSetDateTo={setDateTo}
        onSetSpeakers={setSpeakers}
        onSetLocation={setLocation}
        onClear={clearFilters}
        hasActiveFilters={hasActiveFilters}
      />

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-sm text-red-700 flex items-center justify-between">
          <span>{error}</span>
          {error.includes('API key') && (
            <Link href={routes.settings()} className="text-red-600 underline ml-2">
              Settings
            </Link>
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto bg-white rounded-xl border border-gray-100 p-4 mb-3">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 bg-primary-50 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-primary-500" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">Investigate this case</h3>
            <p className="text-sm text-gray-500 mb-6 max-w-md">
              Ask questions about the {transcripts.length} transcript{transcripts.length !== 1 ? 's' : ''} in this case.
              The AI will search through the evidence and cite specific passages.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
              {STARTER_QUESTIONS.map((q, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setInput(q)
                    inputRef.current?.focus()
                  }}
                  className="text-left text-sm text-gray-600 bg-gray-50 hover:bg-primary-50 hover:text-primary-700 rounded-lg px-3 py-2 transition-colors border border-gray-100"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} caseId={caseId} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question about this case..."
          rows={1}
          disabled={isStreaming}
          className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            onClick={cancelStream}
            className="px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white font-medium text-sm rounded-xl transition-colors flex-shrink-0"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="px-4 py-2.5 bg-primary-600 hover:bg-primary-500 text-white font-medium text-sm rounded-xl transition-colors disabled:opacity-50 flex-shrink-0"
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
