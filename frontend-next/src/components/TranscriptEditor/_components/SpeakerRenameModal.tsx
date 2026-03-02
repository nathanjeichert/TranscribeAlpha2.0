'use client'

import React from 'react'

interface SpeakerRenameModalProps {
  showRenameModal: boolean
  renameFrom: string
  renameTo: string
  renameFeedback: string | null
  hasLines: boolean
  setRenameFrom: (v: string) => void
  setRenameTo: (v: string) => void
  setRenameFeedback: (v: string | null) => void
  setShowRenameModal: (v: boolean) => void
  onRename: (event?: React.FormEvent) => void
}

export function SpeakerRenameModal({
  showRenameModal,
  renameFrom,
  renameTo,
  renameFeedback,
  hasLines,
  setRenameFrom,
  setRenameTo,
  setRenameFeedback,
  setShowRenameModal,
  onRename,
}: SpeakerRenameModalProps) {
  if (!showRenameModal) return null

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Rename Speakers</h3>
          <button
            type="button"
            className="rounded border border-gray-200 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
            onClick={() => setShowRenameModal(false)}
          >
            Close
          </button>
        </div>
        <form className="p-4 space-y-3" onSubmit={onRename}>
          {renameFeedback && (
            <div className="rounded bg-primary-50 px-3 py-2 text-sm text-primary-700">{renameFeedback}</div>
          )}
          <input
            type="text"
            value={renameFrom}
            onChange={(e) => {
              setRenameFrom(e.target.value.toUpperCase())
              if (renameFeedback) setRenameFeedback(null)
            }}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm uppercase"
            placeholder="Current name"
          />
          <input
            type="text"
            value={renameTo}
            onChange={(e) => {
              setRenameTo(e.target.value.toUpperCase())
              if (renameFeedback) setRenameFeedback(null)
            }}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm uppercase"
            placeholder="New name"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => setShowRenameModal(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700"
              disabled={!hasLines}
            >
              Rename All
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
