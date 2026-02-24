'use client'

import { useEffect } from 'react'
import { logger } from '@/utils/logger'

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        logger.warn('SW registration failed:', err)
      })
    }
  }, [])

  return null
}
