'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useDashboard } from '@/context/DashboardContext'
import { authenticatedFetch } from '@/utils/auth'
import { routes } from '@/utils/routes'

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

export default function CaseDetailPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const caseId = searchParams.get('id') ?? ''
  const { refreshCases, setActiveMediaKey } = useDashboard()

  const [caseMeta, setCaseMeta] = useState<CaseMeta | null>(null)
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  // Edit mode
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [saving, setSaving] = useState(false)

  // Delete modal
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteTranscripts, setDeleteTranscripts] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [showSearchResults, setShowSearchResults] = useState(false)

  // Remove transcript
  const [removingTranscript, setRemovingTranscript] = useState<string | null>(null)

  const loadCase = useCallback(async () => {
    if (!caseId) {
      setError('No case selected')
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError('')
    try {
      const response = await authenticatedFetch(`/api/cases/${caseId}`)
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Case not found')
        }
        throw new Error('Failed to load case')
      }
      const data = await response.json()
      setCaseMeta(data.case)
      setTranscripts(data.transcripts || [])
      setEditName(data.case.name)
      setEditDescription(data.case.description || '')
    } catch (err: any) {
      setError(err?.message || 'Failed to load case')
    } finally {
      setIsLoading(false)
    }
  }, [caseId])

  useEffect(() => {
    loadCase()
  }, [loadCase])

  const handleSaveEdit = async () => {
    if (!editName.trim() || !caseId) return
    setSaving(true)
    try {
      const response = await authenticatedFetch(`/api/cases/${caseId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), description: editDescription.trim() }),
      })
      if (!response.ok) throw new Error('Failed to update case')
      const data = await response.json()
      setCaseMeta(data.case)
      setIsEditing(false)
      refreshCases()
    } catch (err) {
      setError('Failed to update case')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteCase = async () => {
    if (!caseId) return
    setDeleting(true)
    try {
      const response = await authenticatedFetch(
        `/api/cases/${caseId}?delete_transcripts=${deleteTranscripts}`,
        { method: 'DELETE' }
      )
      if (!response.ok) throw new Error('Failed to delete case')
      await refreshCases()
      router.push(routes.cases())
    } catch (err) {
      setError('Failed to delete case')
      setDeleting(false)
    }
  }

  const handleRemoveTranscript = async (mediaKey: string) => {
    if (!caseId) return
    setRemovingTranscript(mediaKey)
    try {
      const response = await authenticatedFetch(
        `/api/cases/${caseId}/transcripts/${encodeURIComponent(mediaKey)}`,
        { method: 'DELETE' }
      )
      if (!response.ok) throw new Error('Failed to remove transcript')
      await loadCase()
      refreshCases()
    } catch (err) {
      setError('Failed to remove transcript')
    } finally {
      setRemovingTranscript(null)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim() || searchQuery.length < 2 || !caseId) return
    setSearching(true)
    setShowSearchResults(true)
    try {
      const response = await authenticatedFetch(
        `/api/cases/${caseId}/search?q=${encodeURIComponent(searchQuery)}`
      )
      if (!response.ok) throw new Error('Search failed')
      const data = await response.json()
      setSearchResults(data.results || [])
    } catch (err) {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleDateString()
  }

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
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link href={routes.cases()} className="hover:text-primary-600">Cases</Link>
        <span>/</span>
        <span className="text-gray-900">{caseMeta?.name}</span>
      </div>

      {/* Header */}
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

      {/* Search */}
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

      {/* Search Results */}
      {showSearchResults && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 mb-6">
          <div className="p-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900">
              Search Results for "{searchQuery}"
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
                      router.push(routes.editor(result.media_key))
                    }}
                    className="font-medium text-primary-600 hover:text-primary-700 mb-2 text-left"
                  >
                    {result.title_label}
                  </button>
                  <div className="space-y-2">
                    {result.matches.slice(0, 5).map((match, i) => (
                      <div key={i} className="text-sm bg-gray-50 rounded p-2">
                        <span className="text-gray-500">Page {match.page}, Line {match.line}</span>
                        <span className="mx-2 text-gray-400">|</span>
                        <span className="font-medium text-gray-700">{match.speaker}:</span>
                        <span className="text-gray-600 ml-1">{match.text}</span>
                      </div>
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

      {/* Transcripts */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Transcripts</h2>
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
            {transcripts.map((transcript) => (
              <div
                key={transcript.media_key}
                className="p-4 flex items-center justify-between hover:bg-gray-50"
              >
                <button
                  onClick={() => {
                    setActiveMediaKey(transcript.media_key)
                    router.push(routes.editor(transcript.media_key))
                  }}
                  className="flex items-center gap-4 flex-1 min-w-0 text-left"
                >
                  <div className="w-10 h-10 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{transcript.title_label}</p>
                    <p className="text-sm text-gray-500">
                      {transcript.line_count || 0} lines • {formatDuration(transcript.audio_duration)} • Updated {formatDate(transcript.updated_at)}
                    </p>
                  </div>
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setActiveMediaKey(transcript.media_key)
                      router.push(routes.clipCreator(transcript.media_key))
                    }}
                    className="p-2 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                    title="Create clips"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleRemoveTranscript(transcript.media_key)}
                    disabled={removingTranscript === transcript.media_key}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Remove from case"
                  >
                    {removingTranscript === transcript.media_key ? (
                      <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Case</h3>
            <p className="text-gray-600 mb-4">
              Are you sure you want to delete "{caseMeta?.name}"?
            </p>
            {transcripts.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteTranscripts}
                    onChange={(e) => setDeleteTranscripts(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-amber-800">
                      Also delete {transcripts.length} transcript{transcripts.length !== 1 ? 's' : ''}
                    </p>
                    <p className="text-sm text-amber-700">
                      {deleteTranscripts
                        ? 'Transcripts will be permanently deleted'
                        : 'Transcripts will be moved to uncategorized (30-day expiry)'}
                    </p>
                  </div>
                </label>
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false)
                  setDeleteTranscripts(false)
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
