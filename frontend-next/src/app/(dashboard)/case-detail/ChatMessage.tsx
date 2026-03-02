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
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-primary-600 text-white rounded-2xl rounded-br-md px-4 py-2.5">
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    )
  }

  // Assistant message — citations come from the API as structured metadata,
  // no longer embedded in text as [[CITE:...]] markers.
  const hasCitations = message.citations && message.citations.length > 0

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        {/* Tool activity indicator */}
        {message.toolActivity && (
          <div className="flex items-center gap-2 mb-2 text-xs text-gray-500">
            <div className="w-3 h-3 relative">
              <div className="absolute inset-0 border-2 border-gray-300 rounded-full border-t-primary-500 animate-spin"></div>
            </div>
            <span>{message.toolActivity}</span>
          </div>
        )}

        {/* Message content with markdown rendering */}
        {message.content && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl rounded-bl-md px-4 py-2.5">
            <div className="text-sm text-gray-900 prose prose-sm prose-gray max-w-none">
              <Markdown>{message.content}</Markdown>
            </div>
          </div>
        )}

        {/* Citations rendered below the message */}
        {hasCitations && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.citations!.map((citation, i) => (
              <CitationCard key={i} citation={citation} caseId={caseId} />
            ))}
          </div>
        )}

        {/* Streaming placeholder if no content yet and tool is running */}
        {!message.content && !message.toolActivity && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl rounded-bl-md px-4 py-2.5">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
