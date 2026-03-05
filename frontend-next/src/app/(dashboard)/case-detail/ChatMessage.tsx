import React from 'react'
import Markdown from 'react-markdown'
import CitationCard from './CitationCard'
import type { ChatUIMessage } from '@/hooks/useChat'

interface ChatMessageProps {
  message: ChatUIMessage
  caseId: string
}

export default function ChatMessage({ message, caseId }: ChatMessageProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <p className="text-sm text-gray-700 max-w-[80%] whitespace-pre-wrap">{message.displayContent || message.content}</p>
      </div>
    )
  }

  const hasCitations = message.citations && message.citations.length > 0

  return (
    <div className="mb-4">
      {/* Tool activity indicator */}
      {message.toolActivity && (
        <div className="flex items-center gap-2 mb-2 text-xs text-gray-400">
          <div className="w-3 h-3 relative">
            <div className="absolute inset-0 border-2 border-gray-300 rounded-full border-t-primary-500 animate-spin" />
          </div>
          <span>{message.toolActivity}</span>
        </div>
      )}

      {/* Message content */}
      {message.content && (
        <div className="text-sm text-gray-900 prose prose-sm prose-gray max-w-none">
          <Markdown>{message.content}</Markdown>
        </div>
      )}

      {/* Citations */}
      {hasCitations && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {message.citations!.map((citation, i) => (
            <CitationCard key={i} citation={citation} caseId={caseId} />
          ))}
        </div>
      )}

      {/* Streaming placeholder */}
      {!message.content && !message.toolActivity && (
        <div className="flex items-center gap-1.5 py-1">
          <div className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      )}
    </div>
  )
}
