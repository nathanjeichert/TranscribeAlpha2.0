import React from 'react'
import { useRouter } from 'next/navigation'
import { routes } from '@/utils/routes'
import { guardedPush } from '@/utils/navigationGuard'
import type { CitationData } from '@/lib/chatApi'

interface CitationCardProps {
  citation: CitationData
  caseId: string
}

export default function CitationCard({ citation, caseId }: CitationCardProps) {
  const router = useRouter()

  const handleClick = () => {
    guardedPush(
      router,
      routes.viewer(citation.media_key, caseId, citation.line_id),
    )
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex flex-col items-start gap-1 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-3 py-2 text-left transition-colors max-w-md my-1"
    >
      <div className="flex items-center gap-1.5 text-xs text-blue-700 font-medium">
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="truncate">{citation.title || citation.media_key}</span>
        {citation.date && <span className="text-blue-500">- {citation.date}</span>}
      </div>
      <p className="text-xs text-gray-700 italic line-clamp-2">
        &ldquo;{citation.snippet}&rdquo;
      </p>
      <span className="text-xs text-blue-600 font-medium">
        View in transcript &rarr;
      </span>
    </button>
  )
}
