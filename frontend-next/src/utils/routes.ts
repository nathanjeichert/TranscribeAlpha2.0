const withTrailingSlash = (path: string) => (path.endsWith('/') ? path : `${path}/`)

export const normalizePathname = (pathname: string) => {
  if (!pathname || pathname === '/') return '/'
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

export const routes = {
  home: () => '/',
  jobs: () => withTrailingSlash('/jobs'),
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
  viewer: (mediaKey?: string, caseId?: string) => {
    const base = withTrailingSlash('/viewer')
    const params = new URLSearchParams()
    if (mediaKey) params.set('key', mediaKey)
    if (caseId) params.set('case', caseId)
    const query = params.toString()
    return query ? `${base}?${query}` : base
  },
  cases: () => withTrailingSlash('/cases'),
  casesTab: (tab: string) => `${withTrailingSlash('/cases')}?tab=${encodeURIComponent(tab)}`,
  caseDetailBase: () => withTrailingSlash('/case-detail'),
  caseDetail: (caseId: string) => `${withTrailingSlash('/case-detail')}?id=${encodeURIComponent(caseId)}`,
  settings: () => withTrailingSlash('/settings'),
  converter: () => withTrailingSlash('/converter'),
}
