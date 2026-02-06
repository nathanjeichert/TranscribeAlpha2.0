'use client'

import { useCallback, useEffect, useState } from 'react'
import { DashboardProvider, useDashboard } from '@/context/DashboardContext'
import Sidebar from '@/components/layout/Sidebar'
import WorkspaceSetup from '@/components/WorkspaceSetup'
import { isWorkspaceConfigured, initWorkspace } from '@/lib/storage'
import { confirmQueueNavigation, isQueueNavigationGuardActive } from '@/utils/navigationGuard'

const SIDEBAR_COLLAPSED_KEY = 'dashboard_sidebar_collapsed'

function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const { appVariant } = useDashboard()
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(true)
  const [showSetup, setShowSetup] = useState(false)

  const checkWorkspace = useCallback(async () => {
    if (appVariant !== 'criminal') {
      setReady(true)
      setChecking(false)
      return
    }

    const configured = await isWorkspaceConfigured()
    if (configured) {
      const handle = await initWorkspace()
      if (handle) {
        setReady(true)
        setChecking(false)
        return
      }
    }
    setShowSetup(true)
    setChecking(false)
  }, [appVariant])

  useEffect(() => {
    checkWorkspace()
  }, [checkWorkspace])

  if (appVariant !== 'criminal') return <>{children}</>

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
        }}
      />
    )
  }

  return <>{children}</>
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

  useEffect(() => {
    const handleLinkNavigation = (event: MouseEvent) => {
      if (!isQueueNavigationGuardActive()) return
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const target = event.target as Element | null
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return

      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return

      let destination: URL
      try {
        destination = new URL(anchor.href, window.location.href)
      } catch {
        return
      }

      if (destination.origin !== window.location.origin) return

      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
      const nextPath = `${destination.pathname}${destination.search}${destination.hash}`
      if (currentPath === nextPath) return

      if (!confirmQueueNavigation()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    document.addEventListener('click', handleLinkNavigation, true)
    return () => {
      document.removeEventListener('click', handleLinkNavigation, true)
    }
  }, [])

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
      </WorkspaceGate>
    </DashboardProvider>
  )
}
