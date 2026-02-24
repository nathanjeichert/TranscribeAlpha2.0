'use client'

import { useEffect, useState } from 'react'
import { isTauri } from '@/lib/platform'

export default function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [dismissed, setDismissed] = useState(false)
  const inTauri = isTauri()

  useEffect(() => {
    if (inTauri) return // No PWA install in native desktop mode
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

  if (inTauri || !deferredPrompt || dismissed) return null

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
