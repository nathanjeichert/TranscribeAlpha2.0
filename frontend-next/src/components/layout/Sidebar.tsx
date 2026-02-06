'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useDashboard } from '@/context/DashboardContext'
import { normalizePathname, routes } from '@/utils/routes'

interface NavItemProps {
  href: string
  icon: React.ReactNode
  label: string
  active?: boolean
  collapsed?: boolean
  title?: string
}

function NavItem({ href, icon, label, active, collapsed, title }: NavItemProps) {
  return (
    <Link
      href={href}
      title={collapsed ? (title ?? label) : undefined}
      className={`flex items-center rounded-lg text-sm font-medium transition-colors ${
        collapsed ? 'justify-center px-2 py-3' : 'gap-3 px-4 py-3'
      } ${
        active
          ? 'bg-primary-700 text-white'
          : 'text-primary-300 hover:bg-primary-800 hover:text-white'
      }`}
    >
      <span className="w-5 h-5 flex items-center justify-center opacity-80">{icon}</span>
      {!collapsed && <span>{label}</span>}
    </Link>
  )
}

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const router = useRouter()
  const rawPathname = usePathname()
  const searchParams = useSearchParams()
  const pathname = normalizePathname(rawPathname)
  const { cases, uncategorizedCount, recentTranscripts, setActiveMediaKey } = useDashboard()

  const isActive = (path: string) => {
    if (path === '/') return pathname === '/'
    return pathname.startsWith(path)
  }
  const activeCaseId = searchParams.get('id')
  const isCaseDetail = pathname === routes.caseDetailBase()
  const isCasesRoute = isActive(routes.cases()) || isCaseDetail

  return (
    <aside className={`bg-primary-900 text-white flex flex-col h-screen sticky top-0 transition-all duration-200 ${collapsed ? 'w-20' : 'w-72'}`}>
      <div className="p-4 border-b border-primary-700">
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} gap-2`}>
          <Link href={routes.home()} className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'} min-w-0`}>
            <div className="w-9 h-9 bg-gradient-to-br from-primary-600 to-primary-500 rounded-lg flex items-center justify-center font-semibold text-lg">
              T
            </div>
            {!collapsed && <span className="text-xl font-light truncate">TranscribeAlpha</span>}
          </Link>
          {!collapsed && (
            <button
              type="button"
              onClick={onToggle}
              className="p-2 rounded-lg text-primary-300 hover:text-white hover:bg-primary-800 transition-colors"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
        </div>
        {collapsed && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={onToggle}
              className="p-2 rounded-lg text-primary-300 hover:text-white hover:bg-primary-800 transition-colors"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <nav className={`flex-1 space-y-1 overflow-y-auto ${collapsed ? 'p-3' : 'p-4'}`}>
        <NavItem
          href={routes.home()}
          active={isActive(routes.home()) && pathname === routes.home()}
          collapsed={collapsed}
          icon={
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
              <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          }
          label="Dashboard"
        />

        <NavItem
          href={routes.transcribe()}
          active={isActive(routes.transcribe())}
          collapsed={collapsed}
          icon={
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
              <path d="M7 3h7l5 5v13a1 1 0 01-1 1H7a2 2 0 01-2-2V5a2 2 0 012-2z" />
              <path d="M14 3v5h5" />
              <path d="M8.5 15.5c.6-1 1.2-1 1.8 0 .6 1 1.2 1 1.8 0 .6-1 1.2-1 1.8 0 .6 1 1.2 1 1.8 0" />
            </svg>
          }
          label="New Transcript"
        />

        <NavItem
          href={routes.editor()}
          active={isActive(routes.editor())}
          collapsed={collapsed}
          icon={
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
              <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          }
          label="Editor"
        />

        <NavItem
          href={routes.clipCreator()}
          active={isActive(routes.clipCreator())}
          collapsed={collapsed}
          icon={
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
              <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          }
          label="Clip Creator"
        />

        <NavItem
          href={routes.cases()}
          active={isCasesRoute}
          collapsed={collapsed}
          icon={
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          }
          label="Cases"
        />

        {!collapsed && (
          <>
            <div className="pt-6">
              <div className="flex items-center justify-between px-4 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-primary-400">
                  Cases
                </span>
                <Link
                  href={routes.cases()}
                  className="text-xs text-primary-400 hover:text-white transition-colors"
                >
                  View All
                </Link>
              </div>

              <div className="space-y-0.5">
                {cases.slice(0, 5).map((caseItem) => (
                  <Link
                    key={caseItem.case_id}
                    href={routes.caseDetail(caseItem.case_id)}
                    className={`flex items-center gap-3 px-4 py-2 rounded-lg text-sm transition-colors ${
                      (isCaseDetail && activeCaseId === caseItem.case_id)
                        ? 'bg-primary-700 text-white'
                        : 'text-primary-300 hover:bg-primary-800 hover:text-white'
                    }`}
                  >
                    <span className="w-7 h-7 bg-primary-700 rounded flex items-center justify-center text-xs">
                      {caseItem.transcript_count}
                    </span>
                    <span className="truncate flex-1">{caseItem.name}</span>
                  </Link>
                ))}

                {uncategorizedCount > 0 && (
                  <Link
                    href={routes.casesTab('uncategorized')}
                    className="flex items-center gap-3 px-4 py-2 rounded-lg text-sm text-primary-400 hover:bg-primary-800 hover:text-white transition-colors"
                  >
                    <span className="w-7 h-7 bg-primary-800 rounded flex items-center justify-center text-xs">
                      {uncategorizedCount}
                    </span>
                    <span className="truncate flex-1">Uncategorized</span>
                  </Link>
                )}

                {cases.length === 0 && uncategorizedCount === 0 && (
                  <div className="px-4 py-2 text-sm text-primary-500">
                    No cases yet
                  </div>
                )}
              </div>
            </div>

            <div className="pt-6">
              <div className="px-4 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-primary-400">
                  Recent
                </span>
              </div>

              <div className="space-y-0.5">
                {recentTranscripts.map((transcript) => (
                  <button
                    key={transcript.media_key}
                    onClick={() => {
                      setActiveMediaKey(transcript.media_key)
                      router.push(routes.editor(transcript.media_key))
                    }}
                    className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-sm text-left text-primary-300 hover:bg-primary-800 hover:text-white transition-colors"
                  >
                    <span className="text-primary-500">
                      <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-4 h-4">
                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </span>
                    <span className="truncate flex-1">{transcript.title_label}</span>
                  </button>
                ))}

                {recentTranscripts.length === 0 && (
                  <div className="px-4 py-2 text-sm text-primary-500">
                    No recent transcripts
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </nav>

      <div className={`border-t border-primary-700 ${collapsed ? 'p-3' : 'p-4'}`}>
        <NavItem
          href={routes.settings()}
          active={isActive(routes.settings())}
          collapsed={collapsed}
          icon={
            <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-5 h-5">
              <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          }
          label="Settings"
        />
      </div>
    </aside>
  )
}
