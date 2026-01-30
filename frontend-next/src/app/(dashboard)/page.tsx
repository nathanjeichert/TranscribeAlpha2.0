'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useDashboard } from '@/context/DashboardContext'
import { routes } from '@/utils/routes'

export default function DashboardHome() {
  const router = useRouter()
  const { cases, recentTranscripts, setActiveMediaKey } = useDashboard()

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Quick Start Hero */}
      <div className="bg-gradient-to-br from-primary-600 to-primary-700 rounded-2xl p-10 mb-8 text-white">
        <h1 className="text-3xl font-semibold mb-3">Welcome to TranscribeAlpha</h1>
        <p className="text-primary-100 mb-8 text-lg">
          Generate professional legal transcripts from audio and video files
        </p>
        <Link
          href={routes.transcribe()}
          className="inline-flex items-center gap-3 bg-white text-primary-700 px-8 py-4 rounded-xl font-semibold text-lg hover:bg-primary-50 transition-colors shadow-lg"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M12 4v16m8-8H4" />
          </svg>
          New Transcript
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Transcripts */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-5 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900">Recent Transcripts</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {recentTranscripts.length === 0 ? (
              <div className="p-8 text-center">
                <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="text-gray-500 mb-4">No transcripts yet</p>
                <Link href={routes.transcribe()} className="text-primary-600 hover:text-primary-700 font-medium text-sm">
                  Create your first transcript →
                </Link>
              </div>
            ) : (
              recentTranscripts.map((transcript) => (
                <button
                  key={transcript.media_key}
                  onClick={() => {
                    setActiveMediaKey(transcript.media_key)
                    router.push(routes.editor(transcript.media_key))
                  }}
                  className="w-full p-4 text-left hover:bg-gray-50 transition-colors flex items-center gap-4"
                >
                  <div className="w-10 h-10 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{transcript.title_label}</p>
                    <p className="text-sm text-gray-500">
                      {transcript.line_count ? `${transcript.line_count} lines` : 'Processing...'}
                    </p>
                  </div>
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))
            )}
          </div>
          {recentTranscripts.length > 0 && (
            <div className="p-4 border-t border-gray-100">
              <Link href={routes.cases()} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                View all transcripts →
              </Link>
            </div>
          )}
        </div>

        {/* Cases */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-5 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Your Cases</h2>
            <Link
              href={routes.cases()}
              className="text-sm text-primary-600 hover:text-primary-700 font-medium"
            >
              Manage
            </Link>
          </div>
          <div className="divide-y divide-gray-100">
            {cases.length === 0 ? (
              <div className="p-8 text-center">
                <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <p className="text-gray-500 mb-4">No cases yet</p>
                <Link href={routes.cases()} className="text-primary-600 hover:text-primary-700 font-medium text-sm">
                  Create a case to organize transcripts →
                </Link>
              </div>
            ) : (
              cases.slice(0, 5).map((caseItem) => (
                <Link
                  key={caseItem.case_id}
                  href={routes.caseDetail(caseItem.case_id)}
                  className="p-4 hover:bg-gray-50 transition-colors flex items-center gap-4"
                >
                  <div className="w-10 h-10 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-semibold text-primary-700">{caseItem.transcript_count}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{caseItem.name}</p>
                    <p className="text-sm text-gray-500">
                      {caseItem.transcript_count} transcript{caseItem.transcript_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          href={routes.transcribe()}
          className="bg-white rounded-xl p-5 border border-gray-100 hover:border-primary-200 hover:shadow-md transition-all flex items-center gap-4"
        >
          <div className="w-12 h-12 bg-primary-100 rounded-xl flex items-center justify-center">
            <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-900">Transcribe</p>
            <p className="text-sm text-gray-500">Upload audio/video</p>
          </div>
        </Link>

        <Link
          href={routes.editor()}
          className="bg-white rounded-xl p-5 border border-gray-100 hover:border-primary-200 hover:shadow-md transition-all flex items-center gap-4"
        >
          <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-900">Editor</p>
            <p className="text-sm text-gray-500">Edit & sync timing</p>
          </div>
        </Link>

        <Link
          href={routes.clipCreator()}
          className="bg-white rounded-xl p-5 border border-gray-100 hover:border-primary-200 hover:shadow-md transition-all flex items-center gap-4"
        >
          <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
            <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-900">Clip Creator</p>
            <p className="text-sm text-gray-500">Extract video clips</p>
          </div>
        </Link>
      </div>
    </div>
  )
}
