'use client'

import React from 'react'

interface EditorToolbarProps {
  // Left: undo/redo/add/delete
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onAddLine: () => void
  onDeleteLine: () => void
  // Right: view/export/settings/save
  saving: boolean
  canSave: boolean
  hasSessionMeta: boolean
  hasActiveMediaKey: boolean
  oncueXmlEnabled: boolean
  isResyncing: boolean
  hasResolvedMediaUrl: boolean
  isGeminiBusy?: boolean
  onOpenViewer?: () => void
  onDownloadPdf: () => void
  onDownloadViewer: () => void
  onDownloadXml: () => void
  onShowSettings: () => void
  showSettings: boolean
  onOpenHistory?: () => void
  onShowRenameModal: () => void
  onResync: () => void
  onGeminiRefine?: () => void
  onSave: () => void
  // Settings panel (rendered inline when showSettings)
  autoScroll: boolean
  onAutoScrollChange: (v: boolean) => void
  autoShiftNextLine: boolean
  onAutoShiftChange: (v: boolean) => void
}

export function EditorToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAddLine,
  onDeleteLine,
  saving,
  canSave,
  hasSessionMeta,
  hasActiveMediaKey,
  oncueXmlEnabled,
  isResyncing,
  hasResolvedMediaUrl,
  isGeminiBusy,
  onOpenViewer,
  onDownloadPdf,
  onDownloadViewer,
  onDownloadXml,
  onShowSettings,
  showSettings,
  onOpenHistory,
  onShowRenameModal,
  onResync,
  onGeminiRefine,
  onSave,
  autoScroll,
  onAutoScrollChange,
  autoShiftNextLine,
  onAutoShiftChange,
}: EditorToolbarProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 p-4 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <button
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-600 disabled:opacity-40"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 10h10a5 5 0 015 5v2M3 10l6-6M3 10l6 6" />
            </svg>
          </button>
          <button
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-600 disabled:opacity-40"
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M21 10h-10a5 5 0 00-5 5v2M21 10l-6-6M21 10l-6 6" />
            </svg>
          </button>
          <div className="w-px h-6 bg-gray-200" />
          <button
            className="px-3 py-1.5 rounded-lg bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium"
            onClick={onAddLine}
            title="Add new line after selection"
          >
            + Add Line
          </button>
          <button
            className="px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-sm font-medium"
            onClick={onDeleteLine}
            title="Delete selected line"
          >
            Delete Line
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {onOpenViewer && (
            <button
              className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium inline-flex items-center gap-1.5"
              onClick={onOpenViewer}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              View in Viewer
            </button>
          )}
          <button
            className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
            onClick={onDownloadPdf}
            disabled={saving || !hasSessionMeta || !hasActiveMediaKey}
          >
            Export PDF
          </button>
          <button
            className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
            onClick={onDownloadViewer}
            disabled={!hasActiveMediaKey}
          >
            Export Player
          </button>
          {oncueXmlEnabled && (
            <button
              className="px-3 py-1.5 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm font-medium disabled:opacity-40"
              onClick={onDownloadXml}
              disabled={!hasActiveMediaKey}
            >
              Export XML
            </button>
          )}
          <button
            className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium flex items-center gap-2"
            onClick={onShowSettings}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Settings
          </button>
          {onOpenHistory && (
            <button
              className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium"
              onClick={onOpenHistory}
            >
              Edit History
            </button>
          )}
          <button
            className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium"
            onClick={onShowRenameModal}
          >
            Rename Speakers
          </button>
          <button
            className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-sm font-medium disabled:opacity-50"
            onClick={onResync}
            disabled={isResyncing || !hasResolvedMediaUrl}
            title="Re-align timestamps to audio"
          >
            {isResyncing ? 'Fixing...' : 'Fix Timing to Audio'}
          </button>
          {onGeminiRefine && (
            <button
              className="px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 text-sm font-medium disabled:opacity-50"
              onClick={onGeminiRefine}
              disabled={isGeminiBusy}
            >
              {isGeminiBusy ? 'Running...' : 'Clean Wording (AI)'}
            </button>
          )}
          <button
            className="px-4 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium disabled:opacity-50"
            onClick={onSave}
            disabled={saving || !hasSessionMeta || !canSave}
          >
            {saving ? 'Saving...' : canSave ? 'Save Changes' : 'Saved'}
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-gray-300"
              checked={autoScroll}
              onChange={(event) => onAutoScrollChange(event.target.checked)}
            />
            Auto-scroll to current line
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer" title="When changing end time, adjust next line's start">
            <input
              type="checkbox"
              className="rounded border-gray-300"
              checked={autoShiftNextLine}
              onChange={(event) => onAutoShiftChange(event.target.checked)}
            />
            Auto-shift next line timing
          </label>
        </div>
      )}
    </>
  )
}
