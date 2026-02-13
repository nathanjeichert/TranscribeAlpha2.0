'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useDashboard, type JobRecord, type JobKind, type JobStatus } from '@/context/DashboardContext'
import { routes } from '@/utils/routes'
import { guardedPush } from '@/utils/navigationGuard'
import { useRouter } from 'next/navigation'

type KindFilter = 'all' | JobKind
type StatusFilter = 'all' | 'active' | 'failed'

function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

function statusLabel(job: JobRecord): string {
  if (job.kind === 'conversion') {
    if (job.status === 'succeeded' && job.needsConversion === false) return 'Already OK'
    if (job.status === 'succeeded') return 'Converted'
  }

  if (job.status === 'queued') return 'Queued'
  if (job.status === 'running') return 'Running'
  if (job.status === 'finalizing') return 'Finalizing'
  if (job.status === 'succeeded') return 'Complete'
  if (job.status === 'canceled') return 'Canceled'
  return 'Failed'
}

function statusClass(job: JobRecord): string {
  if (job.status === 'succeeded') return 'bg-green-100 text-green-700'
  if (job.status === 'failed') return 'bg-red-100 text-red-700'
  if (job.status === 'canceled') return 'bg-amber-100 text-amber-800'
  if (job.status === 'running') return 'bg-primary-100 text-primary-700'
  return 'bg-gray-100 text-gray-700'
}

