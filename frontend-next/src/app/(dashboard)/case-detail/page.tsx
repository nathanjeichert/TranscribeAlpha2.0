'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useDashboard } from '@/context/DashboardContext'
import { routes } from '@/utils/routes'
import { guardedPush } from '@/utils/navigationGuard'
import { formatDate, formatDuration } from '@/utils/helpers'
import { useTranscriptActions } from '@/hooks/useTranscriptActions'
import { isTauri } from '@/lib/platform'
import {
  getCase as localGetCase,
  updateCase as localUpdateCase,
  deleteCase as localDeleteCase,
  searchCaseTranscripts as localSearchCaseTranscripts,
  listTranscriptsInCase as localListTranscriptsInCase,
  getTranscript as localGetTranscript,
  saveTranscript as localSaveTranscript,
  type EvidenceType,
} from '@/lib/storage'
import InvestigateTab from './InvestigateTab'

interface CaseMeta {
  case_id: string
  name: string
  description?: string
  created_at: string
  updated_at: string
  transcript_count: number
}

interface TranscriptItem {
  media_key: string
  title_label: string
  added_at?: string
  updated_at?: string | null
  line_count?: number
  audio_duration?: number
  ai_summary?: string
  evidence_type?: EvidenceType
  speakers?: string[]
  location?: string
}

interface SearchMatch {
  line_id: string
  page: number
  line: number
  text: string
  speaker: string
  match_type: string
}

interface SearchResult {
  media_key: string
  title_label: string
  matches: SearchMatch[]
}

function highlightSearchTerm(text: string, query: string): React.ReactNode {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? React.createElement('mark', { key: i, className: 'bg-yellow-200 text-yellow-900 rounded-sm px-0.5' }, part)
      : part,
  )
}

const EVIDENCE_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  jail_call: { label: 'Jail Call', color: 'bg-orange-100 text-orange-700' },
  '911_call': { label: '911 Call', color: 'bg-red-100 text-red-700' },
  body_worn_camera: { label: 'BWC', color: 'bg-blue-100 text-blue-700' },
  interrogation: { label: 'Interrogation', color: 'bg-purple-100 text-purple-700' },
  deposition: { label: 'Deposition', color: 'bg-green-100 text-green-700' },
  other: { label: 'Other', color: 'bg-gray-100 text-gray-700' },
}

type SortField = 'updated_at' | 'title_label' | 'audio_duration' | 'line_count'
type SortDir = 'asc' | 'desc'
type CaseTab = 'transcripts' | 'investigate'

