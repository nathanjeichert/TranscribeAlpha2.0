const withTrailingSlash = (path: string) => (path.endsWith('/') ? path : `${path}/`)

export const normalizePathname = (pathname: string) => {
  if (!pathname || pathname === '/') return '/'
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

export const routes = {
  home: () => '/',
  transcribe: (caseId?: string) => {
    const base = withTrailingSlash('/transcribe')
    if (!caseId) return base
    return `${base}?case_id=${encodeURIComponent(caseId)}`
  },
  editor: (mediaKey?: string) => {
    const base = withTrailingSlash('/editor')
    if (!mediaKey) return base
    return `${base}?key=${encodeURIComponent(mediaKey)}`
  },
  clipCreator: (mediaKey?: string) => {
    const base = withTrailingSlash('/clip-creator')
    if (!mediaKey) return base
    return `${base}?key=${encodeURIComponent(mediaKey)}`
  },
  cases: () => withTrailingSlash('/cases'),
  casesTab: (tab: string) => `${withTrailingSlash('/cases')}?tab=${encodeURIComponent(tab)}`,
  caseDetailBase: () => withTrailingSlash('/case-detail'),
  caseDetail: (caseId: string) => `${withTrailingSlash('/case-detail')}?id=${encodeURIComponent(caseId)}`,
  settings: () => withTrailingSlash('/settings'),
}
