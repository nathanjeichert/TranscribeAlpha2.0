import React, { useState } from 'react'
import type { EvidenceType } from '@/lib/storage'
import type { InvestigateFilters } from '@/hooks/useInvestigateFilters'

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  jail_call: 'Jail Call',
  '911_call': '911 Call',
  body_worn_camera: 'BWC',
  interrogation: 'Interrogation',
  deposition: 'Deposition',
  other: 'Other',
}

interface FilterBarProps {
  filters: InvestigateFilters
  availableEvidenceTypes: EvidenceType[]
  availableSpeakers: string[]
  availableLocations: string[]
  onSetEvidenceTypes: (types: EvidenceType[]) => void
  onSetDateFrom: (date: string) => void
  onSetDateTo: (date: string) => void
  onSetSpeakers: (speakers: string[]) => void
  onSetLocation: (location: string) => void
  onClear: () => void
  hasActiveFilters: boolean
}

export default function InvestigateFilterBar({
  filters,
  availableEvidenceTypes,
  availableSpeakers,
  availableLocations,
  onSetEvidenceTypes,
  onSetDateFrom,
  onSetDateTo,
  onSetSpeakers,
  onSetLocation,
  onClear,
  hasActiveFilters,
}: FilterBarProps) {
  const [expanded, setExpanded] = useState(false)

  if (availableEvidenceTypes.length === 0 && availableSpeakers.length === 0 && availableLocations.length === 0) {
    return null
  }

  return (
    <div className="mb-3">
      {/* Toggle + active pills */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs font-medium text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
          Filters
        </button>

        {/* Active filter pills */}
        {filters.evidenceTypes.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs">
            {EVIDENCE_TYPE_LABELS[t] || t}
            <button
              onClick={() => onSetEvidenceTypes(filters.evidenceTypes.filter((x) => x !== t))}
              className="hover:text-blue-900"
            >
              &times;
            </button>
          </span>
        ))}
        {filters.speakers.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-700 rounded-full text-xs">
            {s}
            <button
              onClick={() => onSetSpeakers(filters.speakers.filter((x) => x !== s))}
              className="hover:text-green-900"
            >
              &times;
            </button>
          </span>
        ))}
        {filters.dateFrom && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-700 rounded-full text-xs">
            From: {filters.dateFrom}
            <button onClick={() => onSetDateFrom('')} className="hover:text-purple-900">&times;</button>
          </span>
        )}
        {filters.dateTo && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-700 rounded-full text-xs">
            To: {filters.dateTo}
            <button onClick={() => onSetDateTo('')} className="hover:text-purple-900">&times;</button>
          </span>
        )}
        {filters.location && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-50 text-yellow-700 rounded-full text-xs">
            {filters.location}
            <button onClick={() => onSetLocation('')} className="hover:text-yellow-900">&times;</button>
          </span>
        )}
        {hasActiveFilters && (
          <button
            onClick={onClear}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Expanded filter controls */}
      {expanded && (
        <div className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Evidence type multi-select */}
          {availableEvidenceTypes.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Evidence Type</label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {availableEvidenceTypes.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.evidenceTypes.includes(t)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          onSetEvidenceTypes([...filters.evidenceTypes, t])
                        } else {
                          onSetEvidenceTypes(filters.evidenceTypes.filter((x) => x !== t))
                        }
                      }}
                      className="rounded border-gray-300"
                    />
                    {EVIDENCE_TYPE_LABELS[t] || t}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Date range */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date Range</label>
            <div className="space-y-1">
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => onSetDateFrom(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                placeholder="From"
              />
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => onSetDateTo(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                placeholder="To"
              />
            </div>
          </div>

          {/* Speakers */}
          {availableSpeakers.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Speakers</label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {availableSpeakers.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.speakers.includes(s)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          onSetSpeakers([...filters.speakers, s])
                        } else {
                          onSetSpeakers(filters.speakers.filter((x) => x !== s))
                        }
                      }}
                      className="rounded border-gray-300"
                    />
                    {s}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Location */}
          {availableLocations.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
              <select
                value={filters.location}
                onChange={(e) => onSetLocation(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
              >
                <option value="">All locations</option>
                {availableLocations.map((loc) => (
                  <option key={loc} value={loc}>{loc}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
