const QUEUE_GUARD_KEY = 'transcribe_queue_processing'

const LEAVE_QUEUE_MESSAGE =
  'A transcription queue is still running. Leaving this page will stop the remaining queued work. Leave anyway?'

export function setQueueNavigationGuardActive(active: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (active) {
      sessionStorage.setItem(QUEUE_GUARD_KEY, '1')
    } else {
      sessionStorage.removeItem(QUEUE_GUARD_KEY)
    }
  } catch {
    // Ignore storage errors
  }
}

export function isQueueNavigationGuardActive(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return sessionStorage.getItem(QUEUE_GUARD_KEY) === '1'
  } catch {
    return false
  }
}

export function confirmQueueNavigation(): boolean {
  if (!isQueueNavigationGuardActive()) return true
  if (typeof window === 'undefined') return true
  return window.confirm(LEAVE_QUEUE_MESSAGE)
}

export function guardedPush(
  router: { push: (href: string) => void },
  href: string,
): void {
  if (!confirmQueueNavigation()) return
  router.push(href)
}
