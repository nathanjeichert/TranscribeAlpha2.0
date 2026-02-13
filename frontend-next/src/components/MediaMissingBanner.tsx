'use client'

interface MediaMissingBannerProps {
  mediaKey: string
  mediaFilename?: string
  message?: string
  actionLabel?: string
  onReimport: () => void
}

export default function MediaMissingBanner({
  mediaKey,
  mediaFilename,
  message,
  actionLabel,
  onReimport,
}: MediaMissingBannerProps) {
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-6 py-3">
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <p className="font-medium text-amber-800">
              Media file not found
            </p>
            <p className="text-sm text-amber-600">
              {message || `${mediaFilename || 'The media file'} is not linked. Locate the file on your computer to enable playback.`}
            </p>
          </div>
        </div>
        <button
          onClick={onReimport}
          className="px-4 py-2 bg-amber-100 hover:bg-amber-200 text-amber-800 font-medium text-sm rounded-lg transition-colors"
        >
          {actionLabel || 'Locate File'}
        </button>
      </div>
    </div>
  )
}