function kindLabel(kind: JobKind): string {
  if (kind === 'transcription') return 'Transcription'
  if (kind === 'conversion') return 'Conversion'
  return 'Job'
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export default function JobsPage() {
  const router = useRouter()
  const {
    jobs,
    getConvertedFile,
    resolveConvertedFile,
    retryJob,
    cancelJob,
    removeJob,
  } = useDashboard()

  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [busyJobId, setBusyJobId] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)

  const sorted = useMemo(() => {
    return [...jobs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }, [jobs])

  const filtered = useMemo(() => {
    return sorted.filter((job) => {
      if (kindFilter !== 'all' && job.kind !== kindFilter) return false
      if (statusFilter === 'active') return !isTerminal(job.status)
      if (statusFilter === 'failed') return job.status === 'failed'
      return true
    })
  }, [kindFilter, sorted, statusFilter])

  const activeJobs = useMemo(() => filtered.filter((job) => !isTerminal(job.status)), [filtered])
  const recentJobs = useMemo(() => filtered.filter((job) => isTerminal(job.status)), [filtered])

  const failedTranscriptions = useMemo(() => {
    return jobs.filter((job) => job.kind === 'transcription' && (job.status === 'failed' || job.status === 'canceled'))
  }, [jobs])

  const failedConversions = useMemo(() => {
    return jobs.filter((job) => job.kind === 'conversion' && (job.status === 'failed' || job.status === 'canceled'))
  }, [jobs])

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Jobs</h1>
          <p className="text-gray-600 mt-1">
            Track active and recent operations (transcriptions, conversions, and more).
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={routes.transcribe()} className="btn-primary px-4 py-2">
            New Transcript
          </Link>
          <Link href={routes.converter()} className="btn-outline px-4 py-2">
            Converter
          </Link>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-900 text-sm">
        <div className="font-medium">Refresh/Close behavior</div>
        <div className="mt-1">
          In-app navigation is safe while jobs run, but refreshing or closing the tab will interrupt active work.
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-wrap items-center gap-3">
        <div className="text-sm font-medium text-gray-700">Filters</div>
        <div className="flex gap-2 flex-wrap">
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            className="input-field text-sm"
          >
            <option value="all">All kinds</option>
            <option value="transcription">Transcription</option>
            <option value="conversion">Conversion</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="input-field text-sm"
          >
            <option value="all">All statuses</option>
            <option value="active">Active only</option>
            <option value="failed">Failed only</option>
          </select>
        </div>

        <div className="ml-auto flex gap-2 flex-wrap">
          <button
            type="button"
            disabled={batchBusy || failedTranscriptions.length === 0}
            onClick={() => {
              setBatchBusy(true)
              try {
                for (const job of failedTranscriptions) {
                  retryJob(job.id)
                }
              } finally {
                setBatchBusy(false)
              }
            }}
            className="btn-outline px-3 py-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Retry Failed Transcripts ({failedTranscriptions.length})
          </button>
          <button
            type="button"
            disabled={batchBusy || failedConversions.length === 0}
            onClick={() => {
              setBatchBusy(true)
              try {
                for (const job of failedConversions) {
                  retryJob(job.id)
                }
              } finally {
                setBatchBusy(false)
              }
            }}
            className="btn-outline px-3 py-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Retry Failed Conversions ({failedConversions.length})
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Active Jobs ({activeJobs.length})</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {activeJobs.map((job) => {
            const converted = job.kind === 'conversion' ? getConvertedFile(job.id) : null
            const hasPersistedOutput = job.kind === 'conversion' && Boolean(job.convertedCachePath)
            const isBusy = busyJobId === job.id

            return (
              <div key={job.id} className="p-4 flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{kindLabel(job.kind)}</span>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusClass(job)}`}>
                      {statusLabel(job)}
                    </span>
                  </div>
                  <div className="font-medium text-gray-900 truncate mt-1">{job.title}</div>
                  <div className="text-sm text-gray-500 mt-1">{job.detail || '—'}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    Started: {formatTime(job.createdAt)} • Updated: {formatTime(job.updatedAt)}
                  </div>
                  {job.error ? <div className="text-sm text-red-600 mt-2">{job.error}</div> : null}
                </div>

                <div className="flex gap-2 flex-wrap">
                  {job.kind === 'conversion' && (converted || hasPersistedOutput) ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const file = converted || (await resolveConvertedFile(job.id))
                        if (!file) return
                        downloadFile(file)
                      }}
                      className="btn-outline px-3 py-2 text-sm"
                    >
                      Download
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={async () => {
                      setBusyJobId(job.id)
                      try {
                        await cancelJob(job.id)
                      } finally {
                        setBusyJobId(null)
                      }
                    }}
                    disabled={isBusy}
                    className="btn-outline px-3 py-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )
          })}

          {activeJobs.length === 0 && (
            <div className="p-8 text-center text-gray-500">No active jobs.</div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Recent Jobs ({recentJobs.length})</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {recentJobs.map((job) => {
            const converted = job.kind === 'conversion' ? getConvertedFile(job.id) : null
            const hasPersistedOutput = job.kind === 'conversion' && Boolean(job.convertedCachePath)
            const isBusy = busyJobId === job.id

            return (
              <div key={job.id} className="p-4 flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{kindLabel(job.kind)}</span>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusClass(job)}`}>
                      {statusLabel(job)}
                    </span>
                  </div>
                  <div className="font-medium text-gray-900 truncate mt-1">{job.title}</div>
                  <div className="text-sm text-gray-500 mt-1">{job.detail || '—'}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    Started: {formatTime(job.createdAt)} • Updated: {formatTime(job.updatedAt)}
                  </div>
                  {job.error ? <div className="text-sm text-red-600 mt-2">{job.error}</div> : null}
                </div>

                <div className="flex gap-2 flex-wrap">
                  {job.kind === 'transcription' && job.status === 'succeeded' && job.mediaKey ? (
                    <button
                      type="button"
                      onClick={() => guardedPush(router, routes.editor(job.mediaKey))}
                      className="btn-primary px-3 py-2 text-sm"
                    >
                      Open Editor
                    </button>
                  ) : null}

                  {job.kind === 'conversion' && (converted || hasPersistedOutput) ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const file = converted || (await resolveConvertedFile(job.id))
                        if (!file) return
                        downloadFile(file)
                      }}
                      className="btn-outline px-3 py-2 text-sm"
                    >
                      Download
                    </button>
                  ) : null}

                  {job.status === 'failed' || job.status === 'canceled' ? (
                    <button
                      type="button"
                      onClick={() => retryJob(job.id)}
                      className="btn-outline px-3 py-2 text-sm"
                    >
                      Retry
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => removeJob(job.id)}
                    disabled={isBusy}
                    className="btn-outline px-3 py-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}

          {recentJobs.length === 0 && (
            <div className="p-8 text-center text-gray-500">No recent jobs yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}
