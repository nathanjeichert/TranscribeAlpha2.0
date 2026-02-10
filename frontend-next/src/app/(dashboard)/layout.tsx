'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DashboardProvider, useDashboard } from '@/context/DashboardContext'
import Sidebar from '@/components/layout/Sidebar'
import WorkspaceSetup from '@/components/WorkspaceSetup'
import { isWorkspaceConfigured, initWorkspace, setupMultiTabDetection } from '@/lib/storage'

const SIDEBAR_COLLAPSED_KEY = 'dashboard_sidebar_collapsed'

function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const { variantResolved, refreshCases, refreshRecentTranscripts, jobs } = useDashboard()
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(true)
  const [showSetup, setShowSetup] = useState(false)
  const [multiTabWarning, setMultiTabWarning] = useState(false)

  // Multi-tab detection for all variants.
  useEffect(() => {
    if (!variantResolved) return
    const cleanup = setupMultiTabDetection(() => setMultiTabWarning(true))
    return cleanup
  }, [variantResolved])

  const checkWorkspace = useCallback(async () => {
    if (!variantResolved) return

    const configured = await isWorkspaceConfigured()
    if (configured) {
      const handle = await initWorkspace()
      if (handle) {
        setReady(true)
        setChecking(false)
        void Promise.allSettled([refreshCases(), refreshRecentTranscripts()])
        return
      }
    }
    setShowSetup(true)
    setChecking(false)
  }, [refreshCases, refreshRecentTranscripts, variantResolved])

  useEffect(() => {
    checkWorkspace()
  }, [checkWorkspace])

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

  if (!variantResolved) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 relative">
            <div className="absolute inset-0 border-4 border-primary-200 rounded-full" />
            <div className="absolute inset-0 border-4 border-primary-600 rounded-full border-t-transparent animate-spin" />
          </div>
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    )
  }

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

function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem('pwa_install_dismissed') === 'true') {
        setDismissed(true)
      }
    } catch {}

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (!deferredPrompt || dismissed) return null

  return (
    <div className="fixed bottom-4 right-4 z-40 bg-white border border-gray-200 rounded-xl shadow-lg p-4 max-w-sm">
      <p className="text-sm font-medium text-gray-900 mb-1">Install TranscribeAlpha</p>
      <p className="text-xs text-gray-500 mb-3">Install for the best experience: faster loading, offline access, and reliable file permissions.</p>
      <div className="flex gap-2">
        <button
          onClick={async () => {
            deferredPrompt.prompt()
            await deferredPrompt.userChoice
            setDeferredPrompt(null)
          }}
          className="px-3 py-1.5 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-500"
        >
          Install
        </button>
        <button
          onClick={() => {
            setDismissed(true)
            try { localStorage.setItem('pwa_install_dismissed', 'true') } catch {}
          }}
          className="px-3 py-1.5 text-gray-500 text-sm hover:text-gray-700"
        >
          Not now
        </button>
      </div>
    </div>
  )
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
      if (stored === 'true') {
        setSidebarCollapsed(true)
      }
    } catch {
      // Ignore localStorage failures
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? 'true' : 'false')
    } catch {
      // Ignore localStorage failures
    }
  }, [sidebarCollapsed])

  return (
    <DashboardProvider>
      <WorkspaceGate>
        <div className="flex min-h-screen bg-gray-50">
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((prev) => !prev)}
          />
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
        <PWAInstallPrompt />
      </WorkspaceGate>
    </DashboardProvider>
  )
}
