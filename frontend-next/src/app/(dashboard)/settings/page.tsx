'use client'

import { useDashboard } from '@/context/DashboardContext'

export default function SettingsPage() {
  const { appVariant } = useDashboard()

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1">Configure your TranscribeAlpha preferences</p>
      </div>

      <div className="space-y-6">
        {/* App Info */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Application</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-medium text-gray-900">App Variant</p>
                <p className="text-sm text-gray-500">Current application mode</p>
              </div>
              <span className="px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm font-medium capitalize">
                {appVariant}
              </span>
            </div>
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-medium text-gray-900">Version</p>
                <p className="text-sm text-gray-500">TranscribeAlpha version</p>
              </div>
              <span className="text-gray-600">2.0.0</span>
            </div>
          </div>
        </div>

        {/* Storage Info */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Storage</h2>
          <div className="space-y-4">
            <div className="py-3 border-b border-gray-100">
              <p className="font-medium text-gray-900 mb-1">Transcript Storage</p>
              <p className="text-sm text-gray-500">
                Transcripts assigned to cases are stored permanently. Uncategorized transcripts expire after 30 days.
              </p>
            </div>
            <div className="py-3">
              <p className="font-medium text-gray-900 mb-1">Media Files</p>
              <p className="text-sm text-gray-500">
                Media files are stored temporarily and may expire. You can re-import media files at any time to restore playback.
              </p>
            </div>
          </div>
        </div>

        {/* Export Options */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Export Formats</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <span className="text-blue-600 font-bold text-sm">DOCX</span>
                </div>
                <p className="font-medium text-gray-900">Word Document</p>
              </div>
              <p className="text-sm text-gray-500">
                Standard document format for editing and printing
              </p>
            </div>
            {appVariant === 'oncue' ? (
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                    <span className="text-green-600 font-bold text-sm">XML</span>
                  </div>
                  <p className="font-medium text-gray-900">OnCue XML</p>
                </div>
                <p className="text-sm text-gray-500">
                  Compatible with OnCue trial presentation software
                </p>
              </div>
            ) : (
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                    <span className="text-purple-600 font-bold text-sm">HTML</span>
                  </div>
                  <p className="font-medium text-gray-900">HTML Viewer</p>
                </div>
                <p className="text-sm text-gray-500">
                  Interactive web-based transcript viewer
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Keyboard Shortcuts */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Editor Keyboard Shortcuts</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600">Save transcript</span>
              <kbd className="px-2 py-1 bg-gray-100 rounded text-sm font-mono text-gray-700">Ctrl+S</kbd>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600">Play/Pause media</span>
              <kbd className="px-2 py-1 bg-gray-100 rounded text-sm font-mono text-gray-700">Space</kbd>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600">Skip backward 5s</span>
              <kbd className="px-2 py-1 bg-gray-100 rounded text-sm font-mono text-gray-700">Left</kbd>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600">Skip forward 5s</span>
              <kbd className="px-2 py-1 bg-gray-100 rounded text-sm font-mono text-gray-700">Right</kbd>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
