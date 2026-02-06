'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { useDashboard } from '@/context/DashboardContext'
import { authenticatedFetch } from '@/utils/auth'
import { routes } from '@/utils/routes'
import { guardedPush } from '@/utils/navigationGuard'

interface TranscriptListItem {
  media_key: string
  title_label: string
  updated_at?: string | null
  line_count?: number
  expires_at?: string | null
}

export default function CasesPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { cases, uncategorizedCount, refreshCases, setActiveMediaKey } = useDashboard()

  const [activeTab, setActiveTab] = useState<'cases' | 'uncategorized'>('cases')
  const [uncategorizedTranscripts, setUncategorizedTranscripts] = useState<TranscriptListItem[]>([])
  const [loadingUncategorized, setLoadingUncategorized] = useState(false)
  const [showNewCaseModal, setShowNewCaseModal] = useState(false)
  const [newCaseName, setNewCaseName] = useState('')
  const [newCaseDescription, setNewCaseDescription] = useState('')
  const [creatingCase, setCreatingCase] = useState(false)
  const [error, setError] = useState('')
  const [uncategorizedDeleteTarget, setUncategorizedDeleteTarget] = useState<TranscriptListItem | null>(null)
  const [deletingUncategorizedTranscript, setDeletingUncategorizedTranscript] = useState(false)
  const [assignModeEnabled, setAssignModeEnabled] = useState(false)
  const [assignmentTargets, setAssignmentTargets] = useState<Record<string, string>>({})
  const [assigningTranscript, setAssigningTranscript] = useState<string | null>(null)

  useEffect(() => {
    if (searchParams.get('tab') === 'uncategorized') {
      setActiveTab('uncategorized')
    }
  }, [searchParams])

  const loadUncategorized = useCallback(async () => {
    setLoadingUncategorized(true)
    try {
      const response = await authenticatedFetch('/api/transcripts/uncategorized')
      if (response.ok) {
        const data = await response.json()
        setUncategorizedTranscripts(data.transcripts || [])
      }
    } catch (err) {
      console.error('Failed to load uncategorized transcripts:', err)
    } finally {
      setLoadingUncategorized(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'uncategorized') {
      loadUncategorized()
    }
  }, [activeTab, loadUncategorized])

  useEffect(() => {
    if (activeTab !== 'uncategorized') {
      setAssignModeEnabled(false)
      setAssignmentTargets({})
      setAssigningTranscript(null)
    }
  }, [activeTab])

  const handleCreateCase = async () => {
    if (!newCaseName.trim()) return
    setCreatingCase(true)
    setError('')
    try {
      const response = await authenticatedFetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCaseName.trim(), description: newCaseDescription.trim() }),
      })
      if (!response.ok) throw new Error('Failed to create case')
      await refreshCases()
      setShowNewCaseModal(false)
      setNewCaseName('')
      setNewCaseDescription('')
    } catch (err) {
      setError('Failed to create case')
    } finally {
      setCreatingCase(false)
    }
  }

  const handleDeleteUncategorizedTranscript = async () => {
    if (!uncategorizedDeleteTarget) return
    setDeletingUncategorizedTranscript(true)
    setError('')
    try {
      const response = await authenticatedFetch(
        `/api/transcripts/by-key/${encodeURIComponent(uncategorizedDeleteTarget.media_key)}`,
        { method: 'DELETE' }
      )
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to delete transcript')
      }
      setUncategorizedDeleteTarget(null)
      await loadUncategorized()
      await refreshCases()
    } catch (err: any) {
      setError(err?.message || 'Failed to delete transcript')
    } finally {
      setDeletingUncategorizedTranscript(false)
    }
  }

  const getAssignmentTarget = (mediaKey: string) => {
    return assignmentTargets[mediaKey] ?? (cases[0]?.case_id || '')
  }

  const handleAssignToCase = async (mediaKey: string) => {
    const targetCaseId = getAssignmentTarget(mediaKey)
    if (!targetCaseId) {
      setError('Create a case before assigning transcripts.')
      return
    }

    setAssigningTranscript(mediaKey)
    setError('')
    try {
      const response = await authenticatedFetch(`/api/cases/${targetCaseId}/transcripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_key: mediaKey }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail?.detail || 'Failed to assign transcript to case')
      }

      await loadUncategorized()
      await refreshCases()
    } catch (err: any) {
      setError(err?.message || 'Failed to assign transcript to case')
    } finally {
      setAssigningTranscript(null)
    }
  }

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleDateString()
  }

  const getDaysUntilExpiry = (expiresAt?: string | null) => {
    if (!expiresAt) return null
    const now = new Date()
    const expiry = new Date(expiresAt)
    const diff = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    return diff > 0 ? diff : 0
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Cases</h1>
          <p className="text-gray-500 mt-1">Organize your transcripts into cases</p>
        </div>
        <button
          onClick={() => setShowNewCaseModal(true)}
          className="btn-primary px-4 py-2 flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M12 4v16m8-8H4" />
          </svg>
          New Case
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <button
          onClick={() => {
            setActiveTab('cases')
            guardedPush(router, routes.cases())
          }}
          className={`px-4 py-3 font-medium text-sm border-b-2 -mb-px transition-colors ${
            activeTab === 'cases'
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Cases ({cases.length})
        </button>
        <button
          onClick={() => {
            setActiveTab('uncategorized')
            guardedPush(router, routes.casesTab('uncategorized'))
          }}
          className={`px-4 py-3 font-medium text-sm border-b-2 -mb-px transition-colors ${
            activeTab === 'uncategorized'
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Uncategorized ({uncategorizedCount})
        </button>
      </div>

      {/* Cases Grid */}
      {activeTab === 'cases' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cases.length === 0 ? (
            <div className="col-span-full bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">No cases yet</h3>
              <p className="text-gray-500 mb-4">Create your first case to organize transcripts</p>
              <button onClick={() => setShowNewCaseModal(true)} className="btn-primary px-4 py-2">
                Create Case
              </button>
            </div>
          ) : (
            cases.map((caseItem) => (
              <Link
                key={caseItem.case_id}
                href={routes.caseDetail(caseItem.case_id)}
                className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 hover:shadow-md hover:border-primary-200 transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center">
                    <span className="text-lg font-semibold text-primary-700">{caseItem.transcript_count}</span>
                  </div>
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </div>
                <h3 className="font-semibold text-gray-900 mb-1 truncate">{caseItem.name}</h3>
                <p className="text-sm text-gray-500">
                  {caseItem.transcript_count} transcript{caseItem.transcript_count !== 1 ? 's' : ''}
                </p>
                {caseItem.description && (
                  <p className="text-sm text-gray-400 mt-2 line-clamp-2">{caseItem.description}</p>
                )}
                <p className="text-xs text-gray-400 mt-3">
                  Updated {formatDate(caseItem.updated_at)}
                </p>
              </Link>
            ))
          )}
        </div>
      )}

      {/* Uncategorized Transcripts */}
      {activeTab === 'uncategorized' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          {loadingUncategorized ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : uncategorizedTranscripts.length === 0 ? (
            <div className="p-8 text-center">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">All organized!</h3>
              <p className="text-gray-500">No uncategorized transcripts</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              <div className="p-4 bg-amber-50 border-b border-amber-100 flex items-center justify-between gap-3">
                <p className="text-sm text-amber-800">
                  <strong>Note:</strong> Uncategorized transcripts expire after 30 days.
                </p>
                <button
                  onClick={() => setAssignModeEnabled((prev) => !prev)}
                  disabled={cases.length === 0}
                  className="btn-outline text-sm px-3 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={cases.length === 0 ? 'Create a case first' : 'Assign transcripts to a case'}
                >
                  {assignModeEnabled ? 'Done' : 'Assign to Case'}
                </button>
              </div>
              {uncategorizedTranscripts.map((transcript) => {
                const daysLeft = getDaysUntilExpiry(transcript.expires_at)
                return (
                  <div
                    key={transcript.media_key}
                    className="p-4 flex items-center justify-between hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 truncate">{transcript.title_label}</p>
                        <p className="text-sm text-gray-500">
                          {transcript.line_count || 0} lines • Updated {formatDate(transcript.updated_at)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {assignModeEnabled && (
                        <>
                          <select
                            value={getAssignmentTarget(transcript.media_key)}
                            onChange={(e) =>
                              setAssignmentTargets((prev) => ({
                                ...prev,
                                [transcript.media_key]: e.target.value,
                              }))
                            }
                            className="input-field h-9 min-w-[180px] text-sm"
                          >
                            {cases.map((caseItem) => (
                              <option key={caseItem.case_id} value={caseItem.case_id}>
                                {caseItem.name}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleAssignToCase(transcript.media_key)}
                            disabled={assigningTranscript === transcript.media_key || cases.length === 0}
                            className="btn-primary text-sm px-3 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {assigningTranscript === transcript.media_key ? 'Assigning...' : 'Assign'}
                          </button>
                        </>
                      )}
                      {daysLeft !== null && (
                        <span className={`text-sm px-2 py-1 rounded ${
                          daysLeft <= 7 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                        }`}>
                          {daysLeft} days left
                        </span>
                      )}
                      <button
                        onClick={() => {
                          setActiveMediaKey(transcript.media_key)
                          guardedPush(router, routes.editor(transcript.media_key))
                        }}
                        className="btn-outline text-sm px-3 py-1"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => setUncategorizedDeleteTarget(transcript)}
                        disabled={deletingUncategorizedTranscript}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Delete transcript permanently"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Uncategorized Transcript Delete Modal */}
      {uncategorizedDeleteTarget && (
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
                    This will permanently remove <span className="font-medium text-gray-900">&quot;{uncategorizedDeleteTarget.title_label}&quot;</span>.
                    This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>
            <div className="p-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  if (deletingUncategorizedTranscript) return
                  setUncategorizedDeleteTarget(null)
                }}
                className="btn-outline px-4 py-2"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteUncategorizedTranscript}
                disabled={deletingUncategorizedTranscript}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors disabled:opacity-70"
              >
                {deletingUncategorizedTranscript ? 'Deleting...' : 'Delete Transcript'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Case Modal */}
      {showNewCaseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Create New Case</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Name</label>
                <input
                  type="text"
                  value={newCaseName}
                  onChange={(e) => setNewCaseName(e.target.value)}
                  className="input-field"
                  placeholder="e.g., Smith vs. Johnson"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea
                  value={newCaseDescription}
                  onChange={(e) => setNewCaseDescription(e.target.value)}
                  className="input-field"
                  rows={3}
                  placeholder="Brief description..."
                />
              </div>
            </div>
            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setShowNewCaseModal(false)
                  setNewCaseName('')
                  setNewCaseDescription('')
                  setError('')
                }}
                className="btn-outline px-4 py-2"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateCase}
                disabled={!newCaseName.trim() || creatingCase}
                className="btn-primary px-4 py-2"
              >
                {creatingCase ? 'Creating...' : 'Create Case'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
