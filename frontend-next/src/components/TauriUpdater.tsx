'use client'

import { useEffect, useState } from 'react'
import { isTauri } from '@/lib/platform'

export default function TauriUpdater() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [version, setVersion] = useState('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false

    async function checkForUpdate() {
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (update && !cancelled) {
          setVersion(update.version)
          setUpdateAvailable(true)

          // Store install function for later
          ;(window as any).__tauriUpdate = update
        }
      } catch {
        // No update available or network error — silently ignore
      }
    }

    checkForUpdate()
    return () => { cancelled = true }
  }, [])

  if (!updateAvailable || dismissed) return null

  const handleInstall = async () => {
    setInstalling(true)
    setError('')
    try {
      const update = (window as any).__tauriUpdate
      if (update) {
        await update.downloadAndInstall()
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      }
    } catch (err: any) {
      setError(err?.message || 'Update failed')
      setInstalling(false)
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-4 max-w-sm">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
          <svg className="w-4 h-4 text-primary-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900">Update available</p>
          <p className="text-sm text-gray-500">Version {version} is ready to install.</p>
          {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleInstall}
              disabled={installing}
              className="px-3 py-1.5 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-500 transition-colors disabled:opacity-60"
            >
              {installing ? 'Installing...' : 'Install & Restart'}
            </button>
            <button
              onClick={() => setDismissed(true)}
              disabled={installing}
              className="px-3 py-1.5 text-gray-600 text-sm font-medium rounded-md hover:bg-gray-100 transition-colors"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
