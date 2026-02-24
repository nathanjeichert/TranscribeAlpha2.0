'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDashboard } from '@/context/DashboardContext'
import WorkspaceSetup from '@/components/WorkspaceSetup'
import {
  isWorkspaceConfigured,
  initWorkspaceDetailed,
  requestPersistentStorage,
  isPersistentStorage,
  setupMultiTabDetection,
} from '@/lib/storage'

export default function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const { refreshCases, refreshRecentTranscripts, jobs } = useDashboard()
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(true)
  const [showSetup, setShowSetup] = useState(false)
  const [multiTabWarning, setMultiTabWarning] = useState(false)
  const [needsReconnect, setNeedsReconnect] = useState(false)

  // Multi-tab detection.
  useEffect(() => {
    const cleanup = setupMultiTabDetection(() => setMultiTabWarning(true))
    return cleanup
  }, [])

  const checkWorkspace = useCallback(async () => {
    const configured = await isWorkspaceConfigured()
    if (!configured) {
      setShowSetup(true)
      setChecking(false)
      return
    }

    const result = await initWorkspaceDetailed()

    switch (result.status) {
      case 'ok': {
        setReady(true)
        setChecking(false)
        // Verify/re-request persistent storage silently
        const persisted = await isPersistentStorage()
        if (!persisted) await requestPersistentStorage()
        void Promise.allSettled([refreshCases(), refreshRecentTranscripts()])
        return
      }
      case 'permission-prompt':
      case 'permission-denied':
        // Handle needs user gesture — show reconnect UI, not full setup
        setNeedsReconnect(true)
        setChecking(false)
        return
      case 'no-handle':
      case 'error':
      default:
        setShowSetup(true)
        setChecking(false)
        return
    }
  }, [refreshCases, refreshRecentTranscripts])

  useEffect(() => {
    checkWorkspace()
  }, [checkWorkspace])

  const handleReconnect = useCallback(async () => {
    const result = await initWorkspaceDetailed()
    if (result.status === 'ok') {
      await requestPersistentStorage()
      setNeedsReconnect(false)
      setReady(true)
      void Promise.allSettled([refreshCases(), refreshRecentTranscripts()])
    }
    // If still not granted, the button stays visible for retry
  }, [refreshCases, refreshRecentTranscripts])

  const handleReconnectChooseNew = useCallback(() => {
    setNeedsReconnect(false)
    setShowSetup(true)
  }, [])

  const hasUnloadSensitiveJobs = useMemo(() => {
    return jobs.some((job) => job.unloadSensitive && job.status !== 'succeeded' && job.status !== 'failed' && job.status !== 'canceled')
  }, [jobs])

  useEffect(() => {
    if (!hasUnloadSensitiveJobs) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasUnloadSensitiveJobs])

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 relative">
            <div className="absolute inset-0 border-4 border-primary-200 rounded-full" />
            <div className="absolute inset-0 border-4 border-primary-600 rounded-full border-t-transparent animate-spin" />
          </div>
          <p className="text-gray-500">Connecting to workspace...</p>
        </div>
      </div>
    )
  }

  if (needsReconnect && !ready) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-16 h-16 mx-auto mb-6 bg-amber-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Workspace Disconnected</h2>
          <p className="text-gray-500 mb-6">
            Your workspace folder needs to be reconnected. This is a one-click browser permission &mdash; your data is still there.
          </p>
          <button
            onClick={handleReconnect}
            className="px-6 py-2.5 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-500 transition-colors"
          >
            Reconnect Workspace
          </button>
          <div className="mt-4">
            <button
              onClick={handleReconnectChooseNew}
              className="text-sm text-gray-500 hover:text-gray-700 underline"
            >
              Choose a different folder
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (showSetup && !ready) {
    return (
      <WorkspaceSetup
        onComplete={() => {
          setReady(true)
          setShowSetup(false)
          void Promise.allSettled([refreshCases(), refreshRecentTranscripts()])
        }}
      />
    )
  }

  return (
    <>
      {multiTabWarning && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-amber-950 text-center py-2 px-4 text-sm font-medium">
          TranscribeAlpha is open in another tab. Please close other tabs to avoid data conflicts.
          <button onClick={() => setMultiTabWarning(false)} className="ml-3 underline">Dismiss</button>
        </div>
      )}
      {children}
    </>
  )
}
