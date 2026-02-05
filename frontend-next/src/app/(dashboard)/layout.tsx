'use client'

import { useEffect, useState } from 'react'
import { DashboardProvider } from '@/context/DashboardContext'
import Sidebar from '@/components/layout/Sidebar'

const SIDEBAR_COLLAPSED_KEY = 'dashboard_sidebar_collapsed'

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
      <div className="flex min-h-screen bg-gray-50">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((prev) => !prev)}
        />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </DashboardProvider>
  )
}
