import React from 'react'
import { useRouter } from 'next/navigation'
import { routes } from '@/utils/routes'
import { guardedPush } from '@/utils/navigationGuard'
import type { CitationData } from '@/lib/chatApi'

interface CitationCardProps {
  citation: CitationData
  caseId: string
}

/**
 * Parse media_key and optional line_id from the citation source.
 * Source formats: "media_key" or "media_key:line_id"
 */
function parseSource(source: string): { mediaKey: string; lineId?: string } {
  const colonIdx = source.indexOf(':')
  if (colonIdx > 0) {
    return { mediaKey: source.slice(0, colonIdx), lineId: source.slice(colonIdx + 1) }
  }
  return { mediaKey: source }
}

export default function CitationCard({ citation, caseId }: CitationCardProps) {
  const router = useRouter()
  const { mediaKey, lineId } = parseSource(citation.source)

  const handleViewTranscript = () => {
    guardedPush(
      router,
      routes.viewer(mediaKey, caseId, lineId),
    )
  }

  const handleCreateClip = () => {
    guardedPush(
      router,
      routes.viewer(mediaKey, caseId, lineId, { tools: 'clips', clipLineId: lineId }),
    )
  }

  return (
    <div
      className="inline-flex max-w-md flex-col items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-left"
    >
      <div className="flex items-center gap-1.5 text-xs text-blue-700 font-medium">
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="truncate">{citation.title || mediaKey}</span>
      </div>
      {citation.cited_text && (
        <p className="text-xs text-gray-700 italic line-clamp-2">
          &ldquo;{citation.cited_text}&rdquo;
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleViewTranscript}
          className="rounded border border-blue-200 bg-white px-2 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100"
        >
          View in transcript
        </button>
        {lineId && (
          <button
            type="button"
            onClick={handleCreateClip}
            className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-100"
          >
            Create clip
          </button>
        )}
      </div>
    </div>
  )
}
