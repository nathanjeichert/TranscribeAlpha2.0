import React from 'react'
import { splitTextAndCitations } from '@/lib/citationParser'
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

  // Assistant message
  const segments = message.content ? splitTextAndCitations(message.content) : []

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

        {/* Message content */}
        {segments.length > 0 && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl rounded-bl-md px-4 py-2.5">
            <div className="text-sm text-gray-900 whitespace-pre-wrap">
              {segments.map((segment, i) => {
                if (segment.type === 'text') {
                  return <React.Fragment key={i}>{segment.content}</React.Fragment>
                }
                return (
                  <CitationCard
                    key={i}
                    citation={{
                      media_key: segment.citation.media_key,
                      line_id: segment.citation.line_id,
                      snippet: segment.citation.snippet,
                      title: message.citations?.find(
                        (c) => c.media_key === segment.citation.media_key && c.line_id === segment.citation.line_id,
                      )?.title,
                      date: message.citations?.find(
                        (c) => c.media_key === segment.citation.media_key && c.line_id === segment.citation.line_id,
                      )?.date,
                    }}
                    caseId={caseId}
                  />
                )
              })}
            </div>
          </div>
        )}

        {/* Streaming placeholder if no content yet and tool is running */}
        {segments.length === 0 && !message.toolActivity && message.content === '' && (
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