export default function CaseDetailPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const caseId = searchParams.get('id') ?? ''
  const { cases, refreshCases, setActiveMediaKey } = useDashboard()

  const [caseMeta, setCaseMeta] = useState<CaseMeta | null>(null)
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteTranscriptsOnCaseDelete, setDeleteTranscriptsOnCaseDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [showSearchResults, setShowSearchResults] = useState(false)

  const [sortField, setSortField] = useState<SortField>('updated_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [activeTab, setActiveTab] = useState<CaseTab>('transcripts')
  const [editingBadgeKey, setEditingBadgeKey] = useState<string | null>(null)
  const inTauri = isTauri()

  const handleEvidenceTypeChange = async (mediaKey: string, newType: EvidenceType) => {
    setEditingBadgeKey(null)
    try {
      const existing = await localGetTranscript(mediaKey)
      if (existing) {
        existing.evidence_type = newType
        await localSaveTranscript(mediaKey, existing, caseId || undefined)
        setTranscripts((prev) =>
          prev.map((t) => (t.media_key === mediaKey ? { ...t, evidence_type: newType } : t)),
        )
      }
    } catch {
      // Best effort
    }
  }

  const loadCase = useCallback(async () => {
    if (!caseId) {
      setError('No case selected')
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const caseDetail = await localGetCase(caseId)
      if (!caseDetail) throw new Error('Case not found')

      setCaseMeta({
        case_id: caseDetail.case_id,
        name: caseDetail.name,
        description: caseDetail.description,
        created_at: caseDetail.created_at,
        updated_at: caseDetail.updated_at,
        transcript_count: caseDetail.transcript_count,
      })

      const caseTranscripts = await localListTranscriptsInCase(caseId)
      setTranscripts(
        caseTranscripts.map((t) => ({
          media_key: t.media_key,
          title_label: t.title_label,
          updated_at: t.updated_at,
          line_count: t.line_count,
          audio_duration: t.audio_duration,
          ai_summary: t.ai_summary,
          evidence_type: t.evidence_type,
          speakers: t.speakers,
          location: t.location,
        })),
      )

      setEditName(caseDetail.name)
      setEditDescription(caseDetail.description || '')
    } catch (err: any) {
      setError(err?.message || 'Failed to load case')
    } finally {
      setIsLoading(false)
    }
  }, [caseId])

  const onMutate = useCallback(async () => {
    await loadCase()
    await refreshCases()
  }, [loadCase, refreshCases])

  const {
    deleteTarget, isDeleting, setDeleteTarget, confirmDelete,
    assigningKey, getAssignTarget, updateAssignTarget, resetAssignment, confirmAssign,
  } = useTranscriptActions(onMutate)

  useEffect(() => {
    loadCase()
  }, [loadCase])

  useEffect(() => {
    if (!isEditing) {
      resetAssignment()
    }
  }, [isEditing, resetAssignment])

  const handleSaveEdit = async () => {
    if (!editName.trim() || !caseId) return
    setSaving(true)
    try {
      await localUpdateCase(caseId, { name: editName.trim(), description: editDescription.trim() })
      setCaseMeta((prev) =>
        prev ? { ...prev, name: editName.trim(), description: editDescription.trim(), updated_at: new Date().toISOString() } : prev,
      )
      setIsEditing(false)
      refreshCases()
    } catch {
      setError('Failed to update case')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteCase = async () => {
    if (!caseId) return
    setDeleting(true)
    try {
      await localDeleteCase(caseId, deleteTranscriptsOnCaseDelete)
      await refreshCases()
      guardedPush(router, routes.cases())
    } catch {
      setError('Failed to delete case')
      setDeleting(false)
    }
  }

  const handleReassignTranscript = async (mediaKey: string) => {
    if (!caseId) return
    const target = getAssignTarget(mediaKey, 'uncategorized')
    if (!target || target === caseId) return

    setError('')
    try {
      await confirmAssign(mediaKey, target)
    } catch (err: any) {
      setError(err?.message || 'Failed to reassign transcript')
    }
  }

  const handleDeleteTranscript = async () => {
    setError('')
    try {
      await confirmDelete()
    } catch (err: any) {
      setError(err?.message || 'Failed to delete transcript')
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim() || searchQuery.length < 2 || !caseId) return
    setSearching(true)
    setShowSearchResults(true)
    try {
      const results = await localSearchCaseTranscripts(caseId, searchQuery)
      setSearchResults(results)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const sortedTranscripts = useMemo(() => {
    const list = [...transcripts]
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      switch (sortField) {
        case 'title_label':
          return dir * a.title_label.localeCompare(b.title_label)
        case 'audio_duration':
          return dir * ((a.audio_duration || 0) - (b.audio_duration || 0))
        case 'line_count':
          return dir * ((a.line_count || 0) - (b.line_count || 0))
        case 'updated_at':
        default:
          return dir * ((a.updated_at || '').localeCompare(b.updated_at || ''))
      }
    })
    return list
  }, [transcripts, sortField, sortDir])

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 relative">
            <div className="absolute inset-0 border-4 border-primary-200 rounded-full"></div>
            <div className="absolute inset-0 border-4 border-primary-600 rounded-full border-t-transparent animate-spin"></div>
          </div>
          <p className="text-gray-500">Loading case...</p>
        </div>
      </div>
    )
  }

  if (error && !caseMeta) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-xl p-8 text-center">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Error</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <Link href={routes.cases()} className="btn-primary px-6 py-3">
            Back to Cases
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link href={routes.cases()} className="hover:text-primary-600">Cases</Link>
        <span>/</span>
        <span className="text-gray-900">{caseMeta?.name}</span>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        {isEditing ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Case Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="input-field"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="input-field"
                rows={3}
              />
            </div>
            <div className="flex gap-3">
              <button onClick={handleSaveEdit} disabled={saving || !editName.trim()} className="btn-primary px-4 py-2">
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button onClick={() => setIsEditing(false)} className="btn-outline px-4 py-2">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900 mb-1">{caseMeta?.name}</h1>
              {caseMeta?.description && (
                <p className="text-gray-500 mb-3">{caseMeta.description}</p>
              )}
              <div className="flex items-center gap-4 text-sm text-gray-400">
                <span>{transcripts.length} transcript{transcripts.length !== 1 ? 's' : ''}</span>
                <span>Created {formatDate(caseMeta?.created_at)}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setIsEditing(true)} className="btn-outline px-3 py-2">
                Edit
              </button>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-700">
          {error}
        </div>
      )}

      {inTauri && (
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('transcripts')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'transcripts'
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Transcripts
          </button>
          <button
            onClick={() => setActiveTab('investigate')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'investigate'
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Investigate
          </button>
        </div>
      )}

      {activeTab === 'investigate' && inTauri ? (
        <InvestigateTab caseId={caseId} transcripts={transcripts} />
      ) : (
      <>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-6">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search transcripts in this case..."
              className="input-field pl-10"
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <button
            onClick={handleSearch}
            disabled={searching || searchQuery.length < 2}
            className="btn-primary px-4 py-2"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
          {showSearchResults && (
            <button
              onClick={() => {
                setShowSearchResults(false)
                setSearchQuery('')
                setSearchResults([])
              }}
              className="btn-outline px-4 py-2"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {showSearchResults && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 mb-6">
          <div className="p-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900">
              Search Results for &quot;{searchQuery}&quot;
            </h3>
          </div>
          {searchResults.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              No matches found
            </div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
              {searchResults.map((result) => (
                <div key={result.media_key} className="p-4">
                  <button
                    onClick={() => {
                      setActiveMediaKey(result.media_key)
                      guardedPush(router, routes.viewer(result.media_key, caseId, result.matches[0]?.line_id))
                    }}
                    className="font-medium text-primary-600 hover:text-primary-700 mb-2 text-left"
                  >
                    {result.title_label}
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      ({result.matches.length} match{result.matches.length !== 1 ? 'es' : ''})
                    </span>
                  </button>
                  <div className="space-y-2">
                    {result.matches.slice(0, 5).map((match, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setActiveMediaKey(result.media_key)
                          guardedPush(router, routes.viewer(result.media_key, caseId, match.line_id))
                        }}
                        className="w-full text-left text-sm bg-gray-50 hover:bg-blue-50 rounded p-2 transition-colors cursor-pointer"
                      >
                        <span className="text-gray-500">Page {match.page}, Line {match.line}</span>
                        <span className="mx-2 text-gray-400">|</span>
                        <span className="font-medium text-gray-700">{match.speaker}:</span>
                        <span className="text-gray-600 ml-1">{highlightSearchTerm(match.text, searchQuery)}</span>
                      </button>
                    ))}
                    {result.matches.length > 5 && (
                      <p className="text-sm text-gray-500">
                        ... and {result.matches.length - 5} more matches
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold text-gray-900">Transcripts</h2>
          <div className="flex items-center gap-3">
            {transcripts.length > 1 && (
              <div className="flex items-center gap-2">
                <select
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                  className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 text-gray-700 bg-white"
                >
                  <option value="updated_at">Last Updated</option>
                  <option value="title_label">Name</option>
                  <option value="audio_duration">Duration</option>
                  <option value="line_count">Lines</option>
                </select>
                <button
                  onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-500"
                  title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    {sortDir === 'asc' ? (
                      <path d="M3 4h13M3 8h9M3 12h5m4-4v12m0 0l-4-4m4 4l4-4" />
                    ) : (
                      <path d="M3 4h13M3 8h9M3 12h5m4 8V8m0 0l-4 4m4-4l4 4" />
                    )}
                  </svg>
                </button>
              </div>
            )}
            <Link
              href={routes.transcribe(caseId)}
              className="btn-primary px-4 py-2 text-sm flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 4v16m8-8H4" />
              </svg>
              Add Transcript
            </Link>
          </div>
        </div>
        {isEditing && (
          <div className="px-4 py-3 border-b border-gray-100 bg-primary-50 text-sm text-primary-800">
            Reassign transcripts to another case or to uncategorized.
          </div>
        )}

        {transcripts.length === 0 ? (
          <div className="p-8 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No transcripts yet</h3>
            <p className="text-gray-500 mb-4">Create your first transcript for this case</p>
            <Link href={routes.transcribe(caseId)} className="btn-primary px-4 py-2">
              Create Transcript
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {sortedTranscripts.map((transcript) => (
              <div
                key={transcript.media_key}
                className="p-4 flex items-center justify-between hover:bg-gray-50"
              >
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-10 h-10 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900 truncate">{transcript.title_label}</p>
                      {transcript.evidence_type && EVIDENCE_TYPE_LABELS[transcript.evidence_type] && (
                        <div className="relative flex-shrink-0">
                          <button
                            onClick={(e) => {
                              if (!inTauri) return
                              e.stopPropagation()
                              setEditingBadgeKey(editingBadgeKey === transcript.media_key ? null : transcript.media_key)
                            }}
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${EVIDENCE_TYPE_LABELS[transcript.evidence_type].color} ${inTauri ? 'cursor-pointer hover:ring-2 hover:ring-primary-200' : 'cursor-default'}`}
                          >
                            {EVIDENCE_TYPE_LABELS[transcript.evidence_type].label}
                          </button>
                          {inTauri && editingBadgeKey === transcript.media_key && (
                            <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 py-1 w-36">
                              {Object.entries(EVIDENCE_TYPE_LABELS).map(([type, { label }]) => (
                                <button
                                  key={type}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleEvidenceTypeChange(transcript.media_key, type as EvidenceType)
                                  }}
                                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${
                                    transcript.evidence_type === type ? 'font-medium text-primary-600' : 'text-gray-700'
                                  }`}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">
                      {transcript.line_count || 0} lines • {formatDuration(transcript.audio_duration)} • Updated {formatDate(transcript.updated_at)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap justify-end">
                  {isEditing && (
                    <>
                      <select
                        value={getAssignTarget(transcript.media_key, 'uncategorized')}
                        onChange={(e) => updateAssignTarget(transcript.media_key, e.target.value)}
                        className="input-field h-9 w-[16rem] md:w-[22rem] min-w-[220px] text-sm"
                      >
                        <option value="uncategorized">Uncategorized</option>
                        {cases
                          .filter((caseItem) => caseItem.case_id !== caseId)
                          .map((caseItem) => (
                            <option key={caseItem.case_id} value={caseItem.case_id}>
                              {caseItem.name}
                            </option>
                          ))}
                      </select>
                      <button
                        onClick={() => handleReassignTranscript(transcript.media_key)}
                        disabled={assigningKey === transcript.media_key}
                        className="btn-outline text-sm px-3 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {assigningKey === transcript.media_key ? 'Applying...' : 'Apply'}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => {
                      setActiveMediaKey(transcript.media_key)
                      guardedPush(router, routes.viewer(transcript.media_key, caseId))
                    }}
                    className="btn-primary text-sm px-3 py-1"
                  >
                    View
                  </button>
                  <button
                    onClick={() => {
                      setActiveMediaKey(transcript.media_key)
                      guardedPush(router, routes.editor(transcript.media_key))
                    }}
                    className="btn-outline text-sm px-3 py-1"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setDeleteTarget(transcript)}
                    disabled={isDeleting}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Delete transcript permanently"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-gray-100 bg-white shadow-2xl">
            <div className="p-6 border-b border-gray-100">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M12 9v4m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Delete Transcript Permanently?</h3>
                  <p className="mt-2 text-sm text-gray-600">
                    This will permanently remove <span className="font-medium text-gray-900">&quot;{deleteTarget.title_label}&quot;</span>.
                    This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>
            <div className="p-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  if (isDeleting) return
                  setDeleteTarget(null)
                }}
                className="btn-outline px-4 py-2"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteTranscript}
                disabled={isDeleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors disabled:opacity-70"
              >
                {isDeleting ? 'Deleting...' : 'Delete Transcript'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Case</h3>
            <p className="text-gray-600 mb-4">
              Are you sure you want to delete &quot;{caseMeta?.name}&quot;?
            </p>
            {transcripts.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteTranscriptsOnCaseDelete}
                    onChange={(e) => setDeleteTranscriptsOnCaseDelete(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-amber-800">
                      Also delete {transcripts.length} transcript{transcripts.length !== 1 ? 's' : ''}
                    </p>
                    <p className="text-sm text-amber-700">
                      {deleteTranscriptsOnCaseDelete
                        ? 'Transcripts will be permanently deleted'
                        : 'Transcripts will be moved to uncategorized'}
                    </p>
                  </div>
                </label>
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false)
                  setDeleteTranscriptsOnCaseDelete(false)
                }}
                className="btn-outline px-4 py-2"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteCase}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete Case'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
