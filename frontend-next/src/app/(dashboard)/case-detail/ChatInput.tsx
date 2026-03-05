'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'

interface TranscriptOption {
  media_key: string
  title_label: string
}

interface ChatInputProps {
  transcripts: TranscriptOption[]
  isStreaming: boolean
  onSend: (text: string, mentionedKeys: string[]) => void
  onCancel: () => void
}

export default function ChatInput({ transcripts, isStreaming, onSend, onCancel }: ChatInputProps) {
  const [input, setInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestionFilter, setSuggestionFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mentionedTranscripts, setMentionedTranscripts] = useState<TranscriptOption[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const mentionStartRef = useRef<number>(-1)

  const filtered = transcripts.filter((t) =>
    t.title_label.toLowerCase().includes(suggestionFilter.toLowerCase()),
  )

  // Scroll selected suggestion into view
  useEffect(() => {
    if (!showSuggestions || !suggestionsRef.current) return
    const selected = suggestionsRef.current.children[selectedIndex] as HTMLElement
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, showSuggestions])

  const insertMention = useCallback(
    (transcript: TranscriptOption) => {
      const before = input.slice(0, mentionStartRef.current)
      const after = input.slice(inputRef.current?.selectionStart ?? input.length)
      const mentionText = `@${transcript.title_label} `
      setInput(before + mentionText + after)
      setShowSuggestions(false)
      setSuggestionFilter('')
      setSelectedIndex(0)

      if (!mentionedTranscripts.find((t) => t.media_key === transcript.media_key)) {
        setMentionedTranscripts((prev) => [...prev, transcript])
      }

      // Refocus and set cursor after mention
      setTimeout(() => {
        if (inputRef.current) {
          const pos = before.length + mentionText.length
          inputRef.current.focus()
          inputRef.current.setSelectionRange(pos, pos)
        }
      }, 0)
    },
    [input, mentionedTranscripts],
  )

  const removeMention = useCallback((mediaKey: string) => {
    setMentionedTranscripts((prev) => prev.filter((t) => t.media_key !== mediaKey))
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const cursorPos = e.target.selectionStart ?? value.length
    setInput(value)

    // Auto-grow
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px'

    // Detect @ trigger
    if (value[cursorPos - 1] === '@') {
      mentionStartRef.current = cursorPos - 1
      setSuggestionFilter('')
      setSelectedIndex(0)
      setShowSuggestions(true)
      return
    }

    if (showSuggestions && mentionStartRef.current >= 0) {
      const textAfterAt = value.slice(mentionStartRef.current + 1, cursorPos)
      if (textAfterAt.includes('\n') || textAfterAt.includes(' ') && !filtered.some(t => t.title_label.toLowerCase().startsWith(textAfterAt.toLowerCase().trim()))) {
        setShowSuggestions(false)
        return
      }
      setSuggestionFilter(textAfterAt)
      setSelectedIndex(0)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggestions && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev + 1) % filtered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        insertMention(filtered[selectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSuggestions(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !showSuggestions) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    onSend(text, mentionedTranscripts.map((t) => t.media_key))
    setInput('')
    setMentionedTranscripts([])
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
    }
  }

  return (
    <div className="relative">
      {/* Mentioned transcripts chips */}
      {mentionedTranscripts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {mentionedTranscripts.map((t) => (
            <span
              key={t.media_key}
              className="inline-flex items-center gap-1 bg-primary-50 text-primary-700 text-xs font-medium pl-2 pr-1 py-1 rounded-md border border-primary-200"
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="truncate max-w-[200px]">{t.title_label}</span>
              <button
                onClick={() => removeMention(t.media_key)}
                className="p-0.5 hover:bg-primary-100 rounded"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Autocomplete dropdown */}
      {showSuggestions && filtered.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute bottom-full mb-1 left-0 right-12 bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto"
        >
          {filtered.map((t, i) => (
            <button
              key={t.media_key}
              onMouseDown={(e) => {
                e.preventDefault() // Prevent textarea blur
                insertMention(t)
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                i === selectedIndex
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="truncate">{t.title_label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question about this case... (type @ to reference a transcript)"
          rows={1}
          disabled={isStreaming}
          className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            onClick={onCancel}
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
