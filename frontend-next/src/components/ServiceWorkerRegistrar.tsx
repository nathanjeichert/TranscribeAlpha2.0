'use client'

import { useEffect } from 'react'
import { logger } from '@/utils/logger'
import { isTauri } from '@/lib/platform'

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (isTauri()) return // No service worker in Tauri desktop mode
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        logger.warn('SW registration failed:', err)
      })
    }
  }, [])

  return null
}
