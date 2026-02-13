'use client'

import { useCallback, useEffect, useState } from 'react'
import { useDashboard } from '@/context/DashboardContext'
import { getWorkspaceName, getStorageEstimate, clearWorkspace, pickAndInitWorkspace, isPersistentStorage, requestPersistentStorage } from '@/lib/storage'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export default function SettingsPage() {
  const { appVariant, memoryLimitMB, setMemoryLimitMB } = useDashboard()

  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [storageEstimate, setStorageEstimate] = useState<{ fileCount: number; totalSize: number } | null>(null)
  const [changingWorkspace, setChangingWorkspace] = useState(false)
  const [persistentActive, setPersistentActive] = useState<boolean | null>(null)
  const [requestingPersistence, setRequestingPersistence] = useState(false)

  const loadWorkspaceInfo = useCallback(async () => {
    const name = getWorkspaceName()
    setWorkspaceName(name)
    try {
      const estimate = await getStorageEstimate()
      setStorageEstimate(estimate)
    } catch {
      // Workspace may not be accessible
    }
    try {
      const persisted = await isPersistentStorage()
      setPersistentActive(persisted)
    } catch {
      // Storage API may not be available
    }
  }, [])

  useEffect(() => {
    loadWorkspaceInfo()
  }, [loadWorkspaceInfo])

  const handleChangeWorkspace = async () => {
    setChangingWorkspace(true)
    try {
      await clearWorkspace()
      await pickAndInitWorkspace()
      await loadWorkspaceInfo()
    } catch {
      // User cancelled picker
    } finally {
      setChangingWorkspace(false)
    }
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1">Configure your TranscribeAlpha preferences</p>
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Application</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-medium text-gray-900">App Variant</p>
                <p className="text-sm text-gray-500">Primary export emphasis</p>
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

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Workspace Storage</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-medium text-gray-900">Workspace Folder</p>
                <p className="text-sm text-gray-500">
                  {workspaceName || 'Not configured'}
                </p>
              </div>
              <button
                onClick={handleChangeWorkspace}
                disabled={changingWorkspace}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                {changingWorkspace ? 'Changing...' : 'Change Workspace'}
              </button>
            </div>
            <div className="py-3 border-b border-gray-100">
              <p className="font-medium text-gray-900 mb-1">Storage Usage</p>
              {storageEstimate ? (
                <p className="text-sm text-gray-500">
                  {storageEstimate.fileCount} files &middot; {formatBytes(storageEstimate.totalSize)}
                </p>
              ) : (
                <p className="text-sm text-gray-500">Calculating...</p>
              )}
            </div>
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div>
                <p className="font-medium text-gray-900 mb-1">Persistent Storage</p>
                {persistentActive === null ? (
                  <p className="text-sm text-gray-500">Checking...</p>
                ) : persistentActive ? (
                  <p className="text-sm text-green-600">Active &mdash; browser will not evict your workspace data</p>
                ) : (
                  <p className="text-sm text-amber-600">Not active &mdash; browser may clear stored data under storage pressure</p>
                )}
              </div>
              {persistentActive === false && (
                <button
                  onClick={async () => {
                    setRequestingPersistence(true)
                    try {
                      const granted = await requestPersistentStorage()
                      setPersistentActive(granted)
                    } finally {
                      setRequestingPersistence(false)
                    }
                  }}
                  disabled={requestingPersistence}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium text-sm rounded-lg transition-colors disabled:opacity-50"
                >
                  {requestingPersistence ? 'Requesting...' : 'Request Persistence'}
                </button>
              )}
            </div>
            <div className="py-3">
              <p className="font-medium text-gray-900 mb-1">Data Architecture</p>
              <p className="text-sm text-gray-500">
                Cases, transcripts, and media links are stored locally in your workspace with IndexedDB support for media handles.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Performance</h2>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-gray-900">Memory Limit</p>
                <span className="text-sm font-semibold text-gray-700">{memoryLimitMB} MB</span>
              </div>
              <input
                type="range"
                min={256}
                max={4096}
                step={256}
                value={memoryLimitMB}
                onChange={(event) => setMemoryLimitMB(Number(event.target.value))}
                className="w-full accent-primary-600"
              />
              <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                <span>256 MB</span>
                <span>4096 MB</span>
              </div>
            </div>
            <p className="text-sm text-gray-600">
              Higher values allow more parallel processing for faster batch transcription. Lower values reduce memory pressure on devices with limited RAM.
            </p>
            <p className="text-xs text-amber-700">
              Warning: setting this too high may crash the browser, especially when other apps are running.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Export Formats</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <span className="text-blue-600 font-bold text-sm">PDF</span>
                </div>
                <p className="font-medium text-gray-900">Transcript PDF</p>
              </div>
              <p className="text-sm text-gray-500">
                Canonical transcript layout for printing and page/line references
              </p>
            </div>
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
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Editor Keyboard Shortcuts</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600">Save transcript</span>
              <kbd className="px-2 py-1 bg-gray-100 rounded text-sm font-mono text-gray-700">Ctrl/Cmd+S</kbd>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600">Play/pause media (outside text fields)</span>
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
